# Journal Log Analyzer

Cross-platform (Windows / Linux) GUI tool to analyze systemd journal logs that
were copied **from another machine** (embedded device, server, customer system)
into a local folder. Pure Python 3 standard library — no dependencies to install.

## Run

```bash
python3 journal_log_analyzer.py        # Linux
py journal_log_analyzer.py             # Windows
```

## Supported log inputs

The tool picks the best backend automatically:

| Input in folder | Requirement | How it is read |
|---|---|---|
| Binary `*.journal` files (e.g. copied `/var/log/journal/`) | `journalctl` on the host (Linux or WSL) | `journalctl --directory <folder>` |
| `*.json` export | none | parsed directly — export on target with `journalctl -o json > logs.json` |
| `*.log` / `*.txt` export | none | parsed directly — export on target with `journalctl -o short-iso > logs.txt` (syslog-style lines also work) |

On a plain Windows host, simply transfer a JSON or text export from the target
device; everything else works identically.

## Features

1. **Load journal folder** — browse to the folder, click *Load folder*. The
   tool reports which backend it uses and how many units were found.
2. **Time filter (from / to)** — `YYYY-MM-DD HH:MM:SS`; *first* / *last*
   buttons fill the entries with the earliest / latest timestamps of the
   current result set.
3. **Unit filter** — multi-select list of all systemd service units present in
   the logs; nothing selected = all units. Kernel messages are included via the
   *Include kernel messages* checkbox (shown when kernel logs exist).
4. **Search pattern** — regular expression over message text (case-insensitive
   by default). Plain words work too.
5. **Severity filter** — minimum syslog priority (shows the selected level and
   everything more severe).
6. **AI analysis export** — Markdown file containing context, applied filters,
   statistics (entries per unit, priority distribution, notable error lines)
   and the filtered log. Paste it straight into an LLM prompt for further
   analysis. Capped at 8000 log lines (newest kept) with a truncation note.
7. **Jira ticket export** — Jira wiki markup (`h2.`/`h3.` headings, `||table||`
   statistics, `{code}` blocks with key errors and a log excerpt). Save it or
   copy it to the clipboard and paste into the Jira description field. A dialog
   lets you set the ticket summary and description first.

All exports reflect the **currently applied filters**, and long-running load /
filter operations run in the background so the GUI stays responsive.

## Typical workflow

1. On the target device: `journalctl -o json > logs.json` (or copy
   `/var/log/journal/`).
2. Transfer the file/folder to your Windows or Linux analysis machine.
3. Open the tool, load the folder, set time range / units / pattern.
4. Review the filtered table, then export the AI analysis file or Jira ticket.
