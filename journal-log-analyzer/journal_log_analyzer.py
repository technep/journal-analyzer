#!/usr/bin/env python3
"""
Journal Log Analyzer
====================

Cross-platform (Windows / Linux) GUI tool to analyze systemd journal logs
that were copied from ANOTHER machine (e.g. an embedded device, a server,
a customer system) into a local folder.

Features
--------
* Load a journal log folder (raw *.journal files, JSON exports or text logs)
* Filter logs by time range (from / to)
* Filter by unit (one or more systemd service units, plus "kernel")
* Search by text / regex pattern
* Generate an AI-friendly analysis export (Markdown, ready to paste into an LLM)
* Generate a Jira-ready bug ticket (Jira wiki markup)

Backends
--------
1. journalctl backend  - if the ``journalctl`` binary is available (Linux,
   or WSL on Windows) and the folder contains binary ``*.journal`` files,
   logs are read with ``journalctl --directory <folder>``.
2. File backend        - otherwise the folder is scanned for:
     * ``*.json``   - output of ``journalctl -o json`` (one JSON object/line)
     * ``*.log`` / ``*.txt`` - output of ``journalctl -o short-iso`` or
       syslog-style lines
   This makes the tool fully usable on a plain Windows host: just export the
   logs on the target device, e.g.::

       journalctl -o json      > logs.json      # full structured export
       journalctl -o short-iso > logs.txt       # readable text export

   or copy the whole ``/var/log/journal/`` directory if you analyze on a
   Linux host (or WSL).

Only the Python 3 standard library is required.
"""

from __future__ import annotations

import json
import re
import shutil
import subprocess
import threading
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
import tkinter as tk
from tkinter import ttk, filedialog, messagebox

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

PRIORITY_NAMES = ["emerg", "alert", "crit", "err", "warning", "notice", "info", "debug"]
KERNEL_PSEUDO_UNIT = "kernel"          # pseudo unit shown in the unit list
MAX_TREE_ROWS = 5000                   # max rows rendered in the GUI table
AI_EXPORT_MAX_LINES = 8000             # max log lines in the AI export
JIRA_EXCERPT_LINES = 200               # log excerpt lines in the Jira ticket
JIRA_ERROR_LINES = 50                  # key error lines in the Jira ticket

ERROR_KEYWORDS = re.compile(
    r"\b(error|err|fail(ed|ure)?|crit(ical)?|panic|segfault|denied|"
    r"timeout|timed out|cannot|unable|exception|traceback|abort(ed)?|"
    r"core dump|oom|out of memory|watchdog)\b",
    re.IGNORECASE,
)

# ---------------------------------------------------------------------------
# Data model
# ---------------------------------------------------------------------------

@dataclass
class Record:
    ts: datetime | None
    host: str = ""
    unit: str = ""            # unit name, or KERNEL_PSEUDO_UNIT for kernel
    pid: str = ""
    priority: int | None = None
    message: str = ""
    raw: str = ""

    @property
    def time_str(self) -> str:
        return self.ts.strftime("%Y-%m-%d %H:%M:%S") if self.ts else ""

    @property
    def prio_str(self) -> str:
        if self.priority is None:
            return ""
        if 0 <= self.priority <= 7:
            return PRIORITY_NAMES[self.priority]
        return str(self.priority)


@dataclass
class Filters:
    since: datetime | None = None
    until: datetime | None = None
    units: list[str] = field(default_factory=list)   # service units only
    kernel: bool = False
    pattern: str = ""
    ignore_case: bool = True
    max_priority: int | None = None                  # keep prio <= max_priority


# ---------------------------------------------------------------------------
# Parsing helpers
# ---------------------------------------------------------------------------

def record_from_journal_json(obj: dict) -> Record:
    """Build a Record from one journalctl -o json object."""
    ts = None
    ts_raw = obj.get("__REALTIME_TIMESTAMP")
    if ts_raw:
        try:
            ts = datetime.fromtimestamp(int(ts_raw) / 1_000_000)
        except (ValueError, OSError, OverflowError):
            ts = None

    msg = obj.get("MESSAGE", "")
    if isinstance(msg, list):                        # binary-safe message
        msg = bytes(msg).decode("utf-8", "replace")
    msg = str(msg)

    transport = obj.get("_TRANSPORT", "")
    unit = obj.get("_SYSTEMD_UNIT", "") or obj.get("UNIT", "")
    if transport == "kernel" or not unit:
        if transport == "kernel":
            unit = KERNEL_PSEUDO_UNIT

    prio = obj.get("PRIORITY")
    try:
        prio = int(prio) if prio is not None else None
    except (TypeError, ValueError):
        prio = None

    return Record(
        ts=ts,
        host=str(obj.get("_HOSTNAME", "")),
        unit=str(unit),
        pid=str(obj.get("_PID", "")),
        priority=prio,
        message=msg,
        raw=msg,
    )


_ISO_RE = re.compile(
    r"^(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:[.,]\d+)?(?:[+-]\d{2}:?\d{2}|Z)?)"
    r"\s+(\S+)\s+(.*)$"
)
_SYSLOG_RE = re.compile(r"^([A-Z][a-z]{2}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2})\s+(\S+)\s+(.*)$")
_UNIT_RE = re.compile(r"^([A-Za-z0-9_.@\-]+?)(?:\[(\d+)\])?:\s+(.*)$")


def parse_text_line(line: str, default_year: int) -> Record:
    """Best-effort parse of one short-iso / syslog style text line."""
    line = line.rstrip("\n")
    ts, host, rest = None, "", line

    m = _ISO_RE.match(line)
    if m:
        ts_txt, host, rest = m.groups()
        ts_txt = ts_txt.replace("T", " ").replace(",", ".").replace("Z", "+0000")
        ts_txt = re.sub(r"([+-]\d{2}):?(\d{2})$", r"\1\2", ts_txt)
        for fmt in ("%Y-%m-%d %H:%M:%S.%f%z", "%Y-%m-%d %H:%M:%S%z",
                    "%Y-%m-%d %H:%M:%S.%f", "%Y-%m-%d %H:%M:%S"):
            try:
                parsed = datetime.strptime(ts_txt, fmt)
                ts = parsed.replace(tzinfo=None) if parsed.tzinfo else parsed
                break
            except ValueError:
                continue
    else:
        m = _SYSLOG_RE.match(line)
        if m:
            ts_txt, host, rest = m.groups()
            try:
                ts = datetime.strptime(f"{default_year} {ts_txt}", "%Y %b %d %H:%M:%S")
            except ValueError:
                ts = None

    unit, pid, msg = "", "", rest
    um = _UNIT_RE.match(rest)
    if um:
        unit, pid, msg = um.group(1), um.group(2) or "", um.group(3)
        if unit == KERNEL_PSEUDO_UNIT:
            pass                                    # keep pseudo unit
    return Record(ts=ts, host=host, unit=unit, pid=pid, message=msg, raw=line)


def parse_datetime_text(text: str) -> datetime | None:
    """Parse the GUI from/to entries. Returns None if empty, raises ValueError."""
    text = text.strip()
    if not text:
        return None
    for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M", "%Y-%m-%d",
                "%Y/%m/%d %H:%M:%S", "%Y/%m/%d"):
        try:
            return datetime.strptime(text, fmt)
        except ValueError:
            continue
    raise ValueError(f"Cannot parse date/time: {text!r}\n"
                     "Use e.g. 2024-05-01 14:30:00")


# ---------------------------------------------------------------------------
# Backend: journalctl or plain files
# ---------------------------------------------------------------------------

class JournalBackend:
    def __init__(self) -> None:
        self.folder: Path | None = None
        self.mode: str = ""                    # "journalctl" or "files"
        self.units: list[str] = []
        self.has_kernel: bool = False
        self.warnings: list[str] = []
        self._file_records: list[Record] = []  # cache for files mode

    # -- loading -----------------------------------------------------------

    def load(self, folder: str) -> None:
        self.folder = Path(folder)
        self.warnings = []
        self.units = []
        self.has_kernel = False
        self._file_records = []

        if not self.folder.is_dir():
            raise ValueError(f"Not a folder: {folder}")

        has_journal_files = any(self.folder.rglob("*.journal"))
        journalctl = shutil.which("journalctl")

        if has_journal_files and journalctl:
            self.mode = "journalctl"
            self._load_units_journalctl()
        else:
            self.mode = "files"
            if has_journal_files and not journalctl:
                self.warnings.append(
                    "Found binary *.journal files, but the 'journalctl' tool is "
                    "not available on this host. Binary journal files cannot be "
                    "read directly.\n\n"
                    "Either run this tool on a Linux host (or WSL), or export "
                    "the logs on the target device first, e.g.:\n"
                    "  journalctl -o json > logs.json\n"
                    "  journalctl -o short-iso > logs.txt"
                )
            self._load_files()
            self._collect_units_files()

    def _load_units_journalctl(self) -> None:
        out = self._run_journalctl(["-F", "_SYSTEMD_UNIT"])
        self.units = sorted({u.strip() for u in out.splitlines() if u.strip()})
        # detect kernel messages
        probe = self._run_journalctl(["-k", "-n", "1", "-o", "cat"])
        self.has_kernel = bool(probe.strip())

    def _load_files(self) -> None:
        records: list[Record] = []
        json_files, text_files = [], []
        for p in sorted(self.folder.rglob("*")):
            if not p.is_file():
                continue
            suf = p.suffix.lower()
            if suf == ".json":
                json_files.append(p)
            elif suf in (".log", ".txt"):
                text_files.append(p)

        for p in json_files:
            try:
                with open(p, "r", encoding="utf-8", errors="replace") as fh:
                    for line in fh:
                        line = line.strip()
                        if not line:
                            continue
                        try:
                            records.append(record_from_journal_json(json.loads(line)))
                        except json.JSONDecodeError:
                            year = datetime.fromtimestamp(p.stat().st_mtime).year
                            records.append(parse_text_line(line, year))
            except OSError as exc:
                self.warnings.append(f"Could not read {p}: {exc}")

        for p in text_files:
            year = datetime.fromtimestamp(p.stat().st_mtime).year
            try:
                with open(p, "r", encoding="utf-8", errors="replace") as fh:
                    for line in fh:
                        if line.strip():
                            records.append(parse_text_line(line, year))
            except OSError as exc:
                self.warnings.append(f"Could not read {p}: {exc}")

        records.sort(key=lambda r: (r.ts is None, r.ts or datetime.min))
        self._file_records = records

        if not records and not self.warnings:
            self.warnings.append(
                "No readable log files found in this folder.\n\n"
                "Supported inputs:\n"
                "  * a copied /var/log/journal directory (needs journalctl)\n"
                "  * *.json  - output of 'journalctl -o json'\n"
                "  * *.log / *.txt - output of 'journalctl -o short-iso' or syslog"
            )

    def _collect_units_files(self) -> None:
        units = set()
        for r in self._file_records:
            if r.unit == KERNEL_PSEUDO_UNIT:
                self.has_kernel = True
            elif r.unit:
                units.add(r.unit)
        self.units = sorted(units)

    # -- querying ----------------------------------------------------------

    def _run_journalctl(self, extra_args: list[str]) -> str:
        cmd = ["journalctl", "--directory", str(self.folder),
               "--no-pager", "--utc=false"] + extra_args
        proc = subprocess.run(cmd, capture_output=True, text=True,
                              errors="replace", timeout=300)
        if proc.returncode != 0 and not proc.stdout:
            raise RuntimeError(f"journalctl failed: {proc.stderr.strip()}")
        return proc.stdout

    def query(self, flt: Filters) -> list[Record]:
        if self.mode == "journalctl":
            records = self._query_journalctl(flt)
        else:
            records = self._query_files(flt)
        return self._post_filter(records, flt)

    def _query_journalctl(self, flt: Filters) -> list[Record]:
        base: list[str] = ["-o", "json"]
        if flt.since:
            base += ["--since", flt.since.strftime("%Y-%m-%d %H:%M:%S")]
        if flt.until:
            base += ["--until", flt.until.strftime("%Y-%m-%d %H:%M:%S")]
        if flt.max_priority is not None:
            base += ["-p", str(flt.max_priority)]

        outputs: list[str] = []
        if flt.kernel and flt.units:
            # -k and -u together would AND; run two queries and merge
            outputs.append(self._run_journalctl(
                base + [a for u in flt.units for a in ("-u", u)]))
            outputs.append(self._run_journalctl(base + ["-k"]))
        elif flt.kernel:
            outputs.append(self._run_journalctl(base + ["-k"]))
        elif flt.units:
            outputs.append(self._run_journalctl(
                base + [a for u in flt.units for a in ("-u", u)]))
        else:
            outputs.append(self._run_journalctl(base))

        records: list[Record] = []
        for out in outputs:
            for line in out.splitlines():
                line = line.strip()
                if not line:
                    continue
                try:
                    records.append(record_from_journal_json(json.loads(line)))
                except json.JSONDecodeError:
                    continue
        records.sort(key=lambda r: (r.ts is None, r.ts or datetime.min))
        return records

    def _query_files(self, flt: Filters) -> list[Record]:
        out = []
        want_units = set(flt.units)
        for r in self._file_records:
            if flt.since and r.ts and r.ts < flt.since:
                continue
            if flt.until and r.ts and r.ts > flt.until:
                continue
            if flt.max_priority is not None and r.priority is not None \
                    and r.priority > flt.max_priority:
                continue
            if r.unit == KERNEL_PSEUDO_UNIT:
                if not flt.kernel:
                    continue
            elif want_units and r.unit not in want_units:
                continue
            out.append(r)
        return out

    @staticmethod
    def _post_filter(records: list[Record], flt: Filters) -> list[Record]:
        if not flt.pattern:
            return records
        flags = re.IGNORECASE if flt.ignore_case else 0
        try:
            rx = re.compile(flt.pattern, flags)
        except re.error as exc:
            raise ValueError(f"Invalid search pattern: {exc}") from exc
        return [r for r in records if rx.search(r.raw) or rx.search(r.message)
                or rx.search(r.unit)]


# ---------------------------------------------------------------------------
# Export builders
# ---------------------------------------------------------------------------

def _fmt_line(r: Record) -> str:
    host = f" {r.host}" if r.host else ""
    unit = r.unit or "-"
    pid = f"[{r.pid}]" if r.pid else ""
    return f"{r.time_str}{host} {unit}{pid}: {r.message}"


def _stats(records: list[Record]) -> tuple[dict[str, int], dict[str, int]]:
    per_unit: dict[str, int] = {}
    per_prio: dict[str, int] = {}
    for r in records:
        per_unit[r.unit or "(none)"] = per_unit.get(r.unit or "(none)", 0) + 1
        key = r.prio_str or "unknown"
        per_prio[key] = per_prio.get(key, 0) + 1
    return per_unit, per_prio


def _filter_summary(flt: Filters) -> str:
    parts = []
    if flt.since:
        parts.append(f"from {flt.since:%Y-%m-%d %H:%M:%S}")
    if flt.until:
        parts.append(f"until {flt.until:%Y-%m-%d %H:%M:%S}")
    if flt.units:
        parts.append("units: " + ", ".join(flt.units))
    if flt.kernel:
        parts.append("kernel messages included")
    if flt.pattern:
        parts.append(f"pattern: /{flt.pattern}/"
                     + (" (case-insensitive)" if flt.ignore_case else ""))
    if flt.max_priority is not None:
        parts.append(f"priority <= {PRIORITY_NAMES[flt.max_priority]}")
    return "; ".join(parts) if parts else "no filters (all records)"


def build_ai_export(records: list[Record], flt: Filters,
                    backend: JournalBackend) -> str:
    """Markdown export structured for feeding into an AI / LLM for analysis."""
    per_unit, per_prio = _stats(records)
    times = [r.ts for r in records if r.ts]
    truncated = len(records) > AI_EXPORT_MAX_LINES
    shown = records[-AI_EXPORT_MAX_LINES:] if truncated else records
    errors = [r for r in records
              if (r.priority is not None and r.priority <= 4)
              or ERROR_KEYWORDS.search(r.message)]

    out: list[str] = []
    out.append("# Journal Log Analysis Export")
    out.append("")
    out.append("## Context")
    out.append(f"- Source folder: `{backend.folder}`")
    out.append(f"- Reader backend: {backend.mode}")
    out.append(f"- Exported at: {datetime.now():%Y-%m-%d %H:%M:%S}")
    out.append(f"- Filters applied: {_filter_summary(flt)}")
    out.append("")
    out.append("## Summary")
    out.append(f"- Total matching entries: {len(records)}")
    if times:
        out.append(f"- Time span: {min(times):%Y-%m-%d %H:%M:%S}  ->  "
                   f"{max(times):%Y-%m-%d %H:%M:%S}")
    out.append(f"- Entries matching common error keywords / priority <= warning: "
               f"{len(errors)}")
    out.append("")
    out.append("### Entries per unit")
    for unit, count in sorted(per_unit.items(), key=lambda kv: -kv[1]):
        out.append(f"- `{unit}`: {count}")
    out.append("")
    out.append("### Priority distribution")
    for prio, count in sorted(per_prio.items()):
        out.append(f"- {prio}: {count}")
    out.append("")
    if errors:
        out.append("### Notable error-like entries (first 30)")
        for r in errors[:30]:
            out.append(f"- `{r.time_str}` [{r.unit or '-'}] {r.message}")
        out.append("")
    out.append("## Log entries")
    if truncated:
        out.append(f"*Truncated: showing the last {len(shown)} of "
                   f"{len(records)} entries.*")
        out.append("")
    out.append("```text")
    out.extend(_fmt_line(r) for r in shown)
    out.append("```")
    out.append("")
    return "\n".join(out)


def build_jira_export(records: list[Record], flt: Filters,
                      backend: JournalBackend,
                      summary: str, description: str) -> str:
    """Jira wiki-markup ticket (paste into the Jira description field)."""
    per_unit, per_prio = _stats(records)
    times = [r.ts for r in records if r.ts]
    errors = [r for r in records
              if (r.priority is not None and r.priority <= 3)
              or ERROR_KEYWORDS.search(r.message)]
    excerpt = records[-JIRA_EXCERPT_LINES:]

    def code_block(lines) -> str:
        return "{code:text}\n" + "\n".join(lines) + "\n{code}"

    out: list[str] = []
    out.append(f"h2. {summary or 'Journal log analysis'}")
    out.append("")
    out.append("*Log source:* {{{{{}}}}}".format(str(backend.folder)))
    if times:
        out.append("*Log time range:* {{{{{} -> {}}}}}".format(
            f"{min(times):%Y-%m-%d %H:%M:%S}", f"{max(times):%Y-%m-%d %H:%M:%S}"))
    out.append("*Filters applied:* {}".format(_filter_summary(flt)))
    out.append("*Total matching entries:* {}".format(len(records)))
    out.append("")
    if description.strip():
        out.append("h3. Description")
        out.append(description.strip())
        out.append("")

    out.append("h3. Statistics")
    out.append("|| Unit || Entries ||")
    for unit, count in sorted(per_unit.items(), key=lambda kv: -kv[1]):
        out.append(f"| {unit} | {count} |")
    out.append("")
    out.append("|| Priority || Entries ||")
    for prio, count in sorted(per_prio.items()):
        out.append(f"| {prio} | {count} |")
    out.append("")

    if errors:
        out.append(f"h3. Key error entries (first "
                   f"{min(len(errors), JIRA_ERROR_LINES)} of {len(errors)})")
        out.append(code_block([_fmt_line(r) for r in errors[:JIRA_ERROR_LINES]]))
        out.append("")

    out.append(f"h3. Log excerpt (last {len(excerpt)} entries)")
    out.append(code_block([_fmt_line(r) for r in excerpt]))
    out.append("")
    out.append("----")
    out.append("_Generated by Journal Log Analyzer at "
               f"{datetime.now():%Y-%m-%d %H:%M:%S}_")
    return "\n".join(out)


# ---------------------------------------------------------------------------
# GUI
# ---------------------------------------------------------------------------

class JiraDialog(tk.Toplevel):
    """Small dialog asking for ticket summary + description."""

    def __init__(self, parent) -> None:
        super().__init__(parent)
        self.title("Jira ticket details")
        self.resizable(True, False)
        self.result: tuple[str, str] | None = None
        self.transient(parent)
        self.grab_set()

        ttk.Label(self, text="Ticket summary:").grid(
            row=0, column=0, sticky="w", padx=8, pady=(8, 2))
        self.summary_var = tk.StringVar(value="Journal log analysis - ")
        ttk.Entry(self, textvariable=self.summary_var, width=70).grid(
            row=0, column=1, sticky="ew", padx=8, pady=(8, 2))

        ttk.Label(self, text="Description\n(optional):").grid(
            row=1, column=0, sticky="nw", padx=8, pady=2)
        self.desc = tk.Text(self, width=70, height=6)
        self.desc.grid(row=1, column=1, sticky="ew", padx=8, pady=2)

        btns = ttk.Frame(self)
        btns.grid(row=2, column=0, columnspan=2, pady=8)
        ttk.Button(btns, text="Generate", command=self._ok).pack(side="left", padx=4)
        ttk.Button(btns, text="Cancel", command=self.destroy).pack(side="left", padx=4)
        self.columnconfigure(1, weight=1)
        self.wait_window()

    def _ok(self) -> None:
        self.result = (self.summary_var.get(), self.desc.get("1.0", "end"))
        self.destroy()


class App(tk.Tk):
    def __init__(self) -> None:
        super().__init__()
        self.title("Journal Log Analyzer")
        self.geometry("1150x760")

        self.backend = JournalBackend()
        self.records: list[Record] = []
        self.filters = Filters()
        self._last_ai = ""
        self._last_jira = ""
        self._busy = False

        self._build_widgets()

    # -- layout ------------------------------------------------------------

    def _build_widgets(self) -> None:
        # --- source row ---------------------------------------------------
        src = ttk.LabelFrame(self, text="1. Log source")
        src.pack(fill="x", padx=8, pady=(8, 4))

        ttk.Label(src, text="Folder:").pack(side="left", padx=(6, 2))
        self.folder_var = tk.StringVar()
        ttk.Entry(src, textvariable=self.folder_var).pack(
            side="left", fill="x", expand=True, padx=2, pady=6)
        ttk.Button(src, text="Browse...", command=self._browse).pack(side="left", padx=2)
        self.load_btn = ttk.Button(src, text="Load folder", command=self._load)
        self.load_btn.pack(side="left", padx=(2, 6))

        # --- filter row ---------------------------------------------------
        flt = ttk.LabelFrame(self, text="2. Filters")
        flt.pack(fill="x", padx=8, pady=4)

        time_fr = ttk.Frame(flt)
        time_fr.grid(row=0, column=0, sticky="nw", padx=6, pady=4)
        ttk.Label(time_fr, text="From:").grid(row=0, column=0, sticky="e")
        self.from_var = tk.StringVar()
        ttk.Entry(time_fr, textvariable=self.from_var, width=20).grid(
            row=0, column=1, padx=2)
        ttk.Label(time_fr, text="To:").grid(row=1, column=0, sticky="e")
        self.to_var = tk.StringVar()
        ttk.Entry(time_fr, textvariable=self.to_var, width=20).grid(
            row=1, column=1, padx=2)
        ttk.Button(time_fr, text="first", width=6,
                   command=lambda: self._fill_time(self.from_var, min)).grid(
            row=0, column=2, padx=2)
        ttk.Button(time_fr, text="last", width=6,
                   command=lambda: self._fill_time(self.to_var, max)).grid(
            row=1, column=2, padx=2)
        ttk.Label(time_fr, text="YYYY-MM-DD HH:MM:SS",
                  foreground="#666").grid(row=2, column=1, sticky="w")

        prio_fr = ttk.Frame(flt)
        prio_fr.grid(row=0, column=1, sticky="nw", padx=6, pady=4)
        ttk.Label(prio_fr, text="Min severity:").pack(anchor="w")
        self.prio_var = tk.StringVar(value="all")
        self.prio_combo = ttk.Combobox(
            prio_fr, textvariable=self.prio_var, state="readonly", width=18,
            values=["all"] + [f"{i} - {n}" for i, n in enumerate(PRIORITY_NAMES)])
        self.prio_combo.pack(anchor="w", pady=2)
        ttk.Label(prio_fr, text="(shows selected and\nmore severe levels)",
                  foreground="#666").pack(anchor="w")

        units_fr = ttk.Frame(flt)
        units_fr.grid(row=0, column=2, sticky="nw", padx=6, pady=4)
        ttk.Label(units_fr, text="Units (none selected = all):").pack(anchor="w")
        lb_fr = ttk.Frame(units_fr)
        lb_fr.pack()
        self.units_lb = tk.Listbox(lb_fr, selectmode="multiple",
                                   height=6, width=34, exportselection=False)
        sb = ttk.Scrollbar(lb_fr, orient="vertical", command=self.units_lb.yview)
        self.units_lb.configure(yscrollcommand=sb.set)
        self.units_lb.pack(side="left", fill="both")
        sb.pack(side="left", fill="y")
        ub = ttk.Frame(units_fr)
        ub.pack(anchor="w", pady=2)
        ttk.Button(ub, text="Select all", width=9,
                   command=lambda: self.units_lb.select_set(0, "end")).pack(side="left")
        ttk.Button(ub, text="Clear", width=7,
                   command=lambda: self.units_lb.selection_clear(0, "end")).pack(
            side="left", padx=2)

        pat_fr = ttk.Frame(flt)
        pat_fr.grid(row=0, column=3, sticky="nw", padx=6, pady=4)
        ttk.Label(pat_fr, text="Search pattern (regex):").pack(anchor="w")
        self.pattern_var = tk.StringVar()
        ttk.Entry(pat_fr, textvariable=self.pattern_var, width=34).pack(
            anchor="w", pady=2)
        self.icase_var = tk.BooleanVar(value=True)
        ttk.Checkbutton(pat_fr, text="Case insensitive",
                        variable=self.icase_var).pack(anchor="w")
        self.kernel_var = tk.BooleanVar(value=False)
        self.kernel_cb = ttk.Checkbutton(
            pat_fr, text="Include kernel messages", variable=self.kernel_var)
        self.kernel_cb.pack(anchor="w")

        btn_fr = ttk.Frame(flt)
        btn_fr.grid(row=0, column=4, sticky="nw", padx=10, pady=4)
        self.apply_btn = ttk.Button(btn_fr, text="Apply filters",
                                    command=self._apply_filters)
        self.apply_btn.pack(fill="x", pady=2)
        ttk.Button(btn_fr, text="Reset", command=self._reset_filters).pack(
            fill="x", pady=2)

        # --- results ------------------------------------------------------
        res = ttk.LabelFrame(self, text="3. Filtered log entries")
        res.pack(fill="both", expand=True, padx=8, pady=4)

        cols = ("time", "unit", "prio", "message")
        self.tree = ttk.Treeview(res, columns=cols, show="headings")
        self.tree.heading("time", text="Time")
        self.tree.heading("unit", text="Unit")
        self.tree.heading("prio", text="Priority")
        self.tree.heading("message", text="Message")
        self.tree.column("time", width=150, stretch=False)
        self.tree.column("unit", width=170, stretch=False)
        self.tree.column("prio", width=80, stretch=False)
        self.tree.column("message", width=600)
        vsb = ttk.Scrollbar(res, orient="vertical", command=self.tree.yview)
        hsb = ttk.Scrollbar(res, orient="horizontal", command=self.tree.xview)
        self.tree.configure(yscrollcommand=vsb.set, xscrollcommand=hsb.set)
        self.tree.grid(row=0, column=0, sticky="nsew")
        vsb.grid(row=0, column=1, sticky="ns")
        hsb.grid(row=1, column=0, sticky="ew")
        res.rowconfigure(0, weight=1)
        res.columnconfigure(0, weight=1)

        # --- export row ---------------------------------------------------
        exp = ttk.LabelFrame(self, text="4. Export")
        exp.pack(fill="x", padx=8, pady=4)
        ttk.Button(exp, text="Save AI analysis export...",
                   command=self._export_ai).pack(side="left", padx=6, pady=6)
        ttk.Button(exp, text="Copy AI export",
                   command=lambda: self._copy("ai")).pack(side="left", padx=2)
        ttk.Button(exp, text="Save Jira ticket...",
                   command=self._export_jira).pack(side="left", padx=(16, 2))
        ttk.Button(exp, text="Copy Jira ticket",
                   command=lambda: self._copy("jira")).pack(side="left", padx=2)
        ttk.Label(exp, text="(exports are based on the currently filtered "
                            "entries)", foreground="#666").pack(side="left", padx=12)

        # --- status bar ---------------------------------------------------
        self.status_var = tk.StringVar(value="Load a journal log folder to begin.")
        ttk.Label(self, textvariable=self.status_var, relief="sunken",
                  anchor="w").pack(fill="x", side="bottom")

    # -- helpers -----------------------------------------------------------

    def _fill_time(self, var: tk.StringVar, fn) -> None:
        times = [r.ts for r in self.records if r.ts]
        if times:
            var.set(fn(times).strftime("%Y-%m-%d %H:%M:%S"))

    def _browse(self) -> None:
        d = filedialog.askdirectory(title="Select journal log folder")
        if d:
            self.folder_var.set(d)

    def _set_busy(self, busy: bool, msg: str = "") -> None:
        self._busy = busy
        state = "disabled" if busy else "normal"
        self.load_btn.configure(state=state)
        self.apply_btn.configure(state=state)
        if msg:
            self.status_var.set(msg)
        self.update_idletasks()

    def _run_async(self, work, done) -> None:
        """Run work() in a thread, call done(result, error) in the GUI thread."""
        def runner():
            try:
                result = work()
                self.after(0, lambda: done(result, None))
            except Exception as exc:  # noqa: BLE001 - shown to the user
                self.after(0, lambda: done(None, exc))
        threading.Thread(target=runner, daemon=True).start()

    # -- actions -----------------------------------------------------------

    def _load(self) -> None:
        folder = self.folder_var.get().strip()
        if not folder:
            messagebox.showwarning("No folder", "Please choose a log folder first.")
            return
        self._set_busy(True, f"Loading {folder} ...")

        def work():
            self.backend.load(folder)
            return self.backend

        def done(_, err):
            self._set_busy(False)
            if err:
                self.status_var.set("Load failed.")
                messagebox.showerror("Load failed", str(err))
                return
            self._populate_units()
            n = (len(self.backend._file_records) if self.backend.mode == "files"
                 else None)
            msg = f"Loaded with backend '{self.backend.mode}'. "
            if n is not None:
                msg += f"{n} entries parsed. "
            msg += f"{len(self.backend.units)} units found"
            if self.backend.has_kernel:
                msg += " (+ kernel)"
            msg += ". Now apply filters."
            self.status_var.set(msg)
            if self.backend.warnings:
                messagebox.showwarning(
                    "Notes", "\n\n".join(self.backend.warnings))

        self._run_async(work, done)

    def _populate_units(self) -> None:
        self.units_lb.delete(0, "end")
        for u in self.backend.units:
            self.units_lb.insert("end", u)
        if self.backend.has_kernel:
            self.kernel_var.set(True)
            self.kernel_cb.configure(state="normal")
        else:
            self.kernel_var.set(False)
            self.kernel_cb.configure(state="disabled")

    def _collect_filters(self) -> Filters | None:
        try:
            since = parse_datetime_text(self.from_var.get())
            until = parse_datetime_text(self.to_var.get())
        except ValueError as exc:
            messagebox.showerror("Invalid time filter", str(exc))
            return None
        prio_sel = self.prio_var.get()
        max_prio = None if prio_sel == "all" else int(prio_sel.split(" ")[0])
        sel = [self.units_lb.get(i) for i in self.units_lb.curselection()]
        return Filters(
            since=since, until=until, units=sorted(sel),
            kernel=self.kernel_var.get() and self.backend.has_kernel,
            pattern=self.pattern_var.get().strip(),
            ignore_case=self.icase_var.get(),
            max_priority=max_prio,
        )

    def _apply_filters(self) -> None:
        if not self.backend.mode:
            messagebox.showwarning("No data", "Load a log folder first.")
            return
        flt = self._collect_filters()
        if flt is None:
            return
        self._set_busy(True, "Filtering ...")

        def work():
            return self.backend.query(flt)

        def done(records, err):
            self._set_busy(False)
            if err:
                self.status_var.set("Filter failed.")
                messagebox.showerror("Filter failed", str(err))
                return
            self.filters = flt
            self.records = records
            self._render_records()

        self._run_async(work, done)

    def _render_records(self) -> None:
        self.tree.delete(*self.tree.get_children())
        shown = self.records[:MAX_TREE_ROWS]
        for r in shown:
            msg = r.message if len(r.message) <= 800 else r.message[:800] + " ..."
            self.tree.insert("", "end",
                             values=(r.time_str, r.unit, r.prio_str, msg))
        msg = f"{len(self.records)} entries match the filters"
        if len(self.records) > MAX_TREE_ROWS:
            msg += f" (showing first {MAX_TREE_ROWS} in the table; " \
                   "exports contain all entries)"
        self.status_var.set(msg + ".")

    def _reset_filters(self) -> None:
        self.from_var.set("")
        self.to_var.set("")
        self.pattern_var.set("")
        self.icase_var.set(True)
        self.prio_var.set("all")
        self.units_lb.selection_clear(0, "end")
        if self.backend.has_kernel:
            self.kernel_var.set(True)

    def _require_records(self) -> bool:
        if not self.backend.mode:
            messagebox.showwarning("No data", "Load a log folder first.")
            return False
        if not self.records:
            return messagebox.askyesno(
                "No entries", "No entries match the current filters. "
                              "Export anyway?")
        return True

    def _export_ai(self) -> None:
        if not self._require_records():
            return
        self._last_ai = build_ai_export(self.records, self.filters, self.backend)
        path = filedialog.asksaveasfilename(
            title="Save AI analysis export",
            defaultextension=".md",
            initialfile="journal_ai_export.md",
            filetypes=[("Markdown", "*.md"), ("Text", "*.txt"), ("All", "*.*")])
        if path:
            Path(path).write_text(self._last_ai, encoding="utf-8")
            self.status_var.set(f"AI export saved to {path}")

    def _export_jira(self) -> None:
        if not self._require_records():
            return
        dlg = JiraDialog(self)
        if dlg.result is None:
            return
        summary, description = dlg.result
        self._last_jira = build_jira_export(
            self.records, self.filters, self.backend, summary, description)
        path = filedialog.asksaveasfilename(
            title="Save Jira ticket",
            defaultextension=".txt",
            initialfile="jira_ticket.txt",
            filetypes=[("Text", "*.txt"), ("All", "*.*")])
        if path:
            Path(path).write_text(self._last_jira, encoding="utf-8")
            self.status_var.set(f"Jira ticket saved to {path} - paste the "
                                "content into the Jira description field.")

    def _copy(self, kind: str) -> None:
        if not self._require_records():
            return
        if kind == "ai":
            text = build_ai_export(self.records, self.filters, self.backend)
        else:
            dlg = JiraDialog(self)
            if dlg.result is None:
                return
            text = build_jira_export(self.records, self.filters, self.backend,
                                     dlg.result[0], dlg.result[1])
        self.clipboard_clear()
        self.clipboard_append(text)
        self.status_var.set(f"{'AI export' if kind == 'ai' else 'Jira ticket'} "
                            "copied to clipboard.")


def main() -> None:
    app = App()
    app.mainloop()


if __name__ == "__main__":
    main()
