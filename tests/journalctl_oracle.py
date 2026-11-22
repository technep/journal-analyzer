#!/usr/bin/env python3
"""Compare generated modern journal fixtures with journalctl's independent parser."""
from __future__ import annotations

import json
from pathlib import Path
import shutil
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parent / "fixtures"
EXPECTED = [json.loads(line) for line in (ROOT / "expected.json").read_text().splitlines() if line]


def normalized(record: dict) -> dict:
    result = {}
    for key, value in record.items():
        if isinstance(value, list):
            result[key] = value[0] if value else ""
        else:
            result[key] = value
    return result


def main() -> None:
    if not shutil.which("journalctl"):
        raise SystemExit("journalctl is required for the independent oracle test")
    for codec in ("plain", "lz4", "zstd", "xz", "keyed"):
        with tempfile.TemporaryDirectory(prefix=f"journal-{codec}-") as directory:
            target = Path(directory) / f"{codec}.journal"
            # Native temporary storage also avoids mmap incompatibilities on FUSE mounts.
            shutil.copyfile(ROOT / f"{codec}.journal", target)
            completed = subprocess.run(
                ["journalctl", "--directory", directory, "-o", "json"],
                check=True,
                text=True,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
            )
            actual = [normalized(json.loads(line)) for line in completed.stdout.splitlines() if line]
            assert len(actual) == len(EXPECTED), f"{codec}: expected {len(EXPECTED)} records, got {len(actual)}"
            for index, (expected, observed) in enumerate(zip(EXPECTED, actual)):
                for key, value in expected.items():
                    assert observed.get(key) == value, (
                        f"{codec} record {index} field {key}: expected {value!r}, got {observed.get(key)!r}"
                    )
            print(f"ok {codec}.journal: {len(actual)} journalctl records match expected fields")


if __name__ == "__main__":
    main()
