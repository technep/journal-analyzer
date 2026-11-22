import { useEffect, useRef, useState } from 'react'
import type { FilterView } from '@/lib/engineTypes'
import { formatTime, priorityName } from '@/lib/journal'
import type { LogRecord } from '@/lib/journal'

const ROW_HEIGHT = 40
const OVERSCAN = 8
const GRID = 'grid grid-cols-[160px_140px_90px_minmax(300px,1fr)]'

export type PageDirection = 'backward' | 'forward' | 'jump'

interface Props {
  pages: ReadonlyMap<number, LogRecord[]>
  pendingPages: ReadonlySet<number>
  total: number
  pageSize: number
  resetKey: FilterView | null
  onLoadPage: (page: number, direction: PageDirection) => void
  onSelect: (record: LogRecord) => void
}

export default function LogTable({
  pages,
  pendingPages,
  total,
  pageSize,
  resetKey,
  onLoadPage,
  onSelect,
}: Props) {
  const viewportRef = useRef<HTMLDivElement>(null)
  const directionRef = useRef<PageDirection>('jump')
  const [scrollTop, setScrollTop] = useState(0)
  const [viewportHeight, setViewportHeight] = useState(600)
  const pageCount = Math.ceil(total / pageSize)

  useEffect(() => {
    const viewport = viewportRef.current
    if (!viewport) return
    const update = () => setViewportHeight(viewport.clientHeight)
    update()
    const observer = new ResizeObserver(update)
    observer.observe(viewport)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    directionRef.current = 'jump'
    viewportRef.current?.scrollTo({ top: 0 })
  }, [resetKey])

  const start = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN)
  const end = Math.min(
    total,
    Math.ceil((scrollTop + viewportHeight) / ROW_HEIGHT) + OVERSCAN,
  )
  const firstNeededPage = total > 0 ? Math.floor(start / pageSize) : 0
  const lastNeededPage = total > 0 ? Math.floor(Math.max(start, end - 1) / pageSize) : 0
  const currentPage = total > 0
    ? Math.min(pageCount - 1, Math.floor((scrollTop + viewportHeight / 2) / (pageSize * ROW_HEIGHT)))
    : 0

  useEffect(() => {
    for (let page = firstNeededPage; page <= lastNeededPage; page++) {
      onLoadPage(page, directionRef.current)
    }
  }, [firstNeededPage, lastNeededPage, onLoadPage])

  const goToPage = (page: number) => {
    const target = Math.max(0, Math.min(pageCount - 1, page))
    const top = target * pageSize * ROW_HEIGHT
    directionRef.current = 'jump'
    onLoadPage(target, 'jump')
    viewportRef.current?.scrollTo({ top })
    setScrollTop(top)
  }

  const pageNumbers = [...new Set([0, pageCount - 1, currentPage - 1, currentPage, currentPage + 1])]
    .filter((page) => page >= 0 && page < pageCount)
    .sort((a, b) => a - b)
  const pageStart = currentPage * pageSize + 1
  const pageEnd = Math.min(total, (currentPage + 1) * pageSize)

  if (total === 0) {
    return (
      <div className="flex flex-1 items-center justify-center rounded-md border border-border bg-card p-12">
        <p className="font-mono text-[13px] text-muted-foreground">
          no entries match the current filters
        </p>
      </div>
    )
  }

  return (
    <div className="flex h-[calc(100dvh-285px)] min-h-[420px] flex-col overflow-hidden rounded-md border border-border bg-card">
      <div
        ref={viewportRef}
        data-testid="entry-viewport"
        className="min-h-0 flex-1 overflow-auto"
        aria-busy={pendingPages.size > 0}
        onScroll={(event) => {
          const top = event.currentTarget.scrollTop
          directionRef.current = top >= scrollTop ? 'forward' : 'backward'
          setScrollTop(top)
        }}
      >
        <div className="min-w-[760px]" role="table" aria-rowcount={total} aria-label="Journal entries">
          <div className={`${GRID} sticky top-0 z-10 border-b border-border bg-card text-left font-mono text-[12px] text-muted-foreground`} role="row">
            <div className="px-3 py-2 font-medium" role="columnheader">time</div>
            <div className="px-3 py-2 font-medium" role="columnheader">unit</div>
            <div className="px-3 py-2 font-medium" role="columnheader">priority</div>
            <div className="px-3 py-2 font-medium" role="columnheader">message</div>
          </div>
          <div className="relative" style={{ height: total * ROW_HEIGHT }}>
            {Array.from({ length: Math.max(0, end - start) }, (_, offset) => {
              const index = start + offset
              const page = Math.floor(index / pageSize)
              const record = pages.get(page)?.[index % pageSize]
              if (!record) {
                return (
                  <div
                    key={`loading-${index}`}
                    role="row"
                    aria-rowindex={index + 1}
                    aria-label={`Loading entry ${index + 1}`}
                    className={`${GRID} absolute left-0 right-0 items-center border-b border-border/40`}
                    style={{ height: ROW_HEIGHT, transform: `translateY(${index * ROW_HEIGHT}px)` }}
                  >
                    <div className="col-span-4 px-3 font-mono text-[11px] text-muted-foreground">
                      loading entry {index + 1}…
                    </div>
                  </div>
                )
              }
              const priority = priorityName(record.priority) || 'unknown'
              return (
                <div
                  key={record.id ?? index}
                  role="row"
                  aria-rowindex={index + 1}
                  onClick={() => onSelect(record)}
                  title="click for all fields"
                  className={`${GRID} absolute left-0 right-0 cursor-pointer items-center border-b border-border/40 font-mono text-[12px] transition-colors duration-100 hover:bg-accent/50`}
                  style={{ height: ROW_HEIGHT, transform: `translateY(${index * ROW_HEIGHT}px)` }}
                >
                  <div className="truncate whitespace-nowrap px-3 text-muted-foreground" role="cell">
                    {formatTime(record.ts) || '—'}
                  </div>
                  <div
                    className={`truncate whitespace-nowrap px-3 ${record.unit === 'kernel' ? 'unit-kernel' : 'text-[#8ab2d1]'}`}
                    title={record.unit}
                    role="cell"
                  >
                    {record.unit || '—'}
                  </div>
                  <div className="whitespace-nowrap px-3" role="cell">
                    <span className={`prio-pill prio-${priority}`}>{priority}</span>
                  </div>
                  <div
                    className="truncate whitespace-nowrap px-3 text-foreground"
                    title={record.message.length > 600 ? `${record.message.slice(0, 600)}…` : record.message}
                    role="cell"
                  >
                    {record.message.length > 600 ? `${record.message.slice(0, 600)}…` : record.message}
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border px-3 py-2 font-mono text-[11px] text-muted-foreground">
        <span>
          {pageStart.toLocaleString()}–{pageEnd.toLocaleString()} of {total.toLocaleString()} entries
          {pendingPages.size > 0 && ' — loading…'}
        </span>
        <nav aria-label="Entry pages" className="flex flex-wrap items-center gap-1">
          <button
            type="button"
            aria-label="Previous page"
            className="btn-ghost px-2 py-1"
            disabled={currentPage === 0}
            onClick={() => goToPage(currentPage - 1)}
          >
            previous
          </button>
          {pageNumbers.map((page, index) => (
            <span key={page} className="flex items-center gap-1">
              {index > 0 && page - pageNumbers[index - 1] > 1 && <span aria-hidden="true">…</span>}
              <button
                type="button"
                aria-label={`Go to page ${page + 1}`}
                aria-current={page === currentPage ? 'page' : undefined}
                className={`min-w-7 rounded px-2 py-1 transition-colors ${
                  page === currentPage
                    ? 'bg-primary text-primary-foreground'
                    : 'text-muted-foreground hover:bg-accent hover:text-foreground'
                }`}
                onClick={() => goToPage(page)}
              >
                {page + 1}
              </button>
            </span>
          ))}
          <button
            type="button"
            aria-label="Next page"
            className="btn-ghost px-2 py-1"
            disabled={currentPage === pageCount - 1}
            onClick={() => goToPage(currentPage + 1)}
          >
            next
          </button>
        </nav>
        <span aria-label="Loaded page count">{pages.size} page{pages.size === 1 ? '' : 's'} cached</span>
      </div>
    </div>
  )
}
