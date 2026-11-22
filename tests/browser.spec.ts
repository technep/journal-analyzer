import { test, expect, type Page } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures')
const validFixtures = [
  'plain.journal',
  'lz4.journal',
  'zstd.journal',
  'xz.journal',
  'legacy.journal',
  'keyed.journal',
  'large-record.journal',
  'expected.json',
  'plain.log',
  'empty.json',
  'nested.zip',
  'nested.tar',
  'nested.tar.gz',
  'nested.tgz',
  'nested.7z',
]

async function loadFixture(page: Page, engine: 'js' | 'wasm', filename: string) {
  await page.goto(`/?engine=${engine}`)
  await page.locator('input[type=file]').setInputFiles(path.join(fixtures, filename))
  await page.waitForFunction(
    ({ filename, engine }) => {
      const app = window.__journalAnalyzer
      return app?.sourceName === filename && app.ready && app.engine === engine
    },
    { filename, engine },
  )
}

async function snapshot(page: Page) {
  const records = await page.evaluate(() => window.__journalAnalyzer!.snapshot())
  return (records as Record<string, unknown>[]).map((record) =>
    Object.fromEntries(Object.entries(record).filter(([key]) => key !== 'id')),
  )
}

async function expectCount(page: Page, count: number) {
  await page.waitForFunction((count) => {
    const app = window.__journalAnalyzer
    return app && !app.filtering && app.filteredCount === count
  }, count)
}

test.describe('production browser differential suite', () => {
  for (const filename of validFixtures) {
    test(`${filename}: TypeScript and WASM produce identical records`, async ({ page }) => {
      await loadFixture(page, 'js', filename)
      const expected = await snapshot(page)
      await loadFixture(page, 'wasm', filename)
      expect(await snapshot(page)).toEqual(expected)

      if (filename.startsWith('nested.')) {
        expect(expected).toHaveLength(14)
        await expect(page.getByText('Skipped 1 non-log file(s) in the archive.')).toBeVisible()
      }
      if (filename === 'large-record.journal') {
        const message = (expected[0] as { message: string }).message
        expect(message.startsWith('large compressed payload ')).toBe(true)
        expect(message.length).toBeGreaterThanOrEqual(10_000)
      }
    })
  }

  for (const filename of ['malformed.journal', 'truncated.journal', 'compact.journal', 'malformed.7z']) {
    for (const engine of ['js', 'wasm'] as const) {
      test(`${filename}: ${engine} fails cleanly`, async ({ page }) => {
        await page.goto(`/?engine=${engine}`)
        await page.locator('input[type=file]').setInputFiles(path.join(fixtures, filename))
        await expect(page.getByRole('alert')).toBeVisible()
        const state = await page.evaluate(() => window.__journalAnalyzer)
        expect(state?.busy).toBe(false)
        expect(state?.engine).toBeNull()
      })
    }
  }

  for (const engine of ['js', 'wasm'] as const) {
    test(`${engine}: filters, lazy details, and exports retain feature parity`, async ({ page }) => {
      await loadFixture(page, engine, 'smoke.json')
      expect(await snapshot(page)).toHaveLength(3)

      await page.getByText('network timeout', { exact: true }).click()
      const detail = page.getByRole('dialog', { name: 'Log entry details' })
      await expect(detail).toBeVisible()
      await expect(detail.getByText('_HOSTNAME', { exact: true })).toBeVisible()
      await expect(detail.getByText('edge-01', { exact: true })).toBeVisible()
      await detail.getByRole('button', { name: 'Close' }).click()

      await page.getByRole('textbox', { name: 'Search pattern' }).fill('TIMEOUT')
      await expectCount(page, 1)
      await page.getByRole('checkbox', { name: 'Case insensitive' }).uncheck()
      await expectCount(page, 0)
      await page.getByRole('textbox', { name: 'Search pattern' }).fill('timeout')
      await expectCount(page, 1)
      await page.getByRole('button', { name: 'Reset filters' }).click()
      await expectCount(page, 3)

      await page.getByRole('checkbox', { name: 'Kernel messages' }).uncheck()
      await page.getByRole('checkbox', { name: 'Unit init.service' }).check()
      await expectCount(page, 1)
      await page.getByRole('button', { name: 'Reset filters' }).click()
      await expectCount(page, 3)

      await page.getByRole('combobox', { name: 'Minimum severity' }).selectOption('4')
      await expectCount(page, 2)
      await page.getByRole('button', { name: 'Reset filters' }).click()
      await page.getByRole('combobox', { name: 'Boot' }).selectOption('boot-a')
      await expectCount(page, 2)
      await page.getByRole('button', { name: 'Reset filters' }).click()

      await page.getByLabel('From', { exact: true }).fill('2025-01-01T00:00:01')
      await page.getByLabel('Until', { exact: true }).fill('2025-01-01T00:00:01')
      await expectCount(page, 1)
      await page.getByRole('button', { name: 'Reset filters' }).click()

      await page.getByRole('textbox', { name: 'Search pattern' }).fill('[')
      await expect(page.getByText('invalid regex — pattern ignored')).toBeVisible()
      await expectCount(page, 3)
      await page.getByRole('textbox', { name: 'Search pattern' }).fill('timeout')
      await expectCount(page, 1)

      const aiDownload = page.waitForEvent('download')
      await page.getByRole('button', { name: 'AI analysis .md' }).click()
      const ai = await aiDownload
      const aiText = await readFile((await ai.path())!, 'utf8')
      expect(aiText).toContain('network timeout')
      expect(aiText).not.toContain('boot completed')

      await page.getByRole('button', { name: 'Jira ticket…' }).click()
      await page.getByRole('dialog', { name: 'Jira ticket details' }).locator('input').fill('Network timeout')
      const jiraDownload = page.waitForEvent('download')
      await page.getByRole('button', { name: 'Save .txt' }).click()
      const jira = await jiraDownload
      const jiraText = await readFile((await jira.path())!, 'utf8')
      expect(jiraText).toContain('Network timeout')
      expect(jiraText).toContain('network timeout')
    })
  }

  for (const engine of ['js', 'wasm'] as const) {
    test(`${engine}: pagination and bidirectional scrolling lazily retain bounded pages`, async ({ page }) => {
      await loadFixture(page, engine, 'paged.json')
      await page.waitForFunction(() => {
        const app = window.__journalAnalyzer
        return app?.loadedPages.includes(0) && app.visibleCount === 200
      })
      await expect(page.getByRole('button', { name: 'Go to page 1' })).toHaveAttribute('aria-current', 'page')

      await page.getByRole('button', { name: 'Next page' }).click()
      await page.waitForFunction(() => window.__journalAnalyzer?.loadedPages.includes(1))
      await expect(page.getByRole('button', { name: 'Go to page 2' })).toHaveAttribute('aria-current', 'page')
      await expect(page.locator('[role="row"][aria-rowindex="201"]')).toContainText('message 200')

      await page.getByRole('button', { name: 'Previous page' }).click()
      await expect(page.getByRole('button', { name: 'Go to page 1' })).toHaveAttribute('aria-current', 'page')
      await expect(page.locator('[role="row"][aria-rowindex="1"]')).toContainText('message 0')

      const viewport = page.getByTestId('entry-viewport')
      for (const [row, loadedPage] of [[401, 2], [601, 3], [801, 4]] as const) {
        await viewport.evaluate((element, row) => { element.scrollTop = (row - 1) * 40 }, row)
        await page.waitForFunction((page) => window.__journalAnalyzer?.loadedPages.includes(page), loadedPage)
        await expect(page.locator(`[role="row"][aria-rowindex="${row}"]`)).toContainText(`message ${row - 1}`)
      }
      await expect(page.getByRole('button', { name: 'Go to page 5' })).toHaveAttribute('aria-current', 'page')
      expect(await page.evaluate(() => window.__journalAnalyzer?.loadedPages)).toEqual([1, 2, 3, 4])

      await viewport.evaluate((element) => { element.scrollTop = 0 })
      await page.waitForFunction(() => window.__journalAnalyzer?.loadedPages.includes(0))
      await expect(page.locator('[role="row"][aria-rowindex="1"]')).toContainText('message 0')
      expect(await page.evaluate(() => window.__journalAnalyzer?.loadedPages)).toEqual([0, 1, 2, 3])
      expect(await snapshot(page)).toHaveLength(1000)
    })
  }
})

test('automatic mode falls back to TypeScript when WASM cannot load', async ({ browser }) => {
  const context = await browser.newContext({
    baseURL: 'http://127.0.0.1:4187',
    serviceWorkers: 'block',
  })
  const page = await context.newPage()
  try {
    await page.route('**/*.wasm', (route) => route.abort())
    await page.goto('/?engine=auto')
    await page.locator('input[type=file]').setInputFiles(path.join(fixtures, 'smoke.json'))
    await page.waitForFunction(() => window.__journalAnalyzer?.ready)
    expect(await page.evaluate(() => window.__journalAnalyzer?.engine)).toBe('js')
    await expect(page.getByText(/WASM acceleration was unavailable/)).toBeVisible()
    expect(await snapshot(page)).toHaveLength(3)
  } finally {
    await context.close()
  }
})

test('PWA reloads offline and extracts 7z with precached decoder assets', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await loadFixture(page, 'wasm', 'smoke.json')
  await page.evaluate(() => navigator.serviceWorker.ready.then(() => undefined))
  await page.waitForFunction(async () => {
    if (!navigator.serviceWorker.controller) return false
    const cache = await caches.open('journal-analyzer-v8')
    const keys = await cache.keys()
    return keys.some((request) => request.url.includes('7zz-') && request.url.endsWith('.wasm'))
  })
  await page.context().setOffline(true)
  await page.reload()
  await page.locator('input[type=file]').setInputFiles(path.join(fixtures, 'nested.7z'))
  await page.waitForFunction(() => window.__journalAnalyzer?.ready)
  expect(await snapshot(page)).toHaveLength(14)
  expect(errors).toEqual([])
})

test('mobile layout keeps controls and record details usable without page overflow', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await loadFixture(page, 'wasm', 'smoke.json')
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)
  await page.getByText('network timeout', { exact: true }).click()
  await expect(page.getByRole('dialog', { name: 'Log entry details' })).toBeVisible()
  await page.getByRole('button', { name: 'Close' }).click()
  await expect(page.getByRole('textbox', { name: 'Search pattern' })).toBeVisible()
})
