import { extractArchive, isArchiveFile } from '../lib/archives'
import initWasm, { JournalEngine } from '../../core/pkg/journal_core'
import type { RawRecord } from '../lib/engineTypes'

interface LoadRequest {
  id: number
  type: 'load'
  file: File
  instrumented: boolean
}

interface FilterRequest {
  id: number
  type: 'filter'
  filters: unknown
}

interface RecordsRequest {
  id: number
  type: 'records'
  indices: Uint32Array
  includeFields: boolean
}

interface RecordRequest {
  id: number
  type: 'record'
  index: number
}

type Request = LoadRequest | FilterRequest | RecordsRequest | RecordRequest

let engine: JournalEngine | null = null
let wasmReady: Promise<unknown> | null = null
const scope = self as unknown as {
  postMessage: (message: unknown, transfer?: Transferable[]) => void
  onmessage: ((event: MessageEvent<Request>) => void) | null
}

function progress(message: string) {
  scope.postMessage({ type: 'progress', message })
}

async function ensureWasm() {
  if (!wasmReady) {
    wasmReady = initWasm({ module_or_path: new URL('../../core/pkg/journal_core_bg.wasm', import.meta.url) })
  }
  await wasmReady
}

function currentEngine(): JournalEngine {
  if (!engine) throw new Error('No journal is loaded')
  return engine
}

async function load(file: File, instrumented: boolean) {
  const totalStarted = performance.now()
  const initStarted = performance.now()
  await ensureWasm()
  const wasmInitMs = performance.now() - initStarted
  engine?.free()
  const lower = file.name.toLowerCase()
  const isArchive = isArchiveFile(file)
  engine = new JournalEngine(isArchive ? 500_000 : 0)
  engine.set_metrics_enabled(instrumented)
  const core = engine
  const warnings: string[] = []
  const files: string[] = []
  let fileReadMs = 0
  let zipExtractionMs = 0
  let skipped = 0
  const year = new Date().getFullYear()

  const addBytes = async (bytes: Uint8Array, kind: 'journal' | 'json' | 'text') => {
    const started = performance.now()
    if (kind === 'journal') core.add_journal(bytes)
    else if (kind === 'json') core.add_json(bytes, year)
    else core.add_text(bytes, year)
    return performance.now() - started
  }

  if (isArchive) {
    const archive = await extractArchive(file, progress)
    fileReadMs += archive.fileReadMs
    zipExtractionMs += archive.extractionMs
    skipped = archive.skipped
    const journalEntries = archive.entries.filter((entry) => entry.kind === 'journal')
    const jsonEntries = archive.entries.filter((entry) => entry.kind === 'json')
    const textEntries = archive.entries.filter((entry) => entry.kind === 'text')

    for (const [kind, entries] of [['journal', journalEntries], ['json', jsonEntries], ['text', textEntries]] as const) {
      for (const entry of entries.sort((a, b) => a.path.localeCompare(b.path))) {
        progress(`${kind === 'journal' ? 'Decoding journal' : 'Parsing'} ${entry.path}…`)
        try {
          await addBytes(entry.bytes, kind)
          files.push(entry.path)
        } catch (error) {
          warnings.push(`Could not parse ${entry.path}: ${error instanceof Error ? error.message : String(error)}`)
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 0))
      }
    }
    if (core.summary().records === 0 && warnings.length === 0) {
      warnings.push('No readable log entries found. Supported inside archives: binary *.journal files (e.g. a copied /var/log/journal directory), *.json (journalctl -o json), *.log / *.txt (journalctl -o short-iso or syslog).')
    }
    if (skipped > 0 && core.summary().records > 0) warnings.push(`Skipped ${skipped} non-log file(s) in the archive.`)
  } else {
    progress(lower.endsWith('.journal') || lower.endsWith('.journal~') ? 'Decoding journal file…' : 'Parsing log file…')
    const started = performance.now()
    const buffer = await file.arrayBuffer()
    fileReadMs += performance.now() - started
    const bytes = new Uint8Array(buffer)
    if (lower.endsWith('.journal') || lower.endsWith('.journal~')) core.add_journal(bytes)
    else core.add_json(bytes, year)
    files.push(file.name)
    if (core.summary().records === 0) warnings.push('No readable log entries found in this file.')
  }

  progress('Indexing…')
  core.finalize()
  const boundaryStarted = performance.now()
  const summary = core.summary()
  const coreMetrics = core.metrics()
  const boundaryMs = performance.now() - boundaryStarted
  if (summary.capped) warnings.push('Parsing capped at 500,000 entries to keep the browser responsive.')
  return {
    summary,
    warnings,
    files,
    metrics: {
      ...coreMetrics,
      totalMs: performance.now() - totalStarted,
      fileReadMs,
      zipExtractionMs,
      wasmInitMs,
      boundaryMs,
      inputFileBytes: file.size,
      engine: 'wasm',
    },
  }
}

scope.onmessage = async (event: MessageEvent<Request>) => {
  const request = event.data
  try {
    if (request.type === 'load') {
      const result = await load(request.file, request.instrumented)
      scope.postMessage({ id: request.id, type: 'result', result })
      return
    }
    if (request.type === 'filter') {
      const result = currentEngine().filter(request.filters)
      const indices = result.indices as Uint32Array
      scope.postMessage({ id: request.id, type: 'result', result }, [indices.buffer])
      return
    }
    if (request.type === 'records') {
      const started = performance.now()
      const records = currentEngine().records(request.indices, request.includeFields) as RawRecord[]
      const boundaryMs = performance.now() - started
      scope.postMessage({ id: request.id, type: 'result', result: { records, boundaryMs } })
      return
    }
    const result = currentEngine().record(request.index)
    scope.postMessage({ id: request.id, type: 'result', result })
  } catch (error) {
    scope.postMessage({
      id: request.id,
      type: 'error',
      error: error instanceof Error ? error.message : String(error),
    })
  }
}
