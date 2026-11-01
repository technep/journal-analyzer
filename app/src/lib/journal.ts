import JSZip from 'jszip'
import { parseJournalFile } from './journalFile'
import type { JournalFieldMap } from './journalFile'

export interface LogRecord {
  ts: Date | null
  host: string
  unit: string // 'kernel' is the pseudo-unit for kernel messages
  pid: string
  priority: number | null // syslog priority 0..7
  message: string
  raw: string
  fields?: JournalFieldMap // full field set (binary journals / JSON exports)
}

export interface Filters {
  since: Date | null
  until: Date | null
  units: Set<string> // empty = all units
  kernel: boolean
  pattern: string
  ignoreCase: boolean
  maxPriority: number | null
  bootId: string | null // null = all boots
}

export interface LoadResult {
  records: LogRecord[]
  units: string[]
  hasKernel: boolean
  warnings: string[]
  files: string[]
}

export const KERNEL_UNIT = 'kernel'
export const PRIORITY_NAMES = [
  'emerg',
  'alert',
  'crit',
  'err',
  'warning',
  'notice',
  'info',
  'debug',
]

const MAX_RECORDS = 500_000

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

function recordFromJournalJson(obj: Record<string, unknown>): LogRecord | null {
  let ts: Date | null = null
  const tsRaw = obj['__REALTIME_TIMESTAMP']
  if (typeof tsRaw === 'string' && /^\d+$/.test(tsRaw)) {
    ts = new Date(Number(tsRaw) / 1000) // microseconds -> ms
  }
  const msgRaw: unknown = obj['MESSAGE'] ?? ''
  let msg: string
  if (Array.isArray(msgRaw)) {
    msg = new TextDecoder('utf-8').decode(new Uint8Array(msgRaw as number[]))
  } else {
    msg = String(msgRaw)
  }

  const transport = String(obj['_TRANSPORT'] ?? '')
  let unit = String(obj['_SYSTEMD_UNIT'] ?? obj['UNIT'] ?? '')
  if (transport === 'kernel') unit = KERNEL_UNIT

  let priority: number | null = null
  const prioRaw = obj['PRIORITY']
  if (prioRaw !== undefined && prioRaw !== null && prioRaw !== '') {
    const n = Number(prioRaw)
    if (Number.isInteger(n) && n >= 0 && n <= 7) priority = n
  }

  const fields: JournalFieldMap = {}
  for (const [k, v] of Object.entries(obj)) {
    if (k.startsWith('__')) continue
    fields[k] = [
      Array.isArray(v)
        ? new TextDecoder('utf-8').decode(new Uint8Array(v as number[]))
        : String(v),
    ]
  }

  return {
    ts,
    host: String(obj['_HOSTNAME'] ?? ''),
    unit,
    pid: String(obj['_PID'] ?? ''),
    priority,
    message: msg,
    raw: msg,
    fields,
  }
}

function recordFromJournalEntry(entry: {
  realtimeUsec: number
  fields: JournalFieldMap
}): LogRecord {
  const f = entry.fields
  const first = (k: string) => f[k]?.[0] ?? ''
  const transport = first('_TRANSPORT')
  let unit = first('_SYSTEMD_UNIT') || first('UNIT')
  if (transport === 'kernel') unit = KERNEL_UNIT
  const prioRaw = first('PRIORITY')
  const prioN = prioRaw === '' ? NaN : Number(prioRaw)
  const priority = Number.isInteger(prioN) && prioN >= 0 && prioN <= 7 ? prioN : null
  const message = (f['MESSAGE'] ?? []).join('\n')
  return {
    ts: new Date(entry.realtimeUsec / 1000),
    host: first('_HOSTNAME'),
    unit,
    pid: first('_PID'),
    priority,
    message,
    raw: message,
    fields: entry.fields,
  }
}

const ISO_RE =
  /^(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:[.,]\d+)?(?:[+-]\d{2}:?\d{2}|Z)?)\s+(\S+)\s+(.*)$/
const SYSLOG_RE = /^([A-Z][a-z]{2}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2})\s+(\S+)\s+(.*)$/
const UNIT_RE = /^([A-Za-z0-9_.@-]+?)(?:\[(\d+)\])?:\s+(.*)$/
const SYSLOG_MONTHS: Record<string, number> = {
  Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5,
  Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11,
}

function parseTextLine(line: string, defaultYear: number): LogRecord {
  let ts: Date | null = null
  let host = ''
  let rest = line

  const iso = ISO_RE.exec(line)
  if (iso) {
    const tsTxt = iso[1].replace('T', ' ').replace(',', '.')
    const parsed = new Date(tsTxt.replace(' ', 'T'))
    if (!Number.isNaN(parsed.getTime())) ts = parsed
    host = iso[2]
    rest = iso[3]
  } else {
    const sys = SYSLOG_RE.exec(line)
    if (sys) {
      const m = /([A-Z][a-z]{2})\s+(\d{1,2})\s+(\d{2}):(\d{2}):(\d{2})/.exec(sys[1])
      if (m && SYSLOG_MONTHS[m[1]] !== undefined) {
        ts = new Date(
          defaultYear,
          SYSLOG_MONTHS[m[1]],
          Number(m[2]),
          Number(m[3]),
          Number(m[4]),
          Number(m[5]),
        )
      }
      host = sys[2]
      rest = sys[3]
    }
  }

  let unit = ''
  let pid = ''
  let msg = rest
  const um = UNIT_RE.exec(rest)
  if (um) {
    unit = um[1]
    pid = um[2] ?? ''
    msg = um[3]
  }
  return { ts, host, unit, pid, priority: null, message: msg, raw: line }
}

// ---------------------------------------------------------------------------
// Zip loading
// ---------------------------------------------------------------------------

export async function loadZip(
  file: File,
  onProgress: (msg: string) => void,
): Promise<LoadResult> {
  const warnings: string[] = []
  const files: string[] = []
  const records: LogRecord[] = []

  onProgress('Reading zip archive…')
  const zip = await JSZip.loadAsync(file)

  const jsonPaths: string[] = []
  const textPaths: string[] = []
  const journalPaths: string[] = []
  let skipped = 0

  zip.forEach((path, entry) => {
    if (entry.dir) return
    const lower = path.toLowerCase()
    if (lower.endsWith('.journal') || lower.endsWith('.journal~')) {
      journalPaths.push(path)
    } else if (lower.endsWith('.json')) {
      jsonPaths.push(path)
    } else if (lower.endsWith('.log') || lower.endsWith('.txt')) {
      textPaths.push(path)
    } else {
      skipped++
    }
  })

  const pushRecord = (r: LogRecord) => {
    if (records.length < MAX_RECORDS) records.push(r)
  }

  // Binary journal files (e.g. a zipped /var/log/journal/) — parsed natively
  for (const path of journalPaths.sort()) {
    onProgress(`Decoding journal ${path}…`)
    try {
      const buf = await zip.file(path)?.async('arraybuffer')
      if (!buf) continue
      const entries = await parseJournalFile(buf)
      for (const e of entries) pushRecord(recordFromJournalEntry(e))
      files.push(path)
    } catch (e) {
      warnings.push(
        `Could not parse ${path}: ${e instanceof Error ? e.message : String(e)}`,
      )
    }
    await yieldFrame()
  }

  for (const path of jsonPaths.sort()) {
    onProgress(`Parsing ${path}…`)
    const text = await zip.file(path)?.async('string')
    if (!text) continue
    files.push(path)
    for (const line of text.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed) continue
      if (trimmed.startsWith('{')) {
        try {
          const rec = recordFromJournalJson(JSON.parse(trimmed))
          if (rec) pushRecord(rec)
          continue
        } catch {
          // fall through to text parsing
        }
      }
      pushRecord(parseTextLine(trimmed, new Date().getFullYear()))
    }
    await yieldFrame()
  }

  for (const path of textPaths.sort()) {
    onProgress(`Parsing ${path}…`)
    const text = await zip.file(path)?.async('string')
    if (!text) continue
    files.push(path)
    const year = new Date().getFullYear()
    for (const line of text.split('\n')) {
      if (line.trim()) pushRecord(parseTextLine(line.replace(/\r$/, ''), year))
    }
    await yieldFrame()
  }

  if (records.length === 0 && warnings.length === 0) {
    warnings.push(
      'No readable log entries found. Supported inside the zip: ' +
        'binary *.journal files (e.g. a copied /var/log/journal directory), ' +
        '*.json (journalctl -o json), *.log / *.txt (journalctl -o short-iso or syslog).',
    )
  }
  if (skipped > 0 && records.length > 0) {
    warnings.push(`Skipped ${skipped} non-log file(s) in the archive.`)
  }
  if (records.length >= MAX_RECORDS) {
    warnings.push(
      `Parsing capped at ${MAX_RECORDS.toLocaleString()} entries to keep the browser responsive.`,
    )
  }

  onProgress('Indexing…')
  records.sort((a, b) => {
    if (a.ts && b.ts) return a.ts.getTime() - b.ts.getTime()
    if (a.ts) return -1
    if (b.ts) return 1
    return 0
  })

  const unitSet = new Set<string>()
  let hasKernel = false
  for (const r of records) {
    if (r.unit === KERNEL_UNIT) hasKernel = true
    else if (r.unit) unitSet.add(r.unit)
  }

  return {
    records,
    units: [...unitSet].sort(),
    hasKernel,
    warnings,
    files,
  }
}

function yieldFrame(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

/**
 * Load a single file directly (no zip): a binary .journal file, a JSON
 * export, or a text log.
 */
export async function loadSingleFile(
  file: File,
  onProgress: (msg: string) => void,
): Promise<LoadResult> {
  const warnings: string[] = []
  const records: LogRecord[] = []
  const lower = file.name.toLowerCase()

  if (lower.endsWith('.journal') || lower.endsWith('.journal~')) {
    onProgress('Decoding journal file…')
    const entries = await parseJournalFile(await file.arrayBuffer())
    for (const e of entries) records.push(recordFromJournalEntry(e))
  } else {
    onProgress('Parsing log file…')
    const text = await file.text()
    const year = new Date().getFullYear()
    for (const line of text.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed) continue
      if (trimmed.startsWith('{')) {
        try {
          const rec = recordFromJournalJson(JSON.parse(trimmed))
          if (rec) records.push(rec)
          continue
        } catch {
          // fall through to text parsing
        }
      }
      records.push(parseTextLine(trimmed, year))
    }
  }

  records.sort((a, b) => {
    if (a.ts && b.ts) return a.ts.getTime() - b.ts.getTime()
    if (a.ts) return -1
    if (b.ts) return 1
    return 0
  })

  const unitSet = new Set<string>()
  let hasKernel = false
  for (const r of records) {
    if (r.unit === KERNEL_UNIT) hasKernel = true
    else if (r.unit) unitSet.add(r.unit)
  }
  if (records.length === 0) {
    warnings.push('No readable log entries found in this file.')
  }
  return {
    records,
    units: [...unitSet].sort(),
    hasKernel,
    warnings,
    files: [file.name],
  }
}

/** Count distinct boots across records that carry field data. */
export function countBoots(records: LogRecord[]): number {
  const boots = new Set<string>()
  for (const r of records) {
    const b = r.fields?.['_BOOT_ID']?.[0]
    if (b) boots.add(b)
  }
  return boots.size
}

export interface BootInfo {
  id: string
  /** chronological index, 0 = oldest boot (journalctl -b style) */
  index: number
  count: number
  firstTs: Date | null
  lastTs: Date | null
}

/** List boots (oldest first) with entry counts and time spans. */
export function listBoots(records: LogRecord[]): BootInfo[] {
  const map = new Map<string, { count: number; first: number; last: number }>()
  for (const r of records) {
    const b = r.fields?.['_BOOT_ID']?.[0]
    if (!b) continue
    const t = r.ts?.getTime() ?? Number.NaN
    const cur = map.get(b) ?? { count: 0, first: Number.NaN, last: Number.NaN }
    cur.count++
    if (!Number.isNaN(t)) {
      if (Number.isNaN(cur.first) || t < cur.first) cur.first = t
      if (Number.isNaN(cur.last) || t > cur.last) cur.last = t
    }
    map.set(b, cur)
  }
  const tsOrNull = (t: number) => (Number.isNaN(t) ? null : new Date(t))
  return [...map.entries()]
    .sort((a, b) => (a[1].first || 0) - (b[1].first || 0))
    .map(([id, v], index) => ({
      id,
      index,
      count: v.count,
      firstTs: tsOrNull(v.first),
      lastTs: tsOrNull(v.last),
    }))
}

// ---------------------------------------------------------------------------
// Filtering
// ---------------------------------------------------------------------------

export interface FilterResult {
  records: LogRecord[]
  patternError: string | null
}

export function applyFilters(records: LogRecord[], f: Filters): FilterResult {
  let rx: RegExp | null = null
  let patternError: string | null = null
  if (f.pattern) {
    try {
      rx = new RegExp(f.pattern, f.ignoreCase ? 'i' : '')
    } catch (e) {
      patternError = e instanceof Error ? e.message : 'Invalid pattern'
    }
  }

  const out: LogRecord[] = []
  for (const r of records) {
    if (f.since && r.ts && r.ts < f.since) continue
    if (f.until && r.ts && r.ts > f.until) continue
    if (f.maxPriority !== null && r.priority !== null && r.priority > f.maxPriority) continue
    if (f.bootId && r.fields?.['_BOOT_ID']?.[0] !== f.bootId) continue
    if (r.unit === KERNEL_UNIT) {
      if (!f.kernel) continue
    } else if (f.units.size > 0 && !f.units.has(r.unit)) {
      continue
    }
    if (rx && !(rx.test(r.raw) || rx.test(r.message) || rx.test(r.unit))) continue
    out.push(r)
  }
  return { records: out, patternError }
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

export function formatTime(d: Date | null): string {
  if (!d) return ''
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

export function priorityName(p: number | null): string {
  if (p === null) return ''
  return PRIORITY_NAMES[p] ?? String(p)
}

export function formatLine(r: LogRecord): string {
  const host = r.host ? ` ${r.host}` : ''
  const unit = r.unit || '-'
  const pid = r.pid ? `[${r.pid}]` : ''
  return `${formatTime(r.ts)}${host} ${unit}${pid}: ${r.message}`
}

const ERROR_RX =
  /\b(error|err|fail(ed|ure)?|crit(ical)?|panic|segfault|denied|timeout|timed out|cannot|unable|exception|traceback|abort(ed)?|core dump|oom|out of memory|watchdog)\b/i

export function isErrorLike(r: LogRecord): boolean {
  return (r.priority !== null && r.priority <= 4) || ERROR_RX.test(r.message)
}

export function filterSummary(f: Filters): string {
  const parts: string[] = []
  if (f.since) parts.push(`from ${formatTime(f.since)}`)
  if (f.until) parts.push(`until ${formatTime(f.until)}`)
  if (f.units.size > 0) parts.push(`units: ${[...f.units].sort().join(', ')}`)
  if (f.kernel) parts.push('kernel messages included')
  if (f.pattern)
    parts.push(`pattern: /${f.pattern}/${f.ignoreCase ? ' (case-insensitive)' : ''}`)
  if (f.maxPriority !== null) parts.push(`priority <= ${PRIORITY_NAMES[f.maxPriority]}`)
  if (f.bootId) parts.push(`boot: ${f.bootId.slice(0, 8)}…`)
  return parts.length ? parts.join('; ') : 'no filters (all records)'
}

export function stats(records: LogRecord[]) {
  const perUnit = new Map<string, number>()
  const perPrio = new Map<string, number>()
  let min: Date | null = null
  let max: Date | null = null
  for (const r of records) {
    const u = r.unit || '(none)'
    perUnit.set(u, (perUnit.get(u) ?? 0) + 1)
    const p = priorityName(r.priority) || 'unknown'
    perPrio.set(p, (perPrio.get(p) ?? 0) + 1)
    if (r.ts) {
      if (!min || r.ts < min) min = r.ts
      if (!max || r.ts > max) max = r.ts
    }
  }
  return { perUnit, perPrio, min, max }
}
