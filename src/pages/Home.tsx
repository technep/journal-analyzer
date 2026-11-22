import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react'
import DropZone from '@/components/DropZone'
import ExportBar from '@/components/ExportBar'
import FilterPanel from '@/components/FilterPanel'
import LogTable, { type PageDirection } from '@/components/LogTable'
import RecordDetail from '@/components/RecordDetail'
import {
  filterJavaScript,
  filteredRecords,
  loadJournal,
  recordPage,
  selectedEngine,
} from '@/lib/engine'
import { emptyStats, type FilterView } from '@/lib/engineTypes'
import { formatTime, type Filters, type LogRecord } from '@/lib/journal'
import type { LoadedJournal } from '@/lib/wasmClient'

const PAGE_SIZE = 200
const MAX_LOADED_PAGES = 4

declare global {
  interface Window {
    __journalAnalyzer?: {
      sourceName: string
      busy: boolean
      filtering: boolean
      ready: boolean
      engine: string | null
      recordsCount: number
      filteredCount: number
      visibleCount: number
      loadedPages: number[]
      pageSize: number
      maxLoadedPages: number
      filterMs: number
      recordsBoundaryMs: number
      recordsRoundTripMs: number
      loadMetrics: LoadedJournal['metrics'] | null
      snapshot: () => Promise<unknown[]>
    }
  }
}

export default function Home() {
  const [data, setData] = useState<LoadedJournal | null>(null)
  const [sourceName, setSourceName] = useState('')
  const [busy, setBusy] = useState(false)
  const [filtering, setFiltering] = useState(false)
  const [progress, setProgress] = useState('')
  const [fatalError, setFatalError] = useState<string | null>(null)
  const [selected, setSelected] = useState<LogRecord | null>(null)
  const [view, setView] = useState<FilterView | null>(null)
  const [recordPages, setRecordPages] = useState<ReadonlyMap<number, LogRecord[]>>(new Map())
  const [pendingPages, setPendingPages] = useState<ReadonlySet<number>>(new Set())
  const [filters, setFilters] = useState<Filters>({
    since: null,
    until: null,
    units: new Set<string>(),
    kernel: false,
    pattern: '',
    ignoreCase: true,
    maxPriority: null,
    bootId: null,
  })
  const dataRef = useRef<LoadedJournal | null>(null)
  const recordPagesRef = useRef<Map<number, LogRecord[]>>(new Map())
  const pendingPagesRef = useRef<Set<number>>(new Set())
  const filterSequence = useRef(0)
  const selectionSequence = useRef(0)
  dataRef.current = data

  const clearPages = useCallback(() => {
    recordPagesRef.current = new Map()
    pendingPagesRef.current = new Set()
    setRecordPages(recordPagesRef.current)
    setPendingPages(pendingPagesRef.current)
  }, [])

  useEffect(() => () => dataRef.current?.session?.terminate(), [])

  const handleFile = async (file: File) => {
    dataRef.current?.session?.terminate()
    setBusy(true)
    setFatalError(null)
    setSourceName(file.name)
    setSelected(null)
    setData(null)
    setView(null)
    filterSequence.current++
    clearPages()
    let longTaskMs = 0
    let longTasks = 0
    let observer: PerformanceObserver | null = null
    try {
      if (typeof PerformanceObserver !== 'undefined' && PerformanceObserver.supportedEntryTypes.includes('longtask')) {
        observer = new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) {
            longTaskMs += entry.duration
            longTasks++
          }
        })
        observer.observe({ entryTypes: ['longtask'] })
      }
      const result = await loadJournal(file, setProgress, selectedEngine())
      result.metrics.loadLongTaskMs = longTaskMs
      result.metrics.loadLongTasks = longTasks
      setData(result)
      setFilters({
        since: null,
        until: null,
        units: new Set<string>(),
        kernel: result.hasKernel,
        pattern: '',
        ignoreCase: true,
        maxPriority: null,
        bootId: null,
      })
    } catch (error) {
      setFatalError(error instanceof Error ? error.message : 'Could not read the archive.')
      setData(null)
    } finally {
      observer?.disconnect()
      setBusy(false)
      setProgress('')
    }
  }

  const deferredPattern = useDeferredValue(data?.session ? '' : filters.pattern)
  const effectiveFilters = useMemo(
    () => ({ ...filters, pattern: data?.session ? filters.pattern : deferredPattern }),
    [filters, deferredPattern, data],
  )

  useEffect(() => {
    let cancelled = false
    const generation = ++filterSequence.current
    clearPages()
    if (!data) {
      setView(null)
      return
    }
    setFiltering(true)
    setView(null)
    const run = async () => {
      try {
        const nextView = data.session
          ? await data.session.filter(effectiveFilters)
          : filterJavaScript(data.records ?? [], effectiveFilters)
        if (!cancelled && generation === filterSequence.current) setView(nextView)
      } catch (error) {
        if (!cancelled) setFatalError(error instanceof Error ? error.message : String(error))
      } finally {
        if (!cancelled) setFiltering(false)
      }
    }
    void run()
    return () => {
      cancelled = true
    }
  }, [data, effectiveFilters, clearPages])

  const loadPage = useCallback(async (page: number, direction: PageDirection) => {
    if (!data || !view || view.total === 0) return
    const pageCount = Math.ceil(view.total / PAGE_SIZE)
    if (page < 0 || page >= pageCount || recordPagesRef.current.has(page) || pendingPagesRef.current.has(page)) return
    const generation = filterSequence.current
    const pending = new Set(pendingPagesRef.current)
    pending.add(page)
    pendingPagesRef.current = pending
    setPendingPages(pending)
    try {
      const rows = await recordPage(data, view, page * PAGE_SIZE, PAGE_SIZE)
      if (generation !== filterSequence.current) return
      const next = new Map(recordPagesRef.current)
      next.set(page, rows)
      while (next.size > MAX_LOADED_PAGES) {
        const candidates = [...next.keys()].filter((key) => key !== page)
        if (candidates.length === 0) break
        const evict = direction === 'backward'
          ? Math.max(...candidates)
          : direction === 'forward'
            ? Math.min(...candidates)
            : candidates.reduce((farthest, key) =>
                Math.abs(key - page) > Math.abs(farthest - page) ? key : farthest,
              )
        next.delete(evict)
      }
      recordPagesRef.current = next
      setRecordPages(next)
    } catch (error) {
      if (generation === filterSequence.current) {
        setFatalError(error instanceof Error ? error.message : String(error))
      }
    } finally {
      if (generation === filterSequence.current) {
        const nextPending = new Set(pendingPagesRef.current)
        nextPending.delete(page)
        pendingPagesRef.current = nextPending
        setPendingPages(nextPending)
      }
    }
  }, [data, view])

  useEffect(() => {
    if (view && view.total > 0) void loadPage(0, 'jump')
  }, [view, loadPage])

  const handleLoadPage = useCallback((page: number, direction: PageDirection) => {
    void loadPage(page, direction)
  }, [loadPage])

  const loadedCount = useMemo(
    () => [...recordPages.values()].reduce((total, rows) => total + rows.length, 0),
    [recordPages],
  )

  useEffect(() => {
    window.__journalAnalyzer = {
      sourceName,
      busy,
      filtering,
      ready: data !== null && view !== null && !busy && !filtering,
      engine: data?.engine ?? null,
      recordsCount: data?.recordsCount ?? 0,
      filteredCount: view?.total ?? 0,
      visibleCount: loadedCount,
      loadedPages: [...recordPages.keys()].sort((a, b) => a - b),
      pageSize: PAGE_SIZE,
      maxLoadedPages: MAX_LOADED_PAGES,
      filterMs: view?.filterMs ?? 0,
      recordsBoundaryMs: data?.session?.lastRecordsBoundaryMs ?? 0,
      recordsRoundTripMs: data?.session?.lastRecordsRoundTripMs ?? 0,
      loadMetrics: data?.metrics ?? null,
      snapshot: async () => {
        if (!data || !view) return []
        return (await filteredRecords(data, view)).map((record) => ({
          ...record,
          ts: record.ts?.getTime() ?? null,
        }))
      },
    }
  }, [sourceName, busy, filtering, data, view, recordPages, loadedCount])

  const selectRecord = async (record: LogRecord) => {
    setSelected(record)
    if (!data?.session || record.id === undefined) return
    const sequence = ++selectionSequence.current
    const detailed = await data.session.record(record.id)
    if (sequence === selectionSequence.current) setSelected(detailed)
  }

  const allStats = data?.stats ?? null
  const filteredStats = view?.stats ?? emptyStats()

  return (
    <div className="mx-auto flex min-h-dvh max-w-[1500px] flex-col px-4 pb-6 sm:px-6">
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
              data.session?.terminate()
              setData(null)
              setView(null)
              filterSequence.current++
              clearPages()
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
            <div role="alert" className="rounded-md border border-destructive bg-destructive/10 px-4 py-3">
              <p className="font-mono text-[12px] leading-5 text-[#ff8f85]">{fatalError}</p>
            </div>
          )}
          <p className="text-center font-mono text-[12px] text-muted-foreground">
            accepts .zip, .tar, .tar.gz / .tgz, and .7z archives (including archived
            journal directories with raw .journal files) or single .journal / .json / .log / .txt files
          </p>
        </main>
      )}

      {data && (
        <main className="flex min-h-0 flex-1 flex-col gap-4">
          <div className="flex flex-wrap items-center gap-x-5 gap-y-1 rounded-md border border-border bg-card px-4 py-2.5 font-mono text-[12px]">
            <span className="text-popover-foreground">{sourceName}</span>
            <span className="text-muted-foreground">{data.recordsCount.toLocaleString()} entries</span>
            {allStats?.min && allStats.max && (
              <span className="text-muted-foreground">{formatTime(allStats.min)} → {formatTime(allStats.max)}</span>
            )}
            <span className="text-muted-foreground">
              {data.units.length} units{data.hasKernel ? ' + kernel' : ''}
            </span>
            {data.boots.length > 0 && (
              <span className="text-muted-foreground">
                {data.boots.length} boot{data.boots.length === 1 ? '' : 's'}
              </span>
            )}
            <span className="text-muted-foreground">{data.files.length} file(s) parsed</span>
            <span className="rounded border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground">
              {data.engine === 'wasm' ? 'WASM worker' : 'TypeScript'}
            </span>
          </div>

          {(data.warnings.length > 0 || fatalError) && (
            <div className="rounded-md border border-[#ffc09a]/40 bg-[#ffc09a]/10 px-4 py-3">
              {data.warnings.map((warning, index) => (
                <p key={index} className="font-mono text-[12px] leading-5 text-[#ffc09a]">{warning}</p>
              ))}
              {fatalError && <p className="font-mono text-[12px] leading-5 text-[#ff8f85]">{fatalError}</p>}
            </div>
          )}

          <div className="flex min-h-0 flex-1 flex-col gap-4 lg:flex-row">
            <FilterPanel
              filters={filters}
              onChange={setFilters}
              allUnits={data.units}
              hasKernel={data.hasKernel}
              unitCounts={allStats?.perUnit ?? new Map()}
              patternError={view?.patternError ?? null}
              span={{ min: allStats?.min ?? null, max: allStats?.max ?? null }}
              boots={data.boots}
            />
            <div className="flex min-h-[420px] min-w-0 flex-1 flex-col gap-3">
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1 font-mono text-[12px] text-muted-foreground">
                <span>
                  <span className="text-popover-foreground">{(view?.total ?? 0).toLocaleString()}</span>
                  {' '}/ {data.recordsCount.toLocaleString()} entries
                </span>
                {filtering && <span aria-live="polite">filtering…</span>}
                {filteredStats.min && filteredStats.max && (view?.total ?? 0) > 0 && (
                  <span>{formatTime(filteredStats.min)} → {formatTime(filteredStats.max)}</span>
                )}
                <ExportBar
                  getRecords={() => data && view ? filteredRecords(data, view) : Promise.resolve([])}
                  filters={effectiveFilters}
                  sourceName={sourceName}
                />
              </div>
              <LogTable
                pages={recordPages}
                pendingPages={pendingPages}
                total={view?.total ?? 0}
                pageSize={PAGE_SIZE}
                resetKey={view}
                onLoadPage={handleLoadPage}
                onSelect={(record) => void selectRecord(record)}
              />
            </div>
          </div>
          <RecordDetail record={selected} onClose={() => setSelected(null)} />
        </main>
      )}
    </div>
  )
}
