import { ZSTDDecoder } from 'zstddec'
import { XzReadableStream } from 'xz-decompress'

/**
 * Minimal reader for the systemd journal binary file format
 * (https://systemd.io/JOURNAL_FILE_FORMAT/).
 *
 * Walks the entry-array chain, resolves each entry's data objects and
 * decodes their payloads (plain, LZ4, ZSTD or XZ compressed). Hash
 * verification and sealing are intentionally skipped — this is a
 * read-only analysis tool.
 */

export interface JournalFieldMap {
  [field: string]: string[]
}

export interface ParsedEntry {
  realtimeUsec: number
  fields: JournalFieldMap
}

const OBJECT_DATA = 1
const OBJECT_ENTRY = 3
const OBJECT_ENTRY_ARRAY = 6

// Compression flag bits in ObjectHeader.flags (journal-def.h)
const COMPRESSED_XZ = 1 << 0
const COMPRESSED_LZ4 = 1 << 1
const COMPRESSED_ZSTD = 1 << 2
// Header incompatible flags (different bit layout than object flags:
// bit 2 there is keyed-hash, pushing zstd to bit 3)
const HEADER_INCOMPATIBLE_COMPACT = 1 << 4

// Header field offsets (all little-endian)
const HDR_INCOMPATIBLE_FLAGS = 12
const HDR_HEADER_SIZE = 88
// entry_array_offset moved in systemd v246: 176 (modern) vs 168 (legacy)
const HDR_ENTRY_ARRAY_OFFSET = 176
const HDR_ENTRY_ARRAY_OFFSET_LEGACY = 168

// Object layout offsets (relative to object start; ObjectHeader is 16 bytes)
// Modern DataObject (systemd >= v246): hash, next_hash, next_field,
// entry_offset, entry_array_offset, n_entries -> payload at 64.
// Legacy files (head_field_offset instead of entry_array_offset) put it at 56.
const DATA_PAYLOAD = 16 + 48
const DATA_PAYLOAD_LEGACY = 16 + 40
const ENTRY_REALTIME = 16 + 8 // after seqnum
const ENTRY_ITEMS = 16 + 48 // seqnum + realtime + monotonic + boot_id + xor_hash
const ENTRY_ITEM_SIZE = 16
const EARRAY_NEXT = 16
const EARRAY_ITEMS = 24

const FIELD_NAME_RE = /^[A-Z_][A-Z0-9_]*=/

let zstdDecoder: ZSTDDecoder | null = null

async function decompressPayload(
  flags: number,
  data: Uint8Array,
): Promise<Uint8Array> {
  if (flags & COMPRESSED_LZ4) {
    // journald LZ4 blob format (compress_blob_lz4 in compress.c):
    // le64 uncompressed size, then the LZ4_compress_default block.
    if (data.length <= 8) throw new JournalParseError('Truncated LZ4 payload')
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
    const size = Number(view.getBigUint64(0, true))
    return lz4DecompressBlock(data.subarray(8), size)
  }
  if (flags & COMPRESSED_ZSTD) {
    if (!zstdDecoder) {
      zstdDecoder = new ZSTDDecoder()
      await zstdDecoder.init()
    }
    return zstdDecoder.decode(data)
  }
  if (flags & COMPRESSED_XZ) {
    // slice() copies, so the Blob sees exactly this payload's buffer
    const stream = new XzReadableStream(new Blob([data.slice()]).stream())
    const buf = await new Response(stream).arrayBuffer()
    return new Uint8Array(buf)
  }
  return data
}

/**
 * Decompress one LZ4 block (the format produced by LZ4_compress_default,
 * which is what journald uses — no frame header). expectedSize is the
 * uncompressed length from the journald blob header; used as a sanity cap.
 */
function lz4DecompressBlock(src: Uint8Array, expectedSize?: number): Uint8Array {
  const out: number[] = []
  let i = 0
  while (i < src.length) {
    const token = src[i++]
    let litLen = token >> 4
    if (litLen === 15) {
      let s: number
      do {
        s = src[i++]
        litLen += s
      } while (s === 255)
    }
    for (let j = 0; j < litLen; j++) out.push(src[i++])
    if (i >= src.length) break // last sequence has no match
    const offset = src[i] | (src[i + 1] << 8)
    i += 2
    let matchLen = token & 0x0f
    if (matchLen === 15) {
      let s: number
      do {
        s = src[i++]
        matchLen += s
      } while (s === 255)
    }
    matchLen += 4
    const start = out.length - offset
    for (let j = 0; j < matchLen; j++) out.push(out[start + j])
  }
  const result = new Uint8Array(out)
  if (expectedSize !== undefined && result.length !== expectedSize) {
    throw new JournalParseError(
      `LZ4 payload size mismatch (got ${result.length}, expected ${expectedSize})`,
    )
  }
  return result
}

export class JournalParseError extends Error {}

export async function parseJournalFile(buf: ArrayBuffer): Promise<ParsedEntry[]> {
  const dv = new DataView(buf)
  const bytes = new Uint8Array(buf)

  const sig = new TextDecoder().decode(bytes.subarray(0, 8))
  if (sig !== 'LPKSHHRH') {
    throw new JournalParseError('Not a journal file (bad signature)')
  }
  const incompatible = dv.getUint32(HDR_INCOMPATIBLE_FLAGS, true)
  // Accept every v252 bit: xz(0), lz4(1), keyed-hash(2), zstd(3), compact(4).
  // Keyed-hash only changes how hash tables are computed — we never consult
  // hash tables, so keyed files parse identically. Compact is rejected below.
  if (incompatible & ~0b11111) {
    throw new JournalParseError(
      `Unsupported journal file (incompatible flags 0x${incompatible.toString(16)})`,
    )
  }
  if (incompatible & HEADER_INCOMPATIBLE_COMPACT) {
    throw new JournalParseError(
      'Journal file uses compact mode (not supported yet). ' +
        'Export it on the target: journalctl --directory <path> -o json > logs.json',
    )
  }

  const headerSize = Number(dv.getBigUint64(HDR_HEADER_SIZE, true))
  // journald itself requires at least offsetof(Header, n_data) = 208
  if (headerSize < 208 || headerSize > buf.byteLength) {
    throw new JournalParseError('Corrupt journal header')
  }

  const dataCache = new Map<number, { field: string; value: string } | null>()

  const readDataObject = async (
    offset: number,
  ): Promise<{ field: string; value: string } | null> => {
    if (dataCache.has(offset)) return dataCache.get(offset) ?? null
    let result: { field: string; value: string } | null = null
    try {
      const type = dv.getUint8(offset)
      if (type === OBJECT_DATA) {
        const flags = dv.getUint8(offset + 1)
        const size = Number(dv.getBigUint64(offset + 8, true))
        // Try the modern payload offset first, fall back to the legacy one;
        // a valid payload always looks like FIELD=value.
        for (const payloadOff of [DATA_PAYLOAD, DATA_PAYLOAD_LEGACY]) {
          if (size <= payloadOff || offset + size > buf.byteLength) continue
          const raw = bytes.subarray(offset + payloadOff, offset + size)
          const payload = await decompressPayload(flags, raw)
          const text = new TextDecoder('utf-8', { fatal: false }).decode(payload)
          if (FIELD_NAME_RE.test(text)) {
            const eq = text.indexOf('=')
            result = { field: text.slice(0, eq), value: text.slice(eq + 1) }
            break
          }
        }
      }
    } catch {
      result = null
    }
    dataCache.set(offset, result)
    return result
  }

  const entries: ParsedEntry[] = []
  // entry_array_offset moved in systemd v246 (176); probe both locations
  let arrayOffset = Number(dv.getBigUint64(HDR_ENTRY_ARRAY_OFFSET, true))
  const arrayOffsetOk = (o: number) =>
    o > 0 && o + 24 <= buf.byteLength && dv.getUint8(o) === OBJECT_ENTRY_ARRAY
  if (!arrayOffsetOk(arrayOffset)) {
    arrayOffset = Number(dv.getBigUint64(HDR_ENTRY_ARRAY_OFFSET_LEGACY, true))
  }
  if (!arrayOffsetOk(arrayOffset)) {
    throw new JournalParseError('No entry array found in journal file')
  }
  let arrayGuard = 0

  while (arrayOffset !== 0 && arrayGuard++ < 100_000) {
    if (dv.getUint8(arrayOffset) !== OBJECT_ENTRY_ARRAY) break
    const size = Number(dv.getBigUint64(arrayOffset + 8, true))
    if (size < EARRAY_ITEMS || arrayOffset + size > buf.byteLength) break

    const count = Math.floor((size - EARRAY_ITEMS) / 8)
    for (let i = 0; i < count; i++) {
      const entryOffset = Number(
        dv.getBigUint64(arrayOffset + EARRAY_ITEMS + i * 8, true),
      )
      if (entryOffset === 0) continue
      try {
        if (dv.getUint8(entryOffset) !== OBJECT_ENTRY) continue
        const entrySize = Number(dv.getBigUint64(entryOffset + 8, true))
        if (entrySize < ENTRY_ITEMS || entryOffset + entrySize > buf.byteLength)
          continue
        const realtimeUsec = Number(
          dv.getBigUint64(entryOffset + ENTRY_REALTIME, true),
        )
        const nItems = Math.floor((entrySize - ENTRY_ITEMS) / ENTRY_ITEM_SIZE)
        const fields: JournalFieldMap = {}
        for (let j = 0; j < nItems; j++) {
          const dataOffset = Number(
            dv.getBigUint64(entryOffset + ENTRY_ITEMS + j * ENTRY_ITEM_SIZE, true),
          )
          const data = await readDataObject(dataOffset)
          if (data) {
            if (fields[data.field]) fields[data.field].push(data.value)
            else fields[data.field] = [data.value]
          }
        }
        entries.push({ realtimeUsec, fields })
      } catch {
        // skip corrupt entry
      }
    }

    arrayOffset = Number(dv.getBigUint64(arrayOffset + EARRAY_NEXT, true))
  }

  entries.sort((a, b) => a.realtimeUsec - b.realtimeUsec)
  return entries
}
