import { useState } from 'react'
import type { Filters, LogRecord } from '@/lib/journal'
import { buildAiExport, buildJiraExport, downloadText } from '@/lib/exporters'

interface Props {
  records: LogRecord[]
  filters: Filters
  sourceName: string
}

export default function ExportBar({ records, filters, sourceName }: Props) {
  const [jiraOpen, setJiraOpen] = useState(false)
  const [jiraSummary, setJiraSummary] = useState('Journal log analysis - ')
  const [jiraDesc, setJiraDesc] = useState('')
  const [copied, setCopied] = useState<'ai' | 'jira' | null>(null)

  const copy = async (kind: 'ai' | 'jira', text: string) => {
    await navigator.clipboard.writeText(text)
    setCopied(kind)
    setTimeout(() => setCopied(null), 1500)
  }

  const aiText = () => buildAiExport(records, filters, sourceName)
  const jiraText = () =>
    buildJiraExport(records, filters, sourceName, jiraSummary, jiraDesc)

  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <span className="section-label mr-1">Export</span>
        <button
          type="button"
          className="btn-primary"
          onClick={() => downloadText('journal_ai_export.md', aiText())}
        >
          AI analysis .md
        </button>
        <button
          type="button"
          className="btn-ghost"
          onClick={() => copy('ai', aiText())}
        >
          {copied === 'ai' ? 'copied!' : 'copy AI export'}
        </button>
        <span className="mx-1 hidden h-4 w-px bg-border sm:inline-block" />
        <button type="button" className="btn-primary" onClick={() => setJiraOpen(true)}>
          Jira ticket…
        </button>
        <span className="w-full font-mono text-[11px] text-muted-foreground sm:ml-2 sm:w-auto">
          exports use the currently filtered entries
        </span>
      </div>

      {jiraOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
          role="dialog"
          aria-modal="true"
          aria-label="Jira ticket details"
          onClick={(e) => {
            if (e.target === e.currentTarget) setJiraOpen(false)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Escape') setJiraOpen(false)
          }}
        >
          <div className="w-full max-w-lg rounded-lg border border-border bg-popover p-5 shadow-xl">
            <h2 className="mb-4 font-mono text-sm font-semibold text-popover-foreground">
              Jira ticket details
            </h2>
            <label className="mb-1 block font-mono text-[11px] text-muted-foreground">
              summary
            </label>
            <input
              type="text"
              className="field mb-3"
              value={jiraSummary}
              onChange={(e) => setJiraSummary(e.target.value)}
              autoFocus
            />
            <label className="mb-1 block font-mono text-[11px] text-muted-foreground">
              description (optional)
            </label>
            <textarea
              className="field mb-4 h-28 resize-y font-sans"
              value={jiraDesc}
              onChange={(e) => setJiraDesc(e.target.value)}
            />
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                className="btn-primary"
                onClick={() => {
                  downloadText('jira_ticket.txt', jiraText())
                  setJiraOpen(false)
                }}
              >
                Save .txt
              </button>
              <button
                type="button"
                className="btn-ghost"
                onClick={() => copy('jira', jiraText())}
              >
                {copied === 'jira' ? 'copied!' : 'copy to clipboard'}
              </button>
              <button
                type="button"
                className="btn-ghost ml-auto"
                onClick={() => setJiraOpen(false)}
              >
                Cancel
              </button>
            </div>
            <p className="mt-3 font-mono text-[11px] text-muted-foreground">
              Jira wiki markup — paste into the Jira description field.
            </p>
          </div>
        </div>
      )}
    </>
  )
}
