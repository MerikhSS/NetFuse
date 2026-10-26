import { symmetricEncrypt } from '@doctormckay/steam-crypto'
import * as LZMA from 'lzma'
import Schema from 'steam-user/protobufs/generated/_load.js'
import { createHash } from 'node:crypto'
import { crc32, deflateRawSync, zstdCompressSync } from 'node:zlib'

// Steam depot content built from scratch, the way Steam's own tools lay it out (as steam-user
// reads it): chunks compressed three ways and encrypted with a depot key, and zipped protobuf
// manifests listing files and their chunks. The unit specs check NetFuse's decoders against it, and
// the Steam test server (steamOrigin.ts) serves it.

export type Compression = 'lzma' | 'zstd' | 'zip'

const u32 = (value: number): Buffer => {
  const buffer = Buffer.alloc(4)
  buffer.writeUInt32LE(value >>> 0)
  return buffer
}

/** A one-entry zip archive, deflated: what manifests and the oldest chunks come as. */
export function zipOne(data: Buffer, name = 'z'): Buffer {
  const body = deflateRawSync(data)
  const crc = crc32(data)
  const fileName = Buffer.from(name)
  const local = Buffer.alloc(30)
  local.writeUInt32LE(0x04034b50, 0)
  local.writeUInt16LE(20, 4)
  local.writeUInt16LE(8, 8)
  local.writeUInt32LE(crc, 14)
  local.writeUInt32LE(body.length, 18)
  local.writeUInt32LE(data.length, 22)
  local.writeUInt16LE(fileName.length, 26)
  const central = Buffer.alloc(46)
  central.writeUInt32LE(0x02014b50, 0)
  central.writeUInt16LE(20, 4)
  central.writeUInt16LE(20, 6)
  central.writeUInt16LE(8, 10)
  central.writeUInt32LE(crc, 16)
  central.writeUInt32LE(body.length, 20)
  central.writeUInt32LE(data.length, 24)
  central.writeUInt16LE(fileName.length, 28)
  central.writeUInt32LE(0, 42)
  const directoryAt = local.length + fileName.length + body.length
  const directorySize = central.length + fileName.length
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(1, 8)
  end.writeUInt16LE(1, 10)
  end.writeUInt32LE(directorySize, 12)
  end.writeUInt32LE(directoryAt, 16)
  return Buffer.concat([local, fileName, body, central, fileName, end])
}

/** `data` compressed as a Steam chunk is: VZa (LZMA), VSZa (zstd) or a zip archive. */
export function compressChunk(data: Buffer, how: Compression): Buffer {
  if (how === 'zip') return zipOne(data)
  if (how === 'zstd') {
    return Buffer.concat([
      Buffer.from('VSZa'),
      u32(crc32(data)),
      zstdCompressSync(data),
      u32(crc32(data)),
      u32(data.length),
      Buffer.alloc(4),
      Buffer.from('zsv')
    ])
  }
  // LZMA-JS writes an "alone" stream: 5 property bytes, a uint64 size, then the data. VZip keeps
  // the properties and the data.
  const alone = Buffer.from(LZMA.compress(data, 1).map((byte) => byte & 0xff))
  return Buffer.concat([
    Buffer.from('VZa'),
    u32(Math.floor(Date.now() / 1000)),
    alone.subarray(0, 5),
    alone.subarray(13),
    u32(crc32(data)),
    u32(data.length),
    Buffer.from('zv')
  ])
}

export const sha1 = (data: Buffer): Buffer => createHash('sha1').update(data).digest()
export const sha256 = (data: Buffer): string => createHash('sha256').update(data).digest('hex')

/** A chunk as a content server sends it. */
export function encodeChunk(data: Buffer, key: Buffer, how: Compression): Buffer {
  return symmetricEncrypt(compressChunk(data, how), key)
}

export interface FixtureFile {
  name: string
  data?: Buffer
  /** EDepotFileFlag bits: 32 executable, 64 directory, 512 symlink. */
  flags?: number
  linkTarget?: string
}

export interface FixtureChunk {
  sha: Buffer
  plain: Buffer
  /** What the content server sends. */
  body: Buffer
}

export interface FixtureManifest {
  depotId: number
  manifestId: string
  /** The manifest as a content server sends it. */
  zipped: Buffer
  /** The manifest before zipping. */
  raw: Buffer
  /** By chunk SHA-1, hex. */
  chunks: Map<string, FixtureChunk>
}

export interface ManifestOptions {
  depotId: number
  manifestId: string
  key: Buffer
  files: FixtureFile[]
  chunkSize?: number
  encryptNames?: boolean
  /** How each chunk is compressed, by its index in the manifest: by default the three in turn. */
  compression?: (index: number) => Compression
}

const MAGIC = { payload: 0x71f617d0, metadata: 0x1f4812be, signature: 0x1b81b817, end: 0x32c415ab }

const section = (magic: number, body: Uint8Array): Buffer =>
  Buffer.concat([u32(magic), u32(body.length), Buffer.from(body)])

/** A depot manifest for `files`, cut into chunks of `chunkSize`, with every chunk's body. */
export function buildManifest(options: ManifestOptions): FixtureManifest {
  const { depotId, manifestId, key, chunkSize = 64 * 1024 } = options
  const compression =
    options.compression ??
    ((index: number): Compression => (['lzma', 'zstd', 'zip'] as const)[index % 3])
  const chunks = new Map<string, FixtureChunk>()
  let chunkIndex = 0
  const encryptName = (name: string): string =>
    options.encryptNames ? symmetricEncrypt(Buffer.from(`${name}\0`), key).toString('base64') : name
  const mappings = options.files.map((file) => {
    const data = file.data ?? Buffer.alloc(0)
    const fileChunks: object[] = []
    for (let offset = 0; offset < data.length; offset += chunkSize) {
      const plain = data.subarray(offset, offset + chunkSize)
      const sha = sha1(plain)
      const id = sha.toString('hex')
      let chunk = chunks.get(id)
      if (!chunk) {
        chunk = { sha, plain, body: encodeChunk(plain, key, compression(chunkIndex++)) }
        chunks.set(id, chunk)
      }
      fileChunks.push({
        sha,
        crc: 0,
        offset,
        cb_original: plain.length,
        cb_compressed: chunk.body.length
      })
    }
    return {
      filename: encryptName(file.name),
      size: data.length,
      flags: file.flags ?? 0,
      sha_filename: sha1(Buffer.from(file.name.toLowerCase())),
      sha_content: sha1(data),
      chunks: fileChunks,
      linktarget: file.linkTarget
    }
  })
  const payload = Schema.ContentManifestPayload.encode({ mappings }).finish()
  const metadata = Schema.ContentManifestMetadata.encode({
    depot_id: depotId,
    gid_manifest: manifestId,
    creation_time: 1_700_000_000,
    filenames_encrypted: !!options.encryptNames,
    unique_chunks: chunks.size
  }).finish()
  const signature = Schema.ContentManifestSignature.encode({ signature: Buffer.alloc(16) }).finish()
  const raw = Buffer.concat([
    section(MAGIC.payload, payload),
    section(MAGIC.metadata, metadata),
    section(MAGIC.signature, signature),
    u32(MAGIC.end)
  ])
  return { depotId, manifestId, zipped: zipOne(raw), raw, chunks }
}

/** Bytes from a seed (xorshift32), compressible or not. */
export function seeded(size: number, seed: number, compressible = false): Buffer {
  const out = Buffer.alloc(size)
  let x = seed >>> 0 || 1
  for (let i = 0; i < size; i++) {
    x ^= x << 13
    x ^= x >>> 17
    x ^= x << 5
    out[i] = compressible ? 97 + ((x >>> 0) % 4) : x & 0xff
  }
  return out
}
