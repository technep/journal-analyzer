import type { Filters, LogRecord } from '@/lib/journal'
import {
  rawBoot,
  rawRecord,
  rawStats,
  type EngineBoot,
  type EngineMetrics,
  type EngineStats,
  type FilterView,
  type LoadProgress,
  type RawRecord,
  type RawStats,
} from '@/lib/engineTypes'

interface RawSummary {
  records: number
  units: string[]
  hasKernel: boolean
  stats: RawStats
  boots: Parameters<typeof rawBoot>[0][]
  capped: boolean
}

export interface WasmLoadResult {
  summary: RawSummary
  warnings: string[]
  files: string[]
  metrics: Omit<EngineMetrics, 'loadLongTaskMs' | 'loadLongTasks'>
}

interface Pending {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
}

export class WasmJournalClient {
  private worker: Worker
  private sequence = 0
  private pending = new Map<number, Pending>()
  private progress: LoadProgress | null = null
  lastRecordsBoundaryMs = 0
  lastRecordsRoundTripMs = 0

  constructor() {
    this.worker = new Worker(new URL('../workers/journalWorker.ts', import.meta.url), { type: 'module' })
    this.worker.onmessage = (event) => {
      const message = event.data
      if (message.type === 'progress') {
        this.progress?.(message.message)
        return
      }
      const pending = this.pending.get(message.id)
      if (!pending) return
      this.pending.delete(message.id)
      if (message.type === 'error') pending.reject(new Error(message.error))
      else pending.resolve(message.result)
    }
    this.worker.onerror = (event) => {
      const error = new Error(event.message || 'Journal worker failed')
      for (const pending of this.pending.values()) pending.reject(error)
      this.pending.clear()
    }
  }

  private call<T>(type: string, payload: Record<string, unknown> = {}, transfer: Transferable[] = []): Promise<T> {
    const id = ++this.sequence
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject })
      this.worker.postMessage({ id, type, ...payload }, transfer)
    })
  }

  async load(file: File, onProgress: LoadProgress): Promise<WasmLoadResult> {
    this.progress = onProgress
    try {
      return await this.call<WasmLoadResult>('load', {
        file,
        instrumented: new URLSearchParams(window.location.search).get('profile') === '1',
      })
    } finally {
      this.progress = null
    }
  }

  async filter(filters: Filters): Promise<FilterView> {
    const spec = {
      since: filters.since?.getTime() ?? null,
      until: filters.until?.getTime() ?? null,
      units: [...filters.units],
      kernel: filters.kernel,
      pattern: filters.pattern,
      ignoreCase: filters.ignoreCase,
      maxPriority: filters.maxPriority,
      bootId: filters.bootId,
    }
    const result = await this.call<{ indices: Uint32Array; stats: RawStats; patternError: string | null; filterMs: number }>('filter', { filters: spec })
    return {
      indices: result.indices,
      total: result.indices.length,
      stats: rawStats(result.stats),
      patternError: result.patternError,
      filterMs: result.filterMs,
    }
  }

  async records(indices: Uint32Array, includeFields = false): Promise<LogRecord[]> {
    if (indices.length === 0) {
      this.lastRecordsBoundaryMs = 0
      this.lastRecordsRoundTripMs = 0
      return []
    }
    const started = performance.now()
    const result = await this.call<{ records: RawRecord[]; boundaryMs: number }>('records', { indices, includeFields })
    const records = result.records.map(rawRecord)
    this.lastRecordsBoundaryMs = result.boundaryMs
    this.lastRecordsRoundTripMs = performance.now() - started
    return records
  }

  async record(index: number): Promise<LogRecord> {
    const result = await this.call<RawRecord>('record', { index })
    return rawRecord(result)
  }

  terminate() {
    this.worker.terminate()
    for (const pending of this.pending.values()) pending.reject(new Error('Journal worker was closed'))
    this.pending.clear()
  }
}

export type JournalSession = WasmJournalClient

export interface LoadedJournal {
  engine: 'js' | 'wasm'
  records: LogRecord[] | null
  session: JournalSession | null
  recordsCount: number
  units: string[]
  hasKernel: boolean
  warnings: string[]
  files: string[]
  stats: EngineStats
  boots: EngineBoot[]
  metrics: EngineMetrics
}
