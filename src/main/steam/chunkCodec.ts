import { createHash } from 'node:crypto'
import { crc32, zstdDecompressSync } from 'node:zlib'
import { symmetricDecrypt } from './crypto'
import { decodeLzma, lzmaProperties } from './lzma'
import { unzipFirst } from './zip'

// What a content server sends for one depot chunk, back to the bytes the manifest describes: the
// body is AES-encrypted with the depot key, and the plaintext is compressed one of three ways,
// told apart by its first bytes (steam-user's cdn_compression.js):
//
//   VZa   LZMA: "VZa", 4 bytes, 5 property bytes, the stream, then CRC32, size and "zv"
//   VSZa  zstd: "VSZa", 4 bytes, a zstd frame, then CRC32, size, 4 zero bytes and "zsv"
//   PK    a zip archive holding one file
//
// Nothing is trusted until every check passes: the size the manifest gives (which also bounds
// how far anything is decompressed, so a hostile chunk can't exhaust memory), the format's own
// CRC, and the SHA-1 that is the chunk's id. Only then may the bytes be written.

export class ChunkError extends Error {}

export interface ChunkExpectation {
  /** The chunk's id: the SHA-1 of its decompressed bytes. */
  sha: Uint8Array
  /** cb_original: its decompressed size. */
  size: number
}

const VZIP_HEADER = Buffer.from('VZa')
const VZIP_FOOTER = Buffer.from('zv')
const ZSTD_HEADER = Buffer.from('VSZa')
const ZSTD_FOOTER = Buffer.from('zsv')
const ZIP_HEADER = Buffer.from('PK\u0003\u0004', 'latin1')

function startsWith(data: Uint8Array, prefix: Uint8Array): boolean {
  return (
    data.length >= prefix.length && Buffer.compare(data.subarray(0, prefix.length), prefix) === 0
  )
}

function endsWith(data: Uint8Array, suffix: Uint8Array): boolean {
  return (
    data.length >= suffix.length &&
    Buffer.compare(data.subarray(data.length - suffix.length), suffix) === 0
  )
}

/** The footer's CRC32 and size, `footerBytes` from the end. */
function footer(data: Uint8Array, footerBytes: number): { crc: number; size: number } {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  const at = data.length - footerBytes
  return { crc: view.getUint32(at, true), size: view.getUint32(at + 4, true) }
}

/** Decompresses a decrypted chunk to at most `size` bytes, checking its format's own size and CRC. */
export function decompressChunk(data: Uint8Array, size: number): Buffer {
  if (startsWith(data, ZSTD_HEADER)) {
    // Header and its 4 bytes, then CRC, size, padding and footer.
    if (data.length < 8 + 15 || !endsWith(data, ZSTD_FOOTER)) {
      throw new ChunkError('A zstd chunk is malformed')
    }
    const expected = footer(data, 15)
    if (expected.size !== size) throw new ChunkError("A chunk's size doesn't match its manifest")
    let out: Buffer
    try {
      out = zstdDecompressSync(data.subarray(8, data.length - 15), {
        maxOutputLength: Math.max(1, size + 1)
      })
    } catch {
      throw new ChunkError('A zstd chunk could not be decompressed')
    }
    if (out.length !== size) throw new ChunkError("A chunk's size doesn't match its manifest")
    if (crc32(out) !== expected.crc) throw new ChunkError('A chunk failed its CRC check')
    return out
  }
  if (startsWith(data, VZIP_HEADER)) {
    // Header, 4 bytes and 5 property bytes, then CRC, size and footer.
    if (data.length < 12 + 10 || !endsWith(data, VZIP_FOOTER)) {
      throw new ChunkError('An LZMA chunk is malformed')
    }
    const expected = footer(data, 10)
    if (expected.size !== size) throw new ChunkError("A chunk's size doesn't match its manifest")
    let out: Buffer
    try {
      out = decodeLzma(
        data.subarray(0, data.length - 10),
        lzmaProperties(data.subarray(7, 12)),
        size,
        12
      )
    } catch {
      throw new ChunkError('An LZMA chunk could not be decompressed')
    }
    if (crc32(out) !== expected.crc) throw new ChunkError('A chunk failed its CRC check')
    return out
  }
  if (startsWith(data, ZIP_HEADER)) {
    let out: Buffer
    try {
      out = unzipFirst(data, size)
    } catch {
      throw new ChunkError('A zip chunk could not be decompressed')
    }
    if (out.length !== size) throw new ChunkError("A chunk's size doesn't match its manifest")
    return out
  }
  throw new ChunkError('A chunk is in an unknown format')
}

/** A chunk's body as the content server sent it, decrypted with `key`, decompressed and checked
 * against what the manifest expects. Throws a ChunkError (or the crypto module's error) on any
 * mismatch; the caller must never write a chunk that throws. */
export function decodeChunk(body: Uint8Array, key: Uint8Array, expected: ChunkExpectation): Buffer {
  let plain: Buffer
  try {
    plain = symmetricDecrypt(body, key)
  } catch {
    throw new ChunkError('A chunk could not be decrypted')
  }
  const out = decompressChunk(plain, expected.size)
  const sha = createHash('sha1').update(out).digest()
  if (Buffer.compare(sha, expected.sha) !== 0) {
    throw new ChunkError("A chunk doesn't match its checksum")
  }
  return out
}

/** Whether `data` is exactly the chunk whose id is `sha`: how files already on disk are checked. */
export function matchesChunk(data: Uint8Array, sha: Uint8Array): boolean {
  return Buffer.compare(createHash('sha1').update(data).digest(), sha) === 0
}
