import { useDeferredValue, useMemo, useState } from 'react'
import DropZone from '@/components/DropZone'
import FilterPanel from '@/components/FilterPanel'
import LogTable from '@/components/LogTable'
import ExportBar from '@/components/ExportBar'
import RecordDetail from '@/components/RecordDetail'
import {
  applyFilters,
  countBoots,
  formatTime,
  listBoots,
  loadSingleFile,
  loadZip,
  stats,
} from '@/lib/journal'
import type { Filters, LoadResult, LogRecord } from '@/lib/journal'

export default function Home() {
  const [data, setData] = useState<LoadResult | null>(null)
  const [sourceName, setSourceName] = useState('')
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState('')
  const [fatalError, setFatalError] = useState<string | null>(null)
  const [selected, setSelected] = useState<LogRecord | null>(null)
  const [filters, setFilters] = useState<Filters>({
    since: null,
    until: null,
    units: new Set(),
    kernel: false,
    pattern: '',
    ignoreCase: true,
    maxPriority: null,
    bootId: null,
  })

  const handleFile = async (file: File) => {
    setBusy(true)
    setFatalError(null)
    setSourceName(file.name)
    setSelected(null)
    try {
      const isZip =
        file.name.toLowerCase().endsWith('.zip') ||
        file.type.includes('zip')
      const result = isZip
        ? await loadZip(file, setProgress)
        : await loadSingleFile(file, setProgress)
      setData(result)
      setFilters({
        since: null,
        until: null,
        units: new Set(),
        kernel: result.hasKernel,
        pattern: '',
        ignoreCase: true,
        maxPriority: null,
        bootId: null,
      })
    } catch (e) {
      setFatalError(
        e instanceof Error ? e.message : 'Could not read the archive.',
      )
      setData(null)
    } finally {
      setBusy(false)
      setProgress('')
    }
  }

  // Defer the pattern so typing stays responsive on large logs
  const deferredPattern = useDeferredValue(filters.pattern)
  const effectiveFilters = useMemo(
    () => ({ ...filters, pattern: deferredPattern }),
    [filters, deferredPattern],
  )

  const { records: filtered, patternError } = useMemo(
    () =>
      data
        ? applyFilters(data.records, effectiveFilters)
        : { records: [], patternError: null },
    [data, effectiveFilters],
  )

  const allStats = useMemo(
    () => (data ? stats(data.records) : null),
    [data],
  )
  const filteredStats = useMemo(() => stats(filtered), [filtered])
  const bootCount = useMemo(
    () => (data ? countBoots(data.records) : 0),
    [data],
  )
  const boots = useMemo(() => (data ? listBoots(data.records) : []), [data])

  return (
    <div className="mx-auto flex min-h-dvh max-w-[1500px] flex-col px-4 pb-6 sm:px-6">
      {/* Header */}
      <header className="flex flex-wrap items-baseline gap-x-4 gap-y-1 py-5">
        <h1 className="font-mono text-lg font-semibold text-popover-foreground">
          journal<span className="text-primary">://</span>analyzer
        </h1>
        <p className="text-sm text-muted-foreground">
          analyze systemd journal logs from another machine — 100% client-side,
          nothing leaves your browser
        </p>
        {data && (
          <button
            type="button"
            className="btn-ghost ml-auto"
            onClick={() => {
              setData(null)
              setFatalError(null)
            }}
          >
            load another archive
          </button>
        )}
      </header>

      {!data && (
        <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col justify-center gap-4">
          <DropZone onFile={handleFile} busy={busy} progress={progress} />
          {fatalError && (
            <div
              role="alert"
              className="rounded-md border border-destructive/50 bg-destructive/10 px-4 py-3 text-sm text-[#ff8f85]"
            >
              {fatalError}
            </div>
          )}
          <p className="text-center font-mono text-[12px] text-muted-foreground">
            accepts .zip archives (including a zipped journal directory with raw
            .journal files) or single .journal / .json / .log / .txt files
          </p>
        </main>
      )}

      {data && (
        <main className="flex min-h-0 flex-1 flex-col gap-4">
          {/* Summary strip */}
          <div className="flex flex-wrap items-center gap-x-5 gap-y-1 rounded-md border border-border bg-card px-4 py-2.5 font-mono text-[12px]">
            <span className="text-popover-foreground">{sourceName}</span>
            <span className="text-muted-foreground">
              {data.records.length.toLocaleString()} entries
            </span>
            {allStats?.min && allStats?.max && (
              <span className="text-muted-foreground">
                {formatTime(allStats.min)} → {formatTime(allStats.max)}
              </span>
            )}
            <span className="text-muted-foreground">
              {data.units.length} units
              {data.hasKernel ? ' + kernel' : ''}
            </span>
            {bootCount > 0 && (
              <span className="text-muted-foreground">
                {bootCount} boot{bootCount === 1 ? '' : 's'}
              </span>
            )}
            <span className="text-muted-foreground">
              {data.files.length} file(s) parsed
            </span>
          </div>

          {data.warnings.length > 0 && (
            <div className="rounded-md border border-[#ffc09a]/40 bg-[#ffc09a]/10 px-4 py-3">
              {data.warnings.map((w, i) => (
                <p key={i} className="font-mono text-[12px] leading-5 text-[#ffc09a]">
                  {w}
                </p>
              ))}
            </div>
          )}

          <div className="flex min-h-0 flex-1 flex-col gap-4 lg:flex-row">
            <FilterPanel
              filters={filters}
              onChange={setFilters}
              allUnits={data.units}
              hasKernel={data.hasKernel}
              unitCounts={allStats?.perUnit ?? new Map()}
              patternError={patternError}
              span={{ min: allStats?.min ?? null, max: allStats?.max ?? null }}
              boots={boots}
            />
            <div className="flex min-h-[420px] min-w-0 flex-1 flex-col gap-3">
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1 font-mono text-[12px] text-muted-foreground">
                <span>
                  <span className="text-popover-foreground">
                    {filtered.length.toLocaleString()}
                  </span>{' '}
                  / {data.records.length.toLocaleString()} entries
                </span>
                {filteredStats.min && filteredStats.max && filtered.length > 0 && (
                  <span>
                    {formatTime(filteredStats.min)} → {formatTime(filteredStats.max)}
                  </span>
                )}
                <ExportBar
                  records={filtered}
                  filters={effectiveFilters}
                  sourceName={sourceName}
                />
              </div>
              <LogTable records={filtered} total={filtered.length} onSelect={setSelected} />
            </div>
          </div>
          <RecordDetail record={selected} onClose={() => setSelected(null)} />
        </main>
      )}
    </div>
  )
}
