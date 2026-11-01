import { useMemo, useState } from 'react'
import { PRIORITY_NAMES, formatTime } from '@/lib/journal'
import type { BootInfo, Filters } from '@/lib/journal'

interface Props {
  filters: Filters
  onChange: (f: Filters) => void
  allUnits: string[]
  hasKernel: boolean
  unitCounts: Map<string, number>
  patternError: string | null
  span: { min: Date | null; max: Date | null }
  boots: BootInfo[]
}

function toLocalInput(d: Date | null): string {
  if (!d) return ''
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

function fromLocalInput(v: string): Date | null {
  if (!v) return null
  const d = new Date(v)
  return Number.isNaN(d.getTime()) ? null : d
}

export default function FilterPanel({
  filters,
  onChange,
  allUnits,
  hasKernel,
  unitCounts,
  patternError,
  span,
  boots,
}: Props) {
  const [unitSearch, setUnitSearch] = useState('')

  const visibleUnits = useMemo(() => {
    const q = unitSearch.toLowerCase()
    return q ? allUnits.filter((u) => u.toLowerCase().includes(q)) : allUnits
  }, [allUnits, unitSearch])

  const set = (patch: Partial<Filters>) => onChange({ ...filters, ...patch })

  const toggleUnit = (u: string) => {
    const next = new Set(filters.units)
    if (next.has(u)) next.delete(u)
    else next.add(u)
    set({ units: next })
  }

  return (
    <aside className="flex w-full flex-col gap-5 lg:w-72 lg:shrink-0">
      {/* Time range */}
      <section>
        <div className="mb-2 flex items-baseline justify-between">
          <h2 className="section-label">Time range</h2>
          {span.min && span.max && (
            <button
              type="button"
              className="cursor-pointer font-mono text-[11px] text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              onClick={() => set({ since: span.min, until: span.max })}
            >
              full span
            </button>
          )}
        </div>
        <label className="mb-1 block font-mono text-[11px] text-muted-foreground">
          from
        </label>
        <input
          type="datetime-local"
          step={1}
          className="field mb-2"
          value={toLocalInput(filters.since)}
          onChange={(e) => set({ since: fromLocalInput(e.target.value) })}
        />
        <label className="mb-1 block font-mono text-[11px] text-muted-foreground">
          to
        </label>
        <input
          type="datetime-local"
          step={1}
          className="field"
          value={toLocalInput(filters.until)}
          onChange={(e) => set({ until: fromLocalInput(e.target.value) })}
        />
      </section>

      {/* Boot selection (qjournalctl-style) */}
      {boots.length > 1 && (
        <section>
          <h2 className="section-label mb-2">Boot</h2>
          <select
            className="field cursor-pointer"
            value={filters.bootId ?? 'all'}
            onChange={(e) =>
              set({ bootId: e.target.value === 'all' ? null : e.target.value })
            }
          >
            <option value="all">all boots</option>
            {boots.map((b) => (
              <option key={b.id} value={b.id}>
                boot {b.index}
                {b.index === boots.length - 1 ? ' (latest)' : ''} —{' '}
                {b.firstTs ? formatTime(b.firstTs) : b.id.slice(0, 8)} —{' '}
                {b.count} {b.count === 1 ? 'entry' : 'entries'}
              </option>
            ))}
          </select>
        </section>
      )}

      {/* Severity */}
      <section>
        <h2 className="section-label mb-2">Min severity</h2>
        <select
          className="field cursor-pointer"
          value={filters.maxPriority === null ? 'all' : String(filters.maxPriority)}
          onChange={(e) =>
            set({
              maxPriority:
                e.target.value === 'all' ? null : Number(e.target.value),
            })
          }
        >
          <option value="all">all priorities</option>
          {PRIORITY_NAMES.map((n, i) => (
            <option key={n} value={i}>
              {i} - {n}
              {i < 7 ? ' and above' : ''}
            </option>
          ))}
        </select>
      </section>

      {/* Pattern */}
      <section>
        <h2 className="section-label mb-2">Search pattern</h2>
        <input
          type="text"
          className={`field ${patternError ? 'border-destructive' : ''}`}
          placeholder="regex, e.g. fail|timeout"
          value={filters.pattern}
          onChange={(e) => set({ pattern: e.target.value })}
          spellCheck={false}
        />
        {patternError && (
          <p className="mt-1 font-mono text-[11px] text-destructive">
            invalid regex — pattern ignored
          </p>
        )}
        <label className="mt-2 flex cursor-pointer items-center gap-2 text-[13px]">
          <input
            type="checkbox"
            className="h-3.5 w-3.5 cursor-pointer accent-[#2474ff]"
            checked={filters.ignoreCase}
            onChange={(e) => set({ ignoreCase: e.target.checked })}
          />
          case insensitive
        </label>
      </section>

      {/* Units */}
      <section className="min-h-0">
        <div className="mb-2 flex items-baseline justify-between">
          <h2 className="section-label">Units</h2>
          <span className="font-mono text-[11px] text-muted-foreground">
            {filters.units.size === 0
              ? 'all'
              : `${filters.units.size} selected`}
          </span>
        </div>
        {hasKernel && (
          <label className="mb-2 flex cursor-pointer items-center gap-2 text-[13px]">
            <input
              type="checkbox"
              className="h-3.5 w-3.5 cursor-pointer accent-[#8ac1a0]"
              checked={filters.kernel}
              onChange={(e) => set({ kernel: e.target.checked })}
            />
            <span className="font-mono unit-kernel">kernel</span>
            <span className="text-muted-foreground">messages</span>
          </label>
        )}
        <input
          type="text"
          className="field mb-2"
          placeholder="filter units…"
          value={unitSearch}
          onChange={(e) => setUnitSearch(e.target.value)}
          spellCheck={false}
        />
        <div className="mb-2 flex gap-2">
          <button
            type="button"
            className="cursor-pointer font-mono text-[11px] text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            onClick={() => set({ units: new Set(allUnits) })}
          >
            select all
          </button>
          <button
            type="button"
            className="cursor-pointer font-mono text-[11px] text-muted-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            onClick={() => set({ units: new Set() })}
          >
            clear
          </button>
        </div>
        <div className="max-h-56 overflow-y-auto rounded-md border border-border bg-card p-1.5 lg:max-h-72">
          {visibleUnits.length === 0 && (
            <p className="p-2 font-mono text-[12px] text-muted-foreground">
              no units match
            </p>
          )}
          {visibleUnits.map((u) => (
            <label
              key={u}
              className="flex cursor-pointer items-center gap-2 rounded px-1.5 py-1 font-mono text-[12px] hover:bg-accent"
            >
              <input
                type="checkbox"
                className="h-3.5 w-3.5 shrink-0 cursor-pointer accent-[#2474ff]"
                checked={filters.units.has(u)}
                onChange={() => toggleUnit(u)}
              />
              <span className="truncate" title={u}>
                {u}
              </span>
              {unitCounts.has(u) && (
                <span className="ml-auto shrink-0 text-[11px] text-muted-foreground">
                  {unitCounts.get(u)}
                </span>
              )}
            </label>
          ))}
        </div>
      </section>

      <button
        type="button"
        className="btn-ghost"
        onClick={() =>
          onChange({
            since: null,
            until: null,
            units: new Set(),
            kernel: hasKernel,
            pattern: '',
            ignoreCase: true,
            maxPriority: null,
            bootId: null,
          })
        }
      >
        Reset filters
      </button>
    </aside>
  )
}
