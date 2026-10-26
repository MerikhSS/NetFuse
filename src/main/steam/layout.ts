import { posix } from 'node:path'
import { FileFlag, type Manifest } from './manifest'

// What a Steam download writes, worked out from its depots' manifests before anything is: every
// file and folder in the install, every symlink, and the chunks to fetch, each with every place it
// is written. A manifest's names come from the network (unsigned, often over plain HTTP), so
// every path is checked here: nothing may land outside the install folder, collide with another
// entry, or be unwritable on this system.
//
// Paths are kept with "/" between segments whatever the platform; a segment can never contain
// either separator, as both split a manifest's names.

export class UnsafeLayoutError extends Error {}

// eslint-disable-next-line no-control-regex -- control characters are exactly what is refused
const CONTROL = /[\u0000-\u001f\u007f]/
// Windows reserves CON.txt as well as CON.
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com\d|lpt\d|conin\$|conout\$)(\..*)?$/i
const WINDOWS_INVALID = /[<>:"|?*]|[. ]$/
const MAX_NAME_BYTES = 255
/** Steam's chunks are 1 MiB at most; anything far beyond that is a malformed manifest. */
const MAX_CHUNK_BYTES = 16 * 1024 * 1024

export type LayoutEntryKind = 'file' | 'directory' | 'symlink'

export interface LayoutFile {
  /** Relative to the install folder, "/" between segments. */
  path: string
  kind: LayoutEntryKind
  size: number
  executable: boolean
  /** A symlink's target, relative to the link's own folder, "/" between segments. */
  linkTarget?: string
  /** Ranges no chunk covers, which must read as zeros: [start, end) pairs. Rare; usually absent. */
  holes?: [number, number][]
}

export interface ChunkTarget {
  /** Index into SteamLayout.files. */
  file: number
  offset: number
}

/** One chunk to fetch, from one depot: written to every target once it is verified. */
export interface LayoutUnit {
  /** Index into SteamLayout.depots. */
  depot: number
  /** Hex. */
  sha: string
  size: number
  compressedSize: number
  targets: ChunkTarget[]
}

export interface SteamLayout {
  depots: { depotId: number; manifestId: string }[]
  files: LayoutFile[]
  units: LayoutUnit[]
  /** What the install takes on disk. */
  installBytes: number
  /** What has to be fetched: every unit's compressed size. */
  downloadBytes: number
}

const caseInsensitive = (platform: NodeJS.Platform): boolean =>
  platform === 'win32' || platform === 'darwin'

/** How two names compare on `platform`: Windows and macOS treat "A" and "a" as one, and macOS
 * also two Unicode spellings of the same name. */
function keyOf(name: string, platform: NodeJS.Platform): string {
  return caseInsensitive(platform) ? name.normalize('NFC').toLowerCase() : name
}

function checkSegment(segment: string, whole: string, platform: NodeJS.Platform): void {
  if (!segment || segment === '.' || segment === '..') {
    throw new UnsafeLayoutError(`This game has a file NetFuse can't save safely: ${whole}`)
  }
  if (CONTROL.test(segment)) {
    throw new UnsafeLayoutError(
      `This game has a file name NetFuse can't save: ${JSON.stringify(whole)}`
    )
  }
  if (Buffer.byteLength(segment) > MAX_NAME_BYTES) {
    throw new UnsafeLayoutError(`A name in this game is too long to save: ${segment}`)
  }
  if (platform === 'win32' && (WINDOWS_RESERVED.test(segment) || WINDOWS_INVALID.test(segment))) {
    throw new UnsafeLayoutError(`Windows can't save a file named ${segment}`)
  }
}

/** A manifest name's segments, checked. Both separators split it: Steam's Windows depots use "\". */
function segmentsOf(name: string, platform: NodeJS.Platform): string[] {
  const segments = name.split(/[\\/]/)
  // A trailing separator on a folder's name is the only empty segment allowed.
  if (segments.length > 1 && segments[segments.length - 1] === '') segments.pop()
  for (const segment of segments) checkSegment(segment, name, platform)
  return segments
}

/** A symlink's target, as long as it stays inside the install. */
function checkLinkTarget(link: string, target: string, platform: NodeJS.Platform): string {
  if (!target || CONTROL.test(target) || /^[\\/]/.test(target) || /^[a-zA-Z]:/.test(target)) {
    throw new UnsafeLayoutError(`A link in this game points outside it: ${link}`)
  }
  const normalized = target.split(/[\\/]/).join('/')
  const resolved = posix.normalize(posix.join(posix.dirname(link), normalized))
  if (resolved === '..' || resolved.startsWith('../') || posix.isAbsolute(resolved)) {
    throw new UnsafeLayoutError(`A link in this game points outside it: ${link}`)
  }
  for (const segment of resolved.split('/')) {
    if (segment !== '.' && segment !== '') checkSegment(segment, target, platform)
  }
  return normalized
}

/**
 * A link's target, walked as the file system will: "..", after a segment that is itself a link
 * in this install, steps out of wherever that link leads rather than back to where the walk was,
 * so a target that reads as inside the install ("L/../x" with L pointing at ".") could still lead
 * out of it. Such a target is refused; one that only goes through links (a macOS framework's
 * Versions/Current/…) is fine.
 */
function checkLinkWalk(
  link: Entry,
  entries: ReadonlyMap<string, Entry>,
  platform: NodeJS.Platform
): void {
  const walked = link.path.split('/').slice(0, -1)
  for (const segment of link.linkTarget!.split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') {
      const through = entries.get(keyOf(walked.join('/'), platform))
      if (walked.length === 0 || through?.kind === 'symlink') {
        throw new UnsafeLayoutError(`A link in this game points outside it: ${link.path}`)
      }
      walked.pop()
    } else {
      walked.push(segment)
    }
  }
}

interface Entry {
  path: string
  kind: LayoutEntryKind
  size: number
  executable: boolean
  linkTarget?: string
  depot: number
  chunks: Manifest['files'][number]['chunks']
}

/**
 * The install `manifests` add up to, in depot order: where two depots ship the same file, the
 * later one's copy is installed (a language depot replacing a base file, as Steam does). Throws an
 * UnsafeLayoutError when anything could escape the install folder or collide, and a plain Error on
 * a manifest whose chunks don't fit its files.
 */
export function buildLayout(
  manifests: readonly Manifest[],
  platform: NodeJS.Platform = process.platform
): SteamLayout {
  // By case-folded path: the entry, and the spelling the first depot to mention a folder used.
  const entries = new Map<string, Entry>()
  const spelled = new Map<string, string>()

  manifests.forEach((manifest, depot) => {
    if (manifest.filenamesEncrypted) throw new Error('A manifest’s file names are still encrypted')
    for (const file of manifest.files) {
      const segments = segmentsOf(file.name, platform)
      // On a case-insensitive system, folders that differ only in case are one folder: the first
      // spelling seen is the one used, as it is the one that would be on disk.
      const path = segments
        .map((segment, i) => {
          const key = keyOf(segments.slice(0, i + 1).join('/'), platform)
          const known = spelled.get(key)
          if (known !== undefined) return known.split('/')[i]
          spelled.set(key, [...segments.slice(0, i), segment].join('/'))
          return segment
        })
        .join('/')
      const kind: LayoutEntryKind =
        file.flags & FileFlag.Symlink
          ? 'symlink'
          : file.flags & FileFlag.Directory
            ? 'directory'
            : 'file'
      const key = keyOf(path, platform)
      const existing = entries.get(key)
      if (existing && existing.depot === depot && existing.kind !== 'directory') {
        throw new UnsafeLayoutError(
          `Two files in this game would be saved as the same file: ${path}`
        )
      }
      // A later depot's file replaces an earlier one's; a folder never replaces anything.
      if (existing && kind === 'directory') continue
      entries.set(key, {
        path,
        kind,
        size: kind === 'file' ? file.size : 0,
        executable: kind === 'file' && (file.flags & FileFlag.Executable) !== 0,
        linkTarget:
          kind === 'symlink' ? checkLinkTarget(path, file.linkTarget, platform) : undefined,
        depot,
        chunks: kind === 'file' ? file.chunks : []
      })
    }
  })

  // Every entry's folders are folders: not a file, and not a link (writing through a link the
  // manifest itself made could reach anywhere).
  for (const [key, entry] of entries) {
    const segments = key.split('/')
    for (let end = 1; end < segments.length; end++) {
      const parent = entries.get(segments.slice(0, end).join('/'))
      if (parent && parent.kind !== 'directory') {
        throw new UnsafeLayoutError(
          `A file in this game is inside something that isn't a folder: ${entry.path}`
        )
      }
    }
    if (entry.kind === 'symlink') checkLinkWalk(entry, entries, platform)
  }

  const sorted = [...entries.values()].sort((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : 0
  )
  const files: LayoutFile[] = []
  const units: LayoutUnit[] = []
  const unitByChunk = new Map<string, LayoutUnit>()
  let installBytes = 0
  let downloadBytes = 0

  for (const entry of sorted) {
    const index = files.length
    const layoutFile: LayoutFile = {
      path: entry.path,
      kind: entry.kind,
      size: entry.size,
      executable: entry.executable
    }
    if (entry.linkTarget !== undefined) layoutFile.linkTarget = entry.linkTarget
    files.push(layoutFile)
    installBytes += entry.size

    // Chunks in file order, and checked to fit: inside the file, and never overlapping one
    // another, since each is written whole at its offset.
    const chunks = [...entry.chunks].sort((a, b) => a.offset - b.offset)
    let covered = 0
    const holes: [number, number][] = []
    for (const chunk of chunks) {
      if (
        chunk.size <= 0 ||
        chunk.size > MAX_CHUNK_BYTES ||
        chunk.compressedSize <= 0 ||
        chunk.compressedSize > 2 * MAX_CHUNK_BYTES
      ) {
        throw new Error(`A chunk of ${entry.path} has an impossible size`)
      }
      if (chunk.offset < covered || chunk.offset + chunk.size > entry.size) {
        throw new Error(`The chunks of ${entry.path} don't fit the file`)
      }
      if (chunk.offset > covered) holes.push([covered, chunk.offset])
      covered = chunk.offset + chunk.size

      const sha = chunk.sha.toString('hex')
      const id = `${entry.depot}:${sha}`
      let unit = unitByChunk.get(id)
      if (!unit) {
        unit = {
          depot: entry.depot,
          sha,
          size: chunk.size,
          compressedSize: chunk.compressedSize,
          targets: []
        }
        unitByChunk.set(id, unit)
        units.push(unit)
        downloadBytes += chunk.compressedSize
      } else if (unit.size !== chunk.size) {
        throw new Error(`A chunk of ${entry.path} doesn't match its other copies`)
      }
      unit.targets.push({ file: index, offset: chunk.offset })
    }
    if (entry.kind === 'file' && covered < entry.size) holes.push([covered, entry.size])
    if (holes.length > 0) layoutFile.holes = holes
  }

  return {
    depots: manifests.map((manifest) => ({
      depotId: manifest.depotId,
      manifestId: manifest.manifestId
    })),
    files,
    units,
    installBytes,
    downloadBytes
  }
}
