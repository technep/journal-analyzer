import JSZip from 'jszip'
import { parseTar, parseTarGzip } from 'nanotar'
import type { SevenZipModule } from '7z-wasm'

export type ArchiveFormat = 'zip' | 'tar' | 'tar.gz' | '7z'
export type ArchivedLogKind = 'journal' | 'json' | 'text'

export interface ArchiveEntry {
  path: string
  kind: ArchivedLogKind
  bytes: Uint8Array
}

export interface ArchiveContents {
  entries: ArchiveEntry[]
  skipped: number
  fileReadMs: number
  extractionMs: number
}

type Progress = (message: string) => void
type FileLike = Pick<File, 'name' | 'type'>

export function archiveFormat(file: FileLike): ArchiveFormat | null {
  const name = file.name.toLowerCase()
  if (name.endsWith('.zip') || file.type === 'application/zip' || file.type === 'application/x-zip-compressed') return 'zip'
  if (name.endsWith('.tar.gz') || name.endsWith('.tgz')) return 'tar.gz'
  if (name.endsWith('.tar') || file.type === 'application/x-tar') return 'tar'
  if (name.endsWith('.7z') || file.type === 'application/x-7z-compressed') return '7z'
  return null
}

export function isArchiveFile(file: FileLike): boolean {
  return archiveFormat(file) !== null
}

function logKind(path: string): ArchivedLogKind | null {
  const lower = path.toLowerCase()
  if (lower.endsWith('.journal') || lower.endsWith('.journal~')) return 'journal'
  if (lower.endsWith('.json')) return 'json'
  if (lower.endsWith('.log') || lower.endsWith('.txt')) return 'text'
  return null
}

async function extractZip(file: File, progress: Progress): Promise<ArchiveContents> {
  progress('Reading ZIP archive…')
  let started = performance.now()
  const zip = await JSZip.loadAsync(file)
  const fileReadMs = performance.now() - started
  const selected: { path: string; kind: ArchivedLogKind }[] = []
  let skipped = 0

  zip.forEach((path, entry) => {
    if (entry.dir) return
    const kind = logKind(path)
    if (kind) selected.push({ path, kind })
    else skipped++
  })

  const entries: ArchiveEntry[] = []
  started = performance.now()
  for (const item of selected) {
    progress(`Extracting ${item.path}…`)
    const entry = zip.file(item.path)
    if (!entry) continue
    entries.push({ ...item, bytes: await entry.async('uint8array') })
  }
  return { entries, skipped, fileReadMs, extractionMs: performance.now() - started }
}

async function extractTar(file: File, gzip: boolean, progress: Progress): Promise<ArchiveContents> {
  progress(gzip ? 'Reading gzip-compressed TAR archive…' : 'Reading TAR archive…')
  let started = performance.now()
  const bytes = new Uint8Array(await file.arrayBuffer())
  const fileReadMs = performance.now() - started

  const entries: ArchiveEntry[] = []
  let skipped = 0
  started = performance.now()
  const filter = (item: { name: string; type?: string }) => {
    if (item.type !== 'file') return false
    const kind = logKind(item.name)
    if (!kind) {
      skipped++
      return false
    }
    return true
  }
  const items = gzip ? await parseTarGzip(bytes, { filter }) : parseTar(bytes, { filter })
  for (const item of items) {
    const kind = logKind(item.name)
    if (!kind) continue
    entries.push({ path: item.name, kind, bytes: item.data ?? new Uint8Array() })
  }
  return { entries, skipped, fileReadMs, extractionMs: performance.now() - started }
}

function collectedFiles(module: SevenZipModule, root: string): { path: string; kind: ArchivedLogKind | null }[] {
  const result: { path: string; kind: ArchivedLogKind | null }[] = []
  const walk = (directory: string) => {
    for (const name of module.FS.readdir(directory)) {
      if (name === '.' || name === '..') continue
      const path = `${directory}/${name}`
      const stat = module.FS.lstat(path)
      if (module.FS.isDir(stat.mode)) walk(path)
      else if (module.FS.isFile(stat.mode)) {
        result.push({ path: path.slice(root.length + 1), kind: logKind(path) })
      }
    }
  }
  walk(root)
  return result
}

async function extract7z(file: File, progress: Progress): Promise<ArchiveContents> {
  progress('Loading the 7-Zip decoder…')
  const started = performance.now()
  const [{ default: SevenZip }, { default: wasmUrl }] = await Promise.all([
    import('7z-wasm'),
    import('7z-wasm/7zz.wasm?url'),
  ])
  const errors: string[] = []
  const module = await SevenZip({
    noExitRuntime: true,
    locateFile: (path) => path.endsWith('.wasm') ? wasmUrl : path,
    print: () => {},
    printErr: (line) => {
      if (errors.length < 20) errors.push(line)
    },
  })

  progress('Reading 7z archive…')
  const input = '/journal-input.7z'
  const output = '/journal-output'
  module.FS.writeFile(input, new Uint8Array(await file.arrayBuffer()))
  module.FS.mkdir(output)
  try {
    progress('Extracting 7z archive…')
    // The runtime returns 7-Zip's status although the package declaration says void.
    const exitCode = module.callMain(['x', input, `-o${output}`, '-y']) as unknown as number
    if (exitCode !== 0) throw new Error(`7-Zip exited with status ${exitCode}`)
  } catch (error) {
    const detail = errors.filter(Boolean).join('\n')
    throw new Error(`Could not extract 7z archive${detail ? `: ${detail}` : ''}`, { cause: error })
  } finally {
    try { module.FS.unlink(input) } catch { /* Archive was not created completely. */ }
  }

  const entries: ArchiveEntry[] = []
  let skipped = 0
  for (const item of collectedFiles(module, output)) {
    if (!item.kind) {
      skipped++
      continue
    }
    entries.push({
      path: item.path,
      kind: item.kind,
      bytes: module.FS.readFile(`${output}/${item.path}`).slice(),
    })
  }
  return {
    entries,
    skipped,
    fileReadMs: 0,
    extractionMs: performance.now() - started,
  }
}

export async function extractArchive(file: File, progress: Progress): Promise<ArchiveContents> {
  const format = archiveFormat(file)
  if (format === 'zip') return extractZip(file, progress)
  if (format === 'tar') return extractTar(file, false, progress)
  if (format === 'tar.gz') return extractTar(file, true, progress)
  if (format === '7z') return extract7z(file, progress)
  throw new Error(`Unsupported archive format: ${file.name}`)
}
