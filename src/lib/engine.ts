import {
  applyFilters,
  listBoots,
  loadArchive,
  loadSingleFile,
  stats,
  type Filters,
  type LogRecord,
} from '@/lib/journal'
import { beginJsMetrics, finishJsMetrics } from '@/lib/instrumentation'
import type { EngineMetrics, FilterView, LoadProgress } from '@/lib/engineTypes'
import { WasmJournalClient, type LoadedJournal } from '@/lib/wasmClient'
import { isArchiveFile } from '@/lib/archives'

export type EngineChoice = 'auto' | 'js' | 'wasm'

export function selectedEngine(): EngineChoice {
  const value = new URLSearchParams(window.location.search).get('engine')
  return value === 'js' || value === 'wasm' ? value : 'auto'
}

async function loadJavaScript(file: File, onProgress: LoadProgress): Promise<LoadedJournal> {
  const started = performance.now()
  beginJsMetrics()
  const result = isArchiveFile(file) ? await loadArchive(file, onProgress) : await loadSingleFile(file, onProgress)
  const phases = finishJsMetrics()
  const summaryStats = stats(result.records)
  return {
    engine: 'js',
    records: result.records,
    session: null,
    recordsCount: result.records.length,
    units: result.units,
    hasKernel: result.hasKernel,
    warnings: result.warnings,
    files: result.files,
    stats: {
      perUnit: summaryStats.perUnit,
      perPrio: summaryStats.perPrio,
      min: summaryStats.min,
      max: summaryStats.max,
    },
    boots: listBoots(result.records),
    metrics: {
      engine: 'js',
      totalMs: performance.now() - started,
      ...phases,
      wasmInitMs: 0,
      inputFileBytes: file.size,
      loadLongTaskMs: 0,
      loadLongTasks: 0,
    },
  }
}

export async function loadJournal(
  file: File,
  onProgress: LoadProgress,
  choice: EngineChoice,
): Promise<LoadedJournal> {
  if (choice === 'js') return loadJavaScript(file, onProgress)
  const session = new WasmJournalClient()
  try {
    const result = await session.load(file, onProgress)
    return {
      engine: 'wasm',
      records: null,
      session,
      recordsCount: result.summary.records,
      units: result.summary.units,
      hasKernel: result.summary.hasKernel,
      warnings: result.warnings,
      files: result.files,
      stats: {
        perUnit: new Map(Object.entries(result.summary.stats.perUnit)),
        perPrio: new Map(Object.entries(result.summary.stats.perPrio)),
        min: result.summary.stats.min === null ? null : new Date(result.summary.stats.min),
        max: result.summary.stats.max === null ? null : new Date(result.summary.stats.max),
      },
      boots: result.summary.boots.map((boot) => ({
        ...boot,
        firstTs: boot.firstTs === null ? null : new Date(boot.firstTs),
        lastTs: boot.lastTs === null ? null : new Date(boot.lastTs),
      })),
      metrics: { ...result.metrics, loadLongTaskMs: 0, loadLongTasks: 0 },
    }
  } catch (error) {
    session.terminate()
    if (choice === 'wasm') throw error
    const fallback = await loadJavaScript(file, onProgress)
    fallback.warnings.unshift(`WASM acceleration was unavailable; used the TypeScript engine. ${error instanceof Error ? error.message : String(error)}`)
    return fallback
  }
}

export function filterJavaScript(records: LogRecord[], filters: Filters): FilterView {
  const started = performance.now()
  const result = applyFilters(records, filters)
  return {
    records: result.records,
    total: result.records.length,
    stats: stats(result.records),
    patternError: result.patternError,
    filterMs: performance.now() - started,
  }
}

export async function filteredRecords(data: LoadedJournal, view: FilterView): Promise<LogRecord[]> {
  if (!data.session) return view.records ?? []
  const indices = view.indices ?? new Uint32Array()
  const records: LogRecord[] = []
  const chunkSize = 5000
  for (let offset = 0; offset < indices.length; offset += chunkSize) {
    records.push(...await data.session.records(indices.subarray(offset, offset + chunkSize), true))
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
  }
  return records
}

export async function recordPage(
  data: LoadedJournal,
  view: FilterView,
  offset: number,
  limit: number,
): Promise<LogRecord[]> {
  const end = Math.min(offset + limit, view.total)
  if (!data.session) return (view.records ?? []).slice(offset, end)
  return data.session.records((view.indices ?? new Uint32Array()).subarray(offset, end))
}

export function emptyEngineMetrics(engine: 'js' | 'wasm'): EngineMetrics {
  return {
    engine,
    totalMs: 0,
    fileReadMs: 0,
    zipExtractionMs: 0,
    decompressionMs: 0,
    objectTraversalMs: 0,
    stringConversionMs: 0,
    recordConstructionMs: 0,
    jsonParseMs: 0,
    textParseMs: 0,
    sortIndexMs: 0,
    wasmInitMs: 0,
    boundaryMs: 0,
    inputBytes: 0,
    inputFileBytes: 0,
    loadLongTaskMs: 0,
    loadLongTasks: 0,
  }
}
