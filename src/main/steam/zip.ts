import { crc32, inflateRawSync } from 'node:zlib'

// The first file in a zip archive: what Steam's oldest depot chunks are (a "PK" chunk) and what
// every manifest comes as. adm-zip, which steam-user uses, reads a whole archive with no limit
// on what it inflates to; this reads only the one entry Steam puts there, and never inflates
// past `maxBytes`, so a hostile archive can't exhaust memory.

export class ZipError extends Error {}

const LOCAL_HEADER = 0x04034b50
const CENTRAL_HEADER = 0x02014b50
const END_OF_CENTRAL = 0x06054b50
const STORED = 0
const DEFLATED = 8

interface Entry {
  method: number
  crc: number
  compressedSize: number
  size: number
  localHeader: number
}

/** The first entry, as the central directory describes it. Its sizes are reliable even when the
 * local header defers them to a data descriptor. Null when there is no central directory. */
function centralEntry(data: Uint8Array, view: DataView): Entry | null {
  // The end record sits in the last 22 bytes, or up to 64 KiB further in with a comment.
  const earliest = Math.max(0, data.length - 22 - 0xffff)
  for (let at = data.length - 22; at >= earliest; at--) {
    if (view.getUint32(at, true) !== END_OF_CENTRAL) continue
    const directory = view.getUint32(at + 16, true)
    if (directory + 46 > data.length || view.getUint32(directory, true) !== CENTRAL_HEADER) {
      throw new ZipError('The zip archive is damaged')
    }
    return {
      method: view.getUint16(directory + 10, true),
      crc: view.getUint32(directory + 16, true),
      compressedSize: view.getUint32(directory + 20, true),
      size: view.getUint32(directory + 24, true),
      localHeader: view.getUint32(directory + 42, true)
    }
  }
  return null
}

/** The first file in the zip archive `data`, at most `maxBytes` long once inflated. Throws a
 * ZipError on anything malformed, a method other than stored or deflate, a size over
 * `maxBytes`, or a CRC that doesn't match. */
export function unzipFirst(data: Uint8Array, maxBytes: number): Buffer {
  if (data.length < 30) throw new ZipError('The zip archive is too short')
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  if (view.getUint32(0, true) !== LOCAL_HEADER) throw new ZipError('Not a zip archive')
  const entry = centralEntry(data, view) ?? {
    method: view.getUint16(8, true),
    crc: view.getUint32(14, true),
    compressedSize: view.getUint32(18, true),
    size: view.getUint32(22, true),
    localHeader: 0
  }
  const header = entry.localHeader
  if (header + 30 > data.length || view.getUint32(header, true) !== LOCAL_HEADER) {
    throw new ZipError('The zip archive is damaged')
  }
  const start = header + 30 + view.getUint16(header + 26, true) + view.getUint16(header + 28, true)
  const end = start + entry.compressedSize
  if (end > data.length) throw new ZipError('The zip archive ends early')
  if (entry.size > maxBytes) throw new ZipError('The zip archive holds more than expected')

  const body = data.subarray(start, end)
  let out: Buffer
  if (entry.method === STORED) {
    out = Buffer.from(body)
  } else if (entry.method === DEFLATED) {
    try {
      // One byte over the declared size is enough to tell that it lied.
      out = inflateRawSync(body, { maxOutputLength: Math.max(1, entry.size + 1) })
    } catch {
      throw new ZipError('The zip archive is damaged')
    }
  } else {
    throw new ZipError(`Unsupported zip compression method ${entry.method}`)
  }
  if (out.length !== entry.size) throw new ZipError('The zip archive is damaged')
  if (crc32(out) !== entry.crc) throw new ZipError('The zip archive failed its CRC check')
  return out
}
