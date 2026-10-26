import { decryptFilename } from './crypto'
import { unzipFirst } from './zip'

// A depot manifest: every file the depot installs, its size and flags, and the chunks it is made
// of. A content server sends it zipped; inside is a run of sections, each a little-endian magic
// number and length followed by a protobuf message (steam-user's content_manifest.js). This reads
// them with a small protobuf reader of its own, not steam-user's protobufjs schema, so that every
// count and length is bounded as it is read: manifests come from the network, and a hostile one
// must fail rather than exhaust memory. File names may be encrypted with the depot key.

export class ManifestError extends Error {}

const PAYLOAD_MAGIC = 0x71f617d0
const METADATA_MAGIC = 0x1f4812be
const SIGNATURE_MAGIC = 0x1b81b817
const END_MAGIC = 0x32c415ab
const STEAM3_MAGIC = 0x16349781

/** The most a manifest may decompress to: the largest real ones are tens of megabytes. */
export const MAX_MANIFEST_BYTES = 512 * 1024 * 1024
const MAX_FILES = 1_000_000
const MAX_CHUNKS = 5_000_000
const MAX_NAME_BYTES = 4096

export interface ManifestChunk {
  /** The chunk's id: SHA-1 of its decompressed bytes, 20 bytes. */
  sha: Buffer
  /** Where it goes in its file. */
  offset: number
  /** cb_original: its decompressed size. */
  size: number
  /** cb_compressed: what the content server sends for it, encrypted. */
  compressedSize: number
}

export interface ManifestFile {
  name: string
  size: number
  flags: number
  linkTarget: string
  chunks: ManifestChunk[]
}

export interface Manifest {
  depotId: number
  /** The manifest's id (a uint64), in decimal. */
  manifestId: string
  filenamesEncrypted: boolean
  files: ManifestFile[]
}

/** Steam's flags for a manifest entry (EDepotFileFlag). */
export const FileFlag = {
  Executable: 32,
  Directory: 64,
  Symlink: 512
} as const

class Reader {
  pos: number

  constructor(
    private readonly data: Uint8Array,
    start = 0,
    readonly end = data.length
  ) {
    this.pos = start
  }

  get done(): boolean {
    return this.pos >= this.end
  }

  private byte(): number {
    if (this.pos >= this.end) throw new ManifestError('The manifest is truncated')
    return this.data[this.pos++]
  }

  /** A varint as a number; one over 2^53 can't be a size or offset NetFuse can address. */
  varint(): number {
    let result = 0
    let scale = 1
    for (let i = 0; i < 10; i++) {
      const byte = this.byte()
      result += (byte & 0x7f) * scale
      if ((byte & 0x80) === 0) {
        if (!Number.isSafeInteger(result)) throw new ManifestError('A manifest value is too large')
        return result
      }
      scale *= 128
    }
    throw new ManifestError('The manifest has a malformed number')
  }

  /** A varint as an exact uint64, for ids. */
  bigVarint(): bigint {
    let result = 0n
    for (let i = 0n; i < 10n; i++) {
      const byte = this.byte()
      result |= BigInt(byte & 0x7f) << (7n * i)
      if ((byte & 0x80) === 0) return BigInt.asUintN(64, result)
    }
    throw new ManifestError('The manifest has a malformed number')
  }

  fixed32(): number {
    if (this.pos + 4 > this.end) throw new ManifestError('The manifest is truncated')
    const d = this.data
    const p = this.pos
    this.pos += 4
    return (d[p] | (d[p + 1] << 8) | (d[p + 2] << 16) | (d[p + 3] << 24)) >>> 0
  }

  /** A length-delimited field's bounds; the reader moves past it. */
  delimited(): { start: number; end: number } {
    const length = this.varint()
    const start = this.pos
    if (length > this.end - start) throw new ManifestError('The manifest is truncated')
    this.pos += length
    return { start, end: start + length }
  }

  bytes(): Buffer {
    const { start, end } = this.delimited()
    return Buffer.from(this.data.subarray(start, end))
  }

  string(maxBytes = MAX_NAME_BYTES): string {
    const { start, end } = this.delimited()
    if (end - start > maxBytes) throw new ManifestError('A name in the manifest is too long')
    return Buffer.from(this.data.subarray(start, end)).toString('utf8')
  }

  sub(): Reader {
    const { start, end } = this.delimited()
    return new Reader(this.data, start, end)
  }

  /** Steps over a field of `wireType` this reader doesn't use. */
  skip(wireType: number): void {
    if (wireType === 0) this.varint()
    else if (wireType === 1) this.advance(8)
    else if (wireType === 2) this.delimited()
    else if (wireType === 5) this.advance(4)
    else throw new ManifestError('The manifest has a malformed field')
  }

  private advance(bytes: number): void {
    if (this.pos + bytes > this.end) throw new ManifestError('The manifest is truncated')
    this.pos += bytes
  }

  /** The next field's number and wire type. */
  tag(): { field: number; wireType: number } {
    const tag = this.varint()
    return { field: Math.floor(tag / 8), wireType: tag % 8 }
  }
}

function expectWire(actual: number, wanted: number): void {
  if (actual !== wanted) throw new ManifestError('The manifest has a malformed field')
}

function readChunk(reader: Reader): ManifestChunk {
  const chunk: ManifestChunk = { sha: Buffer.alloc(0), offset: 0, size: 0, compressedSize: 0 }
  while (!reader.done) {
    const { field, wireType } = reader.tag()
    if (field === 1) {
      expectWire(wireType, 2)
      chunk.sha = reader.bytes()
    } else if (field === 3) {
      expectWire(wireType, 0)
      chunk.offset = reader.varint()
    } else if (field === 4) {
      expectWire(wireType, 0)
      chunk.size = reader.varint()
    } else if (field === 5) {
      expectWire(wireType, 0)
      chunk.compressedSize = reader.varint()
    } else {
      // crc (2) included: the SHA-1 is what each chunk is checked against.
      reader.skip(wireType)
    }
  }
  if (chunk.sha.length !== 20) throw new ManifestError('A chunk in the manifest has no valid id')
  return chunk
}

function readFile(reader: Reader, counts: { chunks: number }): ManifestFile {
  const file: ManifestFile = { name: '', size: 0, flags: 0, linkTarget: '', chunks: [] }
  while (!reader.done) {
    const { field, wireType } = reader.tag()
    if (field === 1) {
      expectWire(wireType, 2)
      file.name = reader.string()
    } else if (field === 2) {
      expectWire(wireType, 0)
      file.size = reader.varint()
    } else if (field === 3) {
      expectWire(wireType, 0)
      file.flags = reader.varint()
    } else if (field === 6) {
      expectWire(wireType, 2)
      if (++counts.chunks > MAX_CHUNKS) throw new ManifestError('The manifest has too many chunks')
      file.chunks.push(readChunk(reader.sub()))
    } else if (field === 7) {
      expectWire(wireType, 2)
      file.linkTarget = reader.string()
    } else {
      // sha_filename (4) and sha_content (5): chunks are checked one by one instead.
      reader.skip(wireType)
    }
  }
  return file
}

function readPayload(reader: Reader): ManifestFile[] {
  const files: ManifestFile[] = []
  const counts = { chunks: 0 }
  while (!reader.done) {
    const { field, wireType } = reader.tag()
    if (field === 1) {
      expectWire(wireType, 2)
      if (files.length >= MAX_FILES) throw new ManifestError('The manifest has too many files')
      files.push(readFile(reader.sub(), counts))
    } else {
      reader.skip(wireType)
    }
  }
  return files
}

function readMetadata(
  reader: Reader
): Pick<Manifest, 'depotId' | 'manifestId' | 'filenamesEncrypted'> {
  const metadata = { depotId: 0, manifestId: '0', filenamesEncrypted: false }
  while (!reader.done) {
    const { field, wireType } = reader.tag()
    if (field === 1) {
      expectWire(wireType, 0)
      metadata.depotId = reader.varint()
    } else if (field === 2) {
      expectWire(wireType, 0)
      metadata.manifestId = reader.bigVarint().toString()
    } else if (field === 4) {
      expectWire(wireType, 0)
      metadata.filenamesEncrypted = reader.varint() !== 0
    } else {
      reader.skip(wireType)
    }
  }
  return metadata
}

/** Reads a decompressed manifest. File names stay as they are; see decryptManifestNames. */
export function parseManifest(data: Uint8Array): Manifest {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  let pos = 0
  let files: ManifestFile[] | null = null
  let metadata: ReturnType<typeof readMetadata> | null = null
  // Steam ends every manifest with this marker: without it, a manifest cut off between two
  // sections would read as complete.
  let ended = false
  const sectionAt = (): { start: number; end: number } => {
    if (pos + 8 > data.length) throw new ManifestError('The manifest is truncated')
    const length = view.getUint32(pos + 4, true)
    const start = pos + 8
    if (length > data.length - start) throw new ManifestError('The manifest is truncated')
    pos = start + length
    return { start, end: start + length }
  }
  while (pos < data.length) {
    if (pos + 4 > data.length) throw new ManifestError('The manifest is truncated')
    const magic = view.getUint32(pos, true)
    if (magic === END_MAGIC) {
      pos += 4
      ended = true
    } else if (magic === PAYLOAD_MAGIC) {
      if (files) throw new ManifestError('The manifest has two file lists')
      const { start, end } = sectionAt()
      files = readPayload(new Reader(data, start, end))
    } else if (magic === METADATA_MAGIC) {
      const { start, end } = sectionAt()
      metadata = readMetadata(new Reader(data, start, end))
    } else if (magic === SIGNATURE_MAGIC) {
      // Not checked by steam-user either: nothing documents the key it is signed with.
      sectionAt()
    } else if (magic === STEAM3_MAGIC) {
      throw new ManifestError('This manifest is in an old format NetFuse can’t read')
    } else {
      throw new ManifestError('This is not a depot manifest')
    }
  }
  if (!files || !metadata || !ended) throw new ManifestError('The manifest is incomplete')
  return { ...metadata, files }
}

/** A manifest as the content server sends it: unzipped, then read. */
export function readManifest(zipped: Uint8Array): Manifest {
  let data: Buffer
  try {
    data = unzipFirst(zipped, MAX_MANIFEST_BYTES)
  } catch (error) {
    throw new ManifestError(`The manifest could not be unpacked: ${(error as Error).message}`)
  }
  return parseManifest(data)
}

/** Base64 of at least two 16-byte blocks (an IV and one of data): 44 or more characters. */
const ENCRYPTED_SHAPE = /^(?:[A-Za-z0-9+/]{4}){10,}(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/

/** Decrypts a manifest's file names, and its symlink targets, with the depot key, in place. */
export function decryptManifestNames(manifest: Manifest, key: Uint8Array): void {
  if (!manifest.filenamesEncrypted) return
  try {
    for (const file of manifest.files) file.name = decryptFilename(file.name, key)
  } catch {
    throw new ManifestError("The manifest's file names could not be decrypted with this depot key")
  }
  for (const file of manifest.files) {
    // Whether Steam encrypts link targets too isn't documented. One that is shaped like an
    // encrypted name (base64 of whole AES blocks) and decrypts was; anything else is used as
    // given. Either way it is checked like any other path (see layout.ts).
    if (!ENCRYPTED_SHAPE.test(file.linkTarget)) continue
    try {
      file.linkTarget = decryptFilename(file.linkTarget, key)
    } catch {
      // Not encrypted.
    }
  }
  manifest.filenamesEncrypted = false
}
