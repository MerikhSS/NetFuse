import { readFile, rename, writeFile } from 'node:fs/promises'
import { promisify } from 'node:util'
import { gunzip, gzip } from 'node:zlib'
import { ChunkBook, type SavedChunks } from './cells'
import type { SteamLayout } from './layout'
import type { Manifest, ManifestFile } from './manifest'

// What a Steam download keeps beside its manifest.json, so that a restart can show it, and resume
// it, without asking Steam for its manifests again: the depots' manifests as they were read
// (decrypted, nothing secret in them), and which of the layout's chunks it fetches. Both are read
// back as anything from disk is: checked, and the layout worked out again from scratch, every path
// checked as on the first day.

const gzipAsync = promisify(gzip)
const gunzipAsync = promisify(gunzip)

/** What manifest.json keeps of a Steam download's progress (see ChunkBook). */
export interface SavedSteamProgress {
  chunks: SavedChunks
  /** Installed into an existing folder: the layout's files this download created. */
  created: number[]
  /** Base64 of the layout units it fetches (uint32 each); absent: all of them. */
  units?: string
}

type StoredChunk = [sha: string, offset: number, size: number, compressedSize: number]
type StoredFile = [
  name: string,
  size: number,
  flags: number,
  linkTarget: string,
  chunks: StoredChunk[]
]

interface StoredManifests {
  version: 1
  depots: { depotId: number; manifestId: string; files: StoredFile[] }[]
}

const isCount = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 0

function storedFile(file: ManifestFile): StoredFile {
  return [
    file.name,
    file.size,
    file.flags,
    file.linkTarget,
    file.chunks.map((chunk) => [
      chunk.sha.toString('hex'),
      chunk.offset,
      chunk.size,
      chunk.compressedSize
    ])
  ]
}

function readFileEntry(value: unknown): ManifestFile | null {
  if (!Array.isArray(value) || value.length !== 5) return null
  const [name, size, flags, linkTarget, chunks] = value as unknown[]
  if (
    typeof name !== 'string' ||
    !isCount(size) ||
    !isCount(flags) ||
    typeof linkTarget !== 'string'
  ) {
    return null
  }
  if (!Array.isArray(chunks)) return null
  const read: ManifestFile['chunks'] = []
  for (const chunk of chunks) {
    if (!Array.isArray(chunk) || chunk.length !== 4) return null
    const [sha, offset, chunkSize, compressedSize] = chunk as unknown[]
    if (typeof sha !== 'string' || !/^[0-9a-f]{40}$/.test(sha)) return null
    if (!isCount(offset) || !isCount(chunkSize) || !isCount(compressedSize)) return null
    read.push({ sha: Buffer.from(sha, 'hex'), offset, size: chunkSize, compressedSize })
  }
  return { name, size, flags, linkTarget, chunks: read }
}

/** Saves the manifests a download installs from, atomically. */
export async function writeManifests(path: string, manifests: readonly Manifest[]): Promise<void> {
  const stored: StoredManifests = {
    version: 1,
    depots: manifests.map((manifest) => ({
      depotId: manifest.depotId,
      manifestId: manifest.manifestId,
      files: manifest.files.map(storedFile)
    }))
  }
  const temporary = `${path}.tmp`
  await writeFile(temporary, await gzipAsync(JSON.stringify(stored)))
  await rename(temporary, path)
}

/** The manifests saved for a download, or null when they are missing or anything about them is
 * wrong. Throws only when the file can't be read for a reason that may pass (see restoreOne). */
export async function readManifests(path: string): Promise<Manifest[] | null> {
  let parsed: unknown
  try {
    parsed = JSON.parse((await gunzipAsync(await readFile(path))).toString('utf8'))
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    // Missing, or damaged (zlib's codes start Z_, and JSON's errors have none): as good as gone.
    // Anything else (a drive not mounted, a permission) may pass.
    if (code === 'ENOENT' || code?.startsWith('Z_') || error instanceof SyntaxError) return null
    throw error
  }
  const stored = parsed as Partial<StoredManifests> | null
  if (stored?.version !== 1 || !Array.isArray(stored.depots)) return null
  const manifests: Manifest[] = []
  for (const depot of stored.depots) {
    if (
      !isCount(depot?.depotId) ||
      typeof depot.manifestId !== 'string' ||
      !Array.isArray(depot.files)
    ) {
      return null
    }
    const files: ManifestFile[] = []
    for (const entry of depot.files) {
      const file = readFileEntry(entry)
      if (!file) return null
      files.push(file)
    }
    manifests.push({
      depotId: depot.depotId,
      manifestId: depot.manifestId,
      filenamesEncrypted: false,
      files
    })
  }
  return manifests
}

/** The layout units, as uint32s, in base64. */
export function encodeUnits(units: Uint32Array): string {
  return Buffer.from(units.buffer, units.byteOffset, units.byteLength).toString('base64')
}

/** The units `encoded` names, if they are distinct units of `layout`, in order. */
export function decodeUnits(encoded: string | undefined, layout: SteamLayout): Uint32Array | null {
  if (encoded === undefined) return Uint32Array.from(layout.units.keys())
  const bytes = Buffer.from(encoded, 'base64')
  if (bytes.length % 4 !== 0) return null
  const units = new Uint32Array(bytes.length / 4)
  for (let i = 0; i < units.length; i++) units[i] = bytes.readUInt32LE(i * 4)
  for (let i = 0; i < units.length; i++) {
    if (units[i] >= layout.units.length || (i > 0 && units[i] <= units[i - 1])) return null
  }
  return units
}

/** The book for fetching `units` of `layout`: each chunk's download size, in order. */
export function chunkBook(layout: SteamLayout, units: Uint32Array): ChunkBook {
  return new ChunkBook(Uint32Array.from(units, (unit) => layout.units[unit].compressedSize))
}
