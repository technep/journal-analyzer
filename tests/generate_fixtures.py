#!/usr/bin/env python3
"""Generate small, deterministic journal fixtures and optional benchmark corpora.

The binary writer intentionally emits only the objects needed by the app's read-only
entry-array traversal. Modern fixtures are also checked with journalctl by the test
suite; they are not presented as general-purpose journald writer output.
"""
from __future__ import annotations

import argparse
import io
import json
import lzma
from pathlib import Path
import struct
import tarfile
import zipfile

import lz4.block
import py7zr
import zstandard

BOOT_A = bytes.fromhex("00112233445566778899aabbccddeeff")
BOOT_B = bytes.fromhex("ffeeddccbbaa99887766554433221100")
FILE_ID = bytes.fromhex("0123456789abcdeffedcba9876543210")
MACHINE_ID = bytes.fromhex("11111111111111111111111111111111")
SEQNUM_ID = bytes.fromhex("22222222222222222222222222222222")


def align8(data: bytes) -> bytes:
    return data + b"\0" * (-len(data) % 8)


def object_header(kind: int, flags: int, size: int) -> bytes:
    return struct.pack("<BB6sQ", kind, flags, b"\0" * 6, size)


def compressed_payload(payload: bytes, codec: str) -> tuple[int, bytes]:
    if codec == "plain":
        return 0, payload
    if codec == "lz4":
        return 2, struct.pack("<Q", len(payload)) + lz4.block.compress(payload, store_size=False)
    if codec == "zstd":
        return 4, zstandard.ZstdCompressor(level=3).compress(payload)
    if codec == "xz":
        return 1, lzma.compress(payload, format=lzma.FORMAT_XZ)
    raise ValueError(codec)


def write_journal(path: Path, entries: list[dict], codec: str = "plain", *, legacy: bool = False, keyed: bool = False) -> None:
    header_size = 208 if legacy else 264
    incompatible = {"plain": 0, "xz": 1, "lz4": 2, "zstd": 8}[codec] | (4 if keyed else 0)
    data_objects: list[dict] = []
    for entry_index, entry in enumerate(entries):
        for name, value in entry["fields"]:
            payload = f"{name}={value}".encode()
            flags, stored = compressed_payload(payload, codec)
            payload_offset = 56 if legacy else 64
            size = payload_offset + len(stored)
            data_objects.append({
                "entry": entry_index,
                "flags": flags,
                "size": size,
                "payload": stored,
                "offset": 0,
                "entry_offset": 0,
            })

    entry_sizes = [64 + 16 * len(entry["fields"]) for entry in entries]
    array_size = 24 + 8 * len(entries)
    cursor = header_size
    hash_objects = []
    for kind in (4, 5):
        raw = object_header(kind, 0, 32) + b"\0" * 16
        hash_objects.append({"offset": cursor, "raw": raw})
        cursor += len(raw)
    for data in data_objects:
        data["offset"] = cursor
        cursor += len(align8(b"\0" * data["size"]))
    entry_offsets = []
    for size in entry_sizes:
        entry_offsets.append(cursor)
        cursor += len(align8(b"\0" * size))
    for data in data_objects:
        data["entry_offset"] = entry_offsets[data["entry"]]
    data_by_entry: list[list[dict]] = [[] for _ in entries]
    for data in data_objects:
        data_by_entry[data["entry"]].append(data)
    for items in data_by_entry:
        items.sort(key=lambda item: item["offset"])
    array_offset = cursor
    cursor += len(align8(b"\0" * array_size))
    file_size = cursor

    header = bytearray(header_size)
    header[:8] = b"LPKSHHRH"
    struct.pack_into("<I", header, 8, 2)  # TAIL_ENTRY_BOOT_ID
    struct.pack_into("<I", header, 12, incompatible)
    header[16] = 0  # offline
    header[24:40] = FILE_ID
    header[40:56] = MACHINE_ID
    header[56:72] = entries[-1].get("boot_id", BOOT_A) if entries else BOOT_A
    header[72:88] = SEQNUM_ID
    struct.pack_into("<Q", header, 88, header_size)
    struct.pack_into("<Q", header, 96, file_size - header_size)
    struct.pack_into("<Q", header, 104, hash_objects[0]["offset"] + 16)
    struct.pack_into("<Q", header, 112, 16)
    struct.pack_into("<Q", header, 120, hash_objects[1]["offset"] + 16)
    struct.pack_into("<Q", header, 128, 16)
    struct.pack_into("<Q", header, 136, array_offset)
    struct.pack_into("<Q", header, 144, 2 + len(data_objects) + len(entries) + 1)
    struct.pack_into("<Q", header, 152, len(entries))
    struct.pack_into("<Q", header, 160, len(entries))
    entry_array_header_offset = 168 if legacy else 176
    struct.pack_into("<Q", header, entry_array_header_offset, array_offset)
    if entries:
        struct.pack_into("<Q", header, 160 if legacy else 168, 1)
        realtime_offset = 176 if legacy else 184
        struct.pack_into("<Q", header, realtime_offset, entries[0]["realtime"])
        struct.pack_into("<Q", header, realtime_offset + 8, entries[-1]["realtime"])
        struct.pack_into("<Q", header, realtime_offset + 16, len(entries) * 1000)
    if not legacy:
        struct.pack_into("<Q", header, 208, len(data_objects))
        struct.pack_into("<Q", header, 216, 0)
        struct.pack_into("<Q", header, 224, 0)
        struct.pack_into("<Q", header, 232, 1)
        struct.pack_into("<I", header, 256, array_offset)
        struct.pack_into("<I", header, 260, len(entries))

    output = bytearray(header)
    for item in hash_objects:
        output += item["raw"]
    for data in data_objects:
        body = object_header(1, data["flags"], data["size"])
        body += b"\0" * 24  # hash, next_hash, next_field
        body += struct.pack("<Q", data["entry_offset"])
        if not legacy:
            body += b"\0" * 8  # entry_array_offset
        body += struct.pack("<Q", 1)  # n_entries
        body += data["payload"]
        assert len(body) == data["size"]
        output += align8(body)
    for index, (entry, offset) in enumerate(zip(entries, entry_offsets), 1):
        size = entry_sizes[index - 1]
        body = object_header(3, 0, size)
        body += struct.pack("<QQQ", index, entry["realtime"], index * 1000)
        body += entry.get("boot_id", BOOT_A)
        body += b"\0" * 8  # xor hash is not used by this read-only path
        items = data_by_entry[index - 1]
        for data in items:
            body += struct.pack("<QQ", data["offset"], 0)
        assert len(body) == size
        output += align8(body)
    array = object_header(6, 0, array_size) + b"\0" * 8
    array += b"".join(struct.pack("<Q", offset) for offset in entry_offsets)
    output += align8(array)
    assert len(output) == file_size
    path.write_bytes(output)


def sample_entries(count: int = 3) -> list[dict]:
    result = []
    for index in range(count):
        kernel = index % 11 == 10
        boot = BOOT_B if index % 7 == 6 else BOOT_A
        fields = [
            ("MESSAGE", f"message {index} " + ("timeout failure" if index % 5 == 4 else "ok")),
            ("_HOSTNAME", "edge-01"),
            ("_PID", str(index % 97)),
            ("PRIORITY", str(index % 8)),
            ("_BOOT_ID", "ffeeddccbbaa99887766554433221100" if boot == BOOT_B else "00112233445566778899aabbccddeeff"),
            ("_TRANSPORT", "kernel" if kernel else "journal"),
        ]
        if not kernel:
            fields.append(("_SYSTEMD_UNIT", ["init.service", "net.service", "sensor.service"][index % 3]))
        if index == 0:
            fields.append(("MESSAGE", "repeated second message"))
        result.append({"realtime": 1735689600000000 + index * 1_000_000, "boot_id": boot, "fields": fields})
    return result


def write_json(path: Path, entries: list[dict]) -> None:
    with path.open("w") as handle:
        for entry in entries:
            obj = {"__REALTIME_TIMESTAMP": str(entry["realtime"])}
            for name, value in entry["fields"]:
                if name in obj:
                    continue  # JSON smoke parity uses the first value for duplicated names only in binary fixtures.
                obj[name] = value
            handle.write(json.dumps(obj, separators=(",", ":")) + "\n")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, default=Path(__file__).parent / "fixtures")
    parser.add_argument("--benchmark", action="store_true")
    parser.add_argument("--entries", type=int, default=100_000)
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    entries = sample_entries()
    for codec in ("plain", "lz4", "zstd", "xz"):
        write_journal(args.output / f"{codec}.journal", entries, codec)
    write_journal(args.output / "legacy.journal", entries, legacy=True)
    write_journal(args.output / "keyed.journal", entries, keyed=True)
    large_entry = sample_entries(1)
    large_entry[0]["fields"][0] = ("MESSAGE", "large compressed payload " + "x" * 10_000)
    write_journal(args.output / "large-record.journal", large_entry, "xz")
    (args.output / "malformed.journal").write_bytes(b"not a journal")
    (args.output / "truncated.journal").write_bytes((args.output / "plain.journal").read_bytes()[:300])
    compact = bytearray((args.output / "plain.journal").read_bytes())
    struct.pack_into("<I", compact, 12, struct.unpack_from("<I", compact, 12)[0] | 16)
    (args.output / "compact.journal").write_bytes(compact)
    write_json(args.output / "expected.json", entries)
    write_json(args.output / "paged.json", sample_entries(1000))
    (args.output / "plain.log").write_text(
        "2025-01-01T00:00:00+00:00 edge-01 init.service[1]: started\n"
        "Jan  1 00:00:01 edge-01 net.service[2]: timeout failure\n",
        encoding="utf-8",
    )
    (args.output / "empty.json").write_text("", encoding="utf-8")
    archive_members = [
        *[
            (args.output / f"{codec}.journal", f"var/log/journal/demo/{codec}.journal")
            for codec in ("plain", "lz4", "zstd", "xz")
        ],
        (args.output / "plain.log", "extra/logs/plain.log"),
    ]
    with zipfile.ZipFile(args.output / "nested.zip", "w", zipfile.ZIP_DEFLATED) as archive:
        for source, name in archive_members:
            archive.write(source, name)
        archive.writestr("extra/ignored.bin", b"ignored")
    for name, mode in (("nested.tar", "w"), ("nested.tar.gz", "w:gz"), ("nested.tgz", "w:gz")):
        with tarfile.open(args.output / name, mode, format=tarfile.USTAR_FORMAT) as archive:
            for source, member_name in archive_members:
                info = archive.gettarinfo(str(source), member_name)
                info.uid = info.gid = 0
                info.uname = info.gname = ""
                info.mtime = 0
                with source.open("rb") as handle:
                    archive.addfile(info, handle)
            ignored = tarfile.TarInfo("extra/ignored.bin")
            ignored.size = len(b"ignored")
            ignored.mtime = 0
            archive.addfile(ignored, fileobj=io.BytesIO(b"ignored"))
    with py7zr.SevenZipFile(args.output / "nested.7z", "w") as archive:
        for source, member_name in archive_members:
            archive.write(source, member_name)
        archive.writestr(b"ignored", "extra/ignored.bin")
    (args.output / "malformed.7z").write_bytes(b"not a 7z archive")
    if args.benchmark:
        benchmark_entries = sample_entries(args.entries)
        write_json(args.output / "benchmark.json", benchmark_entries)
        write_journal(args.output / "benchmark.journal", benchmark_entries, "plain")
        with zipfile.ZipFile(args.output / "benchmark.zip", "w", zipfile.ZIP_DEFLATED) as archive:
            archive.write(args.output / "benchmark.journal", "var/log/journal/demo/benchmark.journal")
    print(f"Fixtures written to {args.output}")


if __name__ == "__main__":
    main()
