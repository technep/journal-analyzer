import { chromium } from '@playwright/test'
import { createServer } from 'node:http'
import { createReadStream, existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'

const root = path.dirname(fileURLToPath(import.meta.url))
const project = path.resolve(root, '..')
const outputPath = path.join(root, 'benchmark-results.json')
const runs = Number(process.env.BENCH_RUNS || 5)
const corpora = (process.env.BENCH_CORPORA || 'benchmark.journal,benchmark.zip').split(',')
const targets = (process.env.BENCH_TARGETS || 'baseline,js,wasm').split(',')
const caches = (process.env.BENCH_CACHES || 'cold,warm').split(',')
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
  || (existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined)
const roots = {
  baseline: process.env.BENCH_BASELINE_DIR
    ? path.resolve(process.env.BENCH_BASELINE_DIR)
    : path.join(root, 'baseline-dist'),
  js: path.join(project, 'dist'),
  wasm: path.join(project, 'dist'),
}
const mime = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
  '.json': 'application/json', '.woff': 'font/woff', '.woff2': 'font/woff2',
}

function serve(directory) {
  const state = { requests: 0, server: null }
  state.server = createServer((request, response) => {
    state.requests++
    const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname)
    let filename = path.resolve(directory, `.${pathname === '/' ? '/index.html' : pathname}`)
    if (!filename.startsWith(path.resolve(directory))) {
      response.writeHead(403).end()
      return
    }
    if (!existsSync(filename) || statSync(filename).isDirectory()) filename = path.join(directory, 'index.html')
    response.setHeader('Content-Type', mime[path.extname(filename)] || 'application/octet-stream')
    response.setHeader('Cache-Control', filename.endsWith('index.html') ? 'no-cache' : 'public, max-age=3600')
    createReadStream(filename).pipe(response)
  })
  return state
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)))
}

function processTreeRss(rootPid) {
  if (!rootPid) return 0
  let processes
  try {
    processes = readdirSync('/proc').filter((name) => /^\d+$/.test(name)).map((name) => {
      try {
        const status = readFileSync(`/proc/${name}/status`, 'utf8')
        return {
          pid: Number(name),
          ppid: Number(status.match(/^PPid:\s+(\d+)$/m)?.[1] || 0),
          rss: Number(status.match(/^VmRSS:\s+(\d+)\s+kB$/m)?.[1] || 0) * 1024,
        }
      } catch { return null }
    }).filter(Boolean)
  } catch { return 0 }
  const included = new Set([rootPid])
  let changed = true
  while (changed) {
    changed = false
    for (const process of processes) {
      if (!included.has(process.pid) && included.has(process.ppid)) {
        included.add(process.pid)
        changed = true
      }
    }
  }
  return processes.reduce((sum, process) => sum + (included.has(process.pid) ? process.rss : 0), 0)
}

async function sampled(pid, operation) {
  const baselineRss = processTreeRss(pid)
  let peakRssBytes = baselineRss
  const timer = setInterval(() => {
    peakRssBytes = Math.max(peakRssBytes, processTreeRss(pid))
  }, 50)
  try {
    const value = await operation()
    await new Promise((resolve) => setTimeout(resolve, 120))
    peakRssBytes = Math.max(peakRssBytes, processTreeRss(pid))
    return {
      ...value,
      baselineRssBytes: baselineRss,
      peakRssBytes,
      peakRssDeltaBytes: Math.max(0, peakRssBytes - baselineRss),
    }
  } finally {
    clearInterval(timer)
  }
}

async function installObserver(page) {
  await page.addInitScript(() => {
    const state = {
      uploadStarted: null, filterStarted: null, longTasks: [], filterLongStart: 0,
    }
    window.__benchState = state
    if (typeof PerformanceObserver !== 'undefined' && PerformanceObserver.supportedEntryTypes.includes('longtask')) {
      const observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          state.longTasks.push({ startTime: entry.startTime, duration: entry.duration })
        }
      })
      observer.observe({ entryTypes: ['longtask'] })
    }
    document.addEventListener('change', (event) => {
      if (event.target instanceof HTMLInputElement && event.target.type === 'file') {
        state.uploadStarted = performance.now()
      }
    }, true)
    document.addEventListener('input', (event) => {
      if (event.target instanceof HTMLInputElement && event.target.placeholder.startsWith('regex,')) {
        state.filterStarted = performance.now()
        state.filterLongStart = state.longTasks.length
      }
    }, true)
  })
}

async function waitReady(page, target, total) {
  await page.waitForFunction(({ target, total }) => {
    if (target !== 'baseline') {
      const app = window.__journalAnalyzer
      return app?.ready && app.recordsCount === total && app.visibleCount > 0
    }
    return document.querySelectorAll('tbody tr').length > 0
      && document.body.textContent.includes(`${total.toLocaleString()} entries`)
  }, { target, total }, { timeout: 120_000 })
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
}

async function waitFilter(page, target, filtered) {
  await page.waitForFunction(({ target, filtered }) => {
    if (target !== 'baseline') {
      const app = window.__journalAnalyzer
      return app?.ready && app.filteredCount === filtered && app.visibleCount > 0
    }
    const expected = `${filtered.toLocaleString()} / 100,000 entries`
    return [...document.querySelectorAll('span')].some((node) => node.textContent.trim() === expected)
      && document.querySelectorAll('tbody tr').length > 0
  }, { target, filtered }, { timeout: 120_000 })
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
}

async function oneRun(target, corpus, cache, iteration) {
  const staticServer = serve(roots[target])
  const port = await listen(staticServer.server)
  const launchServer = await chromium.launchServer({ headless: true, executablePath })
  const browser = await chromium.connect(launchServer.wsEndpoint())
  const pid = launchServer.process().pid
  const errors = []
  try {
    const context = await browser.newContext({ timezoneId: 'UTC', viewport: { width: 1440, height: 1000 } })
    const page = await context.newPage()
    page.on('pageerror', (error) => errors.push(error.message))
    await installObserver(page)
    const profile = process.env.BENCH_PROFILE === '1' ? '&profile=1' : ''
    const url = `http://127.0.0.1:${port}/?engine=${target === 'baseline' ? 'js' : target}${profile}`
    await page.goto(url, { waitUntil: 'networkidle' })
    if (cache === 'warm') {
      if (target === 'wasm') {
        const assets = readdirSync(path.join(project, 'dist', 'assets'))
        const worker = assets.find((name) => name.startsWith('journalWorker-') && name.endsWith('.js'))
        const wasm = assets.find((name) => name.endsWith('.wasm'))
        await page.evaluate(async ({ worker, wasm }) => {
          await Promise.all([fetch(`./assets/${worker}`), fetch(`./assets/${wasm}`)].map((request) => request.then((response) => response.arrayBuffer())))
        }, { worker, wasm })
      }
      await page.reload({ waitUntil: 'networkidle' })
    }
    const requestsBefore = staticServer.requests
    const total = 100_000
    const filtered = 20_000
    const load = await sampled(pid, async () => {
      await page.locator('input[type=file]').setInputFiles(path.join(root, 'fixtures', corpus))
      await waitReady(page, target, total)
      return page.evaluate(() => {
        const state = window.__benchState
        const app = window.__journalAnalyzer
        const now = performance.now()
        const tasks = state.longTasks.filter((task) => task.startTime >= state.uploadStarted)
        return {
          endToEndMs: now - state.uploadStarted,
          loadLongTaskMs: tasks.reduce((sum, task) => sum + task.duration, 0),
          loadLongTasks: tasks.length,
          loadMetrics: app?.loadMetrics || null,
          initialEngineFilterMs: app?.filterMs ?? null,
          initialRecordsBoundaryMs: app?.recordsBoundaryMs ?? null,
          initialRecordsRoundTripMs: app?.recordsRoundTripMs ?? null,
        }
      })
    })
    const filter = await sampled(pid, async () => {
      await page.locator('input[placeholder^="regex,"]').fill('timeout failure')
      await waitFilter(page, target, filtered)
      return page.evaluate(() => {
        const state = window.__benchState
        const app = window.__journalAnalyzer
        const tasks = state.longTasks.slice(state.filterLongStart)
        const roundTrip = app?.recordsRoundTripMs ?? 0
        const engineMs = app?.filterMs ?? null
        const wallMs = performance.now() - state.filterStarted
        return {
          filterWallMs: wallMs,
          engineFilterMs: engineMs,
          recordsBoundaryMs: app?.recordsBoundaryMs ?? null,
          recordsRoundTripMs: app?.recordsRoundTripMs ?? null,
          filterRenderResidueMs: engineMs === null ? null : Math.max(0, wallMs - engineMs - roundTrip),
          filterLongTaskMs: tasks.reduce((sum, task) => sum + task.duration, 0),
          filterLongTasks: tasks.length,
        }
      })
    })
    const inputBytes = statSync(path.join(root, 'fixtures', corpus)).size
    return {
      target, corpus, cache, iteration, inputBytes,
      ...load,
      filterBaselineRssBytes: filter.baselineRssBytes,
      filterPeakRssBytes: filter.peakRssBytes,
      filterPeakRssDeltaBytes: filter.peakRssDeltaBytes,
      ...Object.fromEntries(Object.entries(filter).filter(([key]) => !['baselineRssBytes', 'peakRssBytes', 'peakRssDeltaBytes'].includes(key))),
      requestCount: staticServer.requests - requestsBefore,
      entriesPerSecond: total / (load.endToEndMs / 1000),
      megabytesPerSecond: inputBytes / 1_000_000 / (load.endToEndMs / 1000),
      errors,
    }
  } finally {
    await browser.close().catch(() => {})
    await launchServer.close().catch(() => {})
    await new Promise((resolve) => staticServer.server.close(resolve))
  }
}

function walk(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const filename = path.join(directory, entry.name)
    return entry.isDirectory() ? walk(filename) : [filename]
  })
}

function bundle(directory) {
  const files = walk(directory)
  const keyAssets = files.filter((file) => /index-.*\.(js|css)$|journalWorker-.*\.js$|\.wasm$/.test(file)).map((file) => {
    const bytes = readFileSync(file)
    return { file: path.relative(directory, file), bytes: bytes.length, gzipBytes: gzipSync(bytes).length }
  })
  return { totalBytes: files.reduce((sum, file) => sum + statSync(file).size, 0), keyAssets }
}

const results = {
  metadata: {
    date: new Date().toISOString(),
    browser: 'Chromium via Playwright, headless, 1440x1000, UTC',
    corpus: 'Deterministic synthetic 100,000-entry corpus; not a real-device claim',
    memory: 'Linux browser-process-tree RSS sampled every 50 ms; shared pages can be counted in multiple processes',
    runsPerConfiguration: runs,
  },
  bundles: { baseline: bundle(roots.baseline), optimized: bundle(roots.js) },
  runs: [],
}
if (process.env.BENCH_RESUME === '1' && existsSync(outputPath)) {
  const previous = JSON.parse(readFileSync(outputPath, 'utf8'))
  results.runs = previous.runs || []
}

for (const corpus of corpora) {
  for (const target of targets) {
    for (const cache of caches) {
      for (let iteration = 0; iteration < runs; iteration++) {
        if (results.runs.some((run) => run.corpus === corpus && run.target === target && run.cache === cache && run.iteration === iteration)) continue
        const result = await oneRun(target, corpus, cache, iteration)
        results.runs.push(result)
        await writeFile(outputPath, JSON.stringify(results, null, 2))
        console.log(`${corpus} ${target} ${cache} ${iteration + 1}/${runs}: ${result.endToEndMs.toFixed(1)} ms load, ${result.filterWallMs.toFixed(1)} ms filter, ${(result.peakRssDeltaBytes / 1048576).toFixed(1)} MiB peak RSS delta`)
        if (result.errors.length) console.error(`Browser errors: ${result.errors.join('; ')}`)
      }
    }
  }
}
console.log(`Results written to ${outputPath}`)
