import { formatTime, priorityName } from '@/lib/journal'
import type { LogRecord } from '@/lib/journal'

const MAX_ROWS = 2000

interface Props {
  records: LogRecord[]
  total: number
  onSelect: (r: LogRecord) => void
}

export default function LogTable({ records, total, onSelect }: Props) {
  const shown = records.slice(0, MAX_ROWS)

  if (records.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center rounded-md border border-border bg-card p-12">
        <p className="font-mono text-[13px] text-muted-foreground">
          no entries match the current filters
        </p>
      </div>
    )
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-md border border-border bg-card">
      <div className="min-h-0 flex-1 overflow-auto">
        <table className="w-full border-collapse font-mono text-[12px] leading-5">
          <thead className="sticky top-0 z-10 bg-card">
            <tr className="border-b border-border text-left text-muted-foreground">
              <th className="whitespace-nowrap px-3 py-2 font-medium">time</th>
              <th className="whitespace-nowrap px-3 py-2 font-medium">unit</th>
              <th className="whitespace-nowrap px-3 py-2 font-medium">priority</th>
              <th className="px-3 py-2 font-medium">message</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((r, i) => {
              const prio = priorityName(r.priority) || 'unknown'
              return (
                <tr
                  key={i}
                  onClick={() => onSelect(r)}
                  title={r.fields ? 'click for all fields' : undefined}
                  className={`border-b border-border/40 transition-colors duration-100 hover:bg-accent/50 ${
                    r.fields ? 'cursor-pointer' : ''
                  }`}
                >
                  <td className="whitespace-nowrap px-3 py-1 text-muted-foreground">
                    {formatTime(r.ts) || '—'}
                  </td>
                  <td
                    className={`max-w-44 truncate whitespace-nowrap px-3 py-1 ${
                      r.unit === 'kernel' ? 'unit-kernel' : 'text-[#8ab2d1]'
                    }`}
                    title={r.unit}
                  >
                    {r.unit || '—'}
                  </td>
                  <td className="whitespace-nowrap px-3 py-1">
                    <span className={`prio-pill prio-${prio}`}>{prio}</span>
                  </td>
                  <td className="break-all px-3 py-1 text-foreground">
                    {r.message.length > 600 ? `${r.message.slice(0, 600)}…` : r.message}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      <div className="border-t border-border px-3 py-1.5 font-mono text-[11px] text-muted-foreground">
        {total.toLocaleString()} entries match
        {total > MAX_ROWS &&
          ` — showing first ${MAX_ROWS.toLocaleString()} (exports contain all)`}
      </div>
    </div>
  )
}
