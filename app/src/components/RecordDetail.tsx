import type { LogRecord } from '@/lib/journal'
import { formatTime, priorityName } from '@/lib/journal'

interface Props {
  record: LogRecord | null
  onClose: () => void
}

export default function RecordDetail({ record, onClose }: Props) {
  if (!record) return null

  const fieldEntries = record.fields
    ? Object.entries(record.fields).sort(([a], [b]) => a.localeCompare(b))
    : []

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Log entry details"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') onClose()
      }}
    >
      <div className="flex max-h-[85vh] w-full max-w-2xl flex-col rounded-lg border border-border bg-popover shadow-xl">
        <div className="flex items-center gap-3 border-b border-border px-5 py-3">
          <h2 className="font-mono text-sm font-semibold text-popover-foreground">
            log entry
          </h2>
          <span className="font-mono text-[12px] text-muted-foreground">
            {formatTime(record.ts)}
          </span>
          {record.priority !== null && (
            <span className={`prio-pill prio-${priorityName(record.priority)}`}>
              {priorityName(record.priority)}
            </span>
          )}
          <button
            type="button"
            className="btn-ghost ml-auto"
            onClick={onClose}
            autoFocus
          >
            Close
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-3">
          {fieldEntries.length === 0 ? (
            <p className="font-mono text-[13px] text-muted-foreground">
              {record.raw || record.message}
            </p>
          ) : (
            <table className="w-full border-collapse font-mono text-[12px] leading-6">
              <tbody>
                {fieldEntries.map(([field, values]) => (
                  <tr key={field} className="border-b border-border/40 align-top">
                    <td className="whitespace-nowrap py-1 pr-4 text-[#8ab2d1]">
                      {field}
                    </td>
                    <td className="break-all py-1 text-foreground">
                      {values.map((v, i) => (
                        <div key={i}>{v || <span className="text-muted-foreground">(empty)</span>}</div>
                      ))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  )
}
