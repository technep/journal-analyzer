# journal://analyzer

Analyze systemd journal logs from **another machine** — 100% client-side, nothing ever leaves your browser.

Drop a zip of a journal directory (or a single `.journal` file) onto the page and get a fast, filterable log view with one-click exports for AI analysis and Jira bug tickets. No server, no install, no `journalctl` required on your machine — the app parses the **raw binary journal format** natively in JavaScript, the same files `qjournalctl` reads via libsystemd.

## Why

Debugging embedded devices, edge boxes, or customer machines usually means: someone sends you a dump of `/var/log/journal`, and you can't open it because your workstation isn't the same architecture / doesn't have a matching systemd / is running Windows. This tool turns those dumps into something immediately useful — in any modern browser, on any OS.

## Features

**Input**
- 📦 `.zip` archives — recursively finds journal content anywhere in the tree (`var/log/journal/…` or any folder layout)
- 🗜️ **Raw binary `.journal` / `.journal~` files** — full native parser: plain, **LZ4**, **ZSTD**, and **XZ** compressed objects, modern (v246+) and legacy header layouts, keyed-hash files
- 📄 Single files: `.journal`, `.json` (`journalctl -o json` export), `.log`, `.txt`

**Filtering** (all combinable)
- Time range (from/to) with full-span shortcut
- Boot selection — qjournalctl-style dropdown listing every boot chronologically
- Minimum severity (emerg → debug)
- Regex search with case-insensitive toggle
- Unit checkboxes with per-unit counts + kernel messages (additive)

**Inspection**
- Color-coded priority pills, distinct kernel highlighting
- Click any row → full record detail with **every journal field** (`_BOOT_ID`, `_TRANSPORT`, `_PID`, `_SYSTEMD_UNIT`, …)

**Exports** (operate on the filtered view)
- 🤖 **AI analysis report** (Markdown) — context, stats, error highlights, chronological excerpt; ready to paste into any LLM
- 🐞 **Jira ticket** — generates valid Jira wiki markup (`h2.`/`h3.`, `||tables||`, `{code}` blocks) with summary + description fields, one-click copy or `.txt` download

**Privacy**: all processing happens locally in your browser via JSZip + a hand-rolled journal parser. There is no backend.

## Quick start

### Use it (pre-built)

Serve the `dist/` folder with any static file server:

```bash
npx serve dist
# or
python3 -m http.server -d dist 8080
```

### Develop

Requires Node.js 18+ (20+ recommended).

```bash
npm ci
npm run dev      # → http://localhost:5173
npm run build    # production build → dist/
```

### Host it anywhere

The build is pure static files — host on any web server, S3, GitHub Pages, nginx, or open it inside your intranet.

## How it works

The parser (`src/lib/journalFile.ts`) implements the systemd journal file format (verified against systemd v252 sources):

- Reads the 264-byte header (`LPKSHHRH` signature), probes modern and legacy `entry_array_offset` locations
- Walks the entry-array chain → entry objects → per-field data objects
- Decompresses payloads per object flags: LZ4 block format (with journald's 8-byte size prefix), ZSTD frames (WASM via `zstddec`), XZ containers (`xz-decompress`)
- Accepts keyed-hash files (hash tables are never consulted); rejects compact-mode files with a clear remediation message (`journalctl --directory <path> -o json`)

Format quirks like exact object sizes vs. 8-aligned allocation, and the object-flag vs. header-flag bit layout difference for ZSTD, are handled and covered in the project's replication instructions.

## Desktop alternative

Prefer a native desktop GUI? A standalone Python/Tkinter version (Windows/Linux, standard library only) is included in `journal-log-analyzer/` — it uses `journalctl --directory` when available and falls back to parsing JSON/text exports.

## Tech stack

React 19 · TypeScript · Vite · Tailwind CSS · shadcn/ui · JSZip · zstddec · xz-decompress · hand-rolled LZ4 block decoder

## License

MIT
