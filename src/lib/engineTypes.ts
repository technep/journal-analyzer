import type { LogRecord } from '@/lib/journal'

export interface EngineStats {
  perUnit: Map<string, number>
  perPrio: Map<string, number>
  min: Date | null
  max: Date | null
}

export interface EngineBoot {
  id: string
  index: number
  count: number
  firstTs: Date | null
  lastTs: Date | null
}

export interface EngineMetrics {
  engine: 'js' | 'wasm'
  totalMs: number
  fileReadMs: number
  zipExtractionMs: number
  decompressionMs: number
  objectTraversalMs: number
  stringConversionMs: number
  recordConstructionMs: number
  jsonParseMs: number
  textParseMs: number
  sortIndexMs: number
  wasmInitMs: number
  boundaryMs: number
  inputBytes: number
  inputFileBytes: number
  loadLongTaskMs: number
  loadLongTasks: number
}

export interface RawStats {
  perUnit: Record<string, number>
  perPrio: Record<string, number>
  min: number | null
  max: number | null
}

export interface RawBoot {
  id: string
  index: number
  count: number
  firstTs: number | null
  lastTs: number | null
}

export interface RawRecord {
  id: number
  ts: number | null
  host: string
  unit: string
  pid: string
  priority: number | null
  message: string
  raw: string
  fields?: { name: string; values: string[] }[] | null
}

export interface FilterView {
  records?: LogRecord[]
  indices?: Uint32Array
  total: number
  stats: EngineStats
  patternError: string | null
  filterMs: number
}

export interface LoadProgress {
  (message: string): void
}

export function rawStats(value: RawStats): EngineStats {
  return {
    perUnit: new Map(Object.entries(value.perUnit)),
    perPrio: new Map(Object.entries(value.perPrio)),
    min: value.min === null ? null : new Date(value.min),
    max: value.max === null ? null : new Date(value.max),
  }
}

export function rawBoot(value: RawBoot): EngineBoot {
  return {
    ...value,
    firstTs: value.firstTs === null ? null : new Date(value.firstTs),
    lastTs: value.lastTs === null ? null : new Date(value.lastTs),
  }
}

export function rawRecord(value: RawRecord): LogRecord {
  const fields = value.fields
    ? Object.fromEntries(value.fields.map((field) => [field.name, field.values]))
    : undefined
  return {
    id: value.id,
    ts: value.ts === null ? null : new Date(value.ts),
    host: value.host,
    unit: value.unit,
    pid: value.pid,
    priority: value.priority ?? null,
    message: value.message,
    raw: value.raw,
    ...(fields ? { fields } : {}),
  }
}

export function emptyStats(): EngineStats {
  return { perUnit: new Map(), perPrio: new Map(), min: null, max: null }
}
