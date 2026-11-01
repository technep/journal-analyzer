import { useCallback, useRef, useState } from 'react'

interface Props {
  onFile: (file: File) => void
  busy: boolean
  progress: string
}

export default function DropZone({ onFile, busy, progress }: Props) {
  const [dragOver, setDragOver] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  const handleFiles = useCallback(
    (files: FileList | null) => {
      const f = files?.[0]
      if (f) onFile(f)
    },
    [onFile],
  )

  return (
    <div
      role="button"
      tabIndex={0}
      aria-label="Upload a zip archive with journal logs"
      onClick={() => !busy && inputRef.current?.click()}
      onKeyDown={(e) => {
        if ((e.key === 'Enter' || e.key === ' ') && !busy) {
          e.preventDefault()
          inputRef.current?.click()
        }
      }}
      onDragOver={(e) => {
        e.preventDefault()
        setDragOver(true)
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        e.preventDefault()
        setDragOver(false)
        if (!busy) handleFiles(e.dataTransfer.files)
      }}
      className={`flex cursor-pointer flex-col items-center justify-center gap-4 rounded-lg border border-dashed px-6 py-16 text-center transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
        dragOver
          ? 'border-primary bg-primary/10'
          : 'border-border bg-card hover:border-muted-foreground/50'
      }`}
    >
      <svg
        aria-hidden="true"
        width="40"
        height="40"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="text-muted-foreground"
      >
        <path d="M21 8v13H3V8" />
        <path d="M1 3h22v5H1z" />
        <path d="M10 12h4" />
      </svg>
      {busy ? (
        <div className="flex flex-col items-center gap-3">
          <svg
            aria-hidden="true"
            className="h-6 w-6 animate-spin text-primary"
            viewBox="0 0 24 24"
            fill="none"
          >
            <circle
              cx="12"
              cy="12"
              r="10"
              stroke="currentColor"
              strokeWidth="3"
              className="opacity-20"
            />
            <path
              d="M12 2a10 10 0 0 1 10 10"
              stroke="currentColor"
              strokeWidth="3"
              strokeLinecap="round"
            />
          </svg>
          <p className="font-mono text-[13px] text-muted-foreground">{progress}</p>
        </div>
      ) : (
        <>
          <div>
            <p className="text-base font-medium text-popover-foreground">
              Drop a <span className="font-mono">.zip</span> of journal logs — or a
              single <span className="font-mono">.journal</span> /{' '}
              <span className="font-mono">.json</span> /{' '}
              <span className="font-mono">.log</span> file
            </p>
            <p className="mt-1 text-sm text-muted-foreground">
              everything is processed locally in your browser, including binary
              journal files
            </p>
          </div>
          <div className="rounded-md border border-border bg-background px-4 py-3 text-left font-mono text-[12px] leading-6 text-muted-foreground">
            <p># zip the journal directory from the target device:</p>
            <p>
              <span className="text-[#aaf7b3]">zip -r journal.zip /var/log/journal/</span>
            </p>
            <p># …or export text/JSON instead:</p>
            <p>
              <span className="text-[#aaf7b3]">journalctl -o json</span> &gt; logs.json
            </p>
          </div>
        </>
      )}
      <input
        ref={inputRef}
        type="file"
        accept=".zip,.journal,.json,.log,.txt,application/zip,application/x-zip-compressed"
        className="hidden"
        onChange={(e) => {
          handleFiles(e.target.files)
          e.target.value = ''
        }}
      />
    </div>
  )
}
