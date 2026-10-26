import { symmetricDecrypt as oracleDecrypt, symmetricEncrypt } from '@doctormckay/steam-crypto'
import { expect, test } from '@playwright/test'
import fc from 'fast-check'
import * as LZMA from 'lzma'
import { unzip } from 'steam-user/components/cdn_compression.js'
import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { ChunkError, decodeChunk, decompressChunk } from '../src/main/steam/chunkCodec'
import { decryptFilename, SteamCryptoError, symmetricDecrypt } from '../src/main/steam/crypto'
import { decodeLzma, LzmaError, lzmaProperties } from '../src/main/steam/lzma'
import { redact, redactedMessage } from '../src/main/steam/redact'
import { unzipFirst, ZipError } from '../src/main/steam/zip'
import { compressChunk, encodeChunk, seeded, sha1, zipOne, type Compression } from './steamContent'

// The Steam chunk pipeline, piece by piece: decryption, the three compressions and the checks
// that decide whether a chunk may be written. steam-user's own decoders (steam-crypto,
// cdn_compression.js, LZMA-JS) are the oracle for what Steam sends.

const KEY = Buffer.alloc(32, 7)
const data = fc.uint8Array({ maxLength: 4096 }).map((bytes) => Buffer.from(bytes))

/** LZMA-JS's stream: 5 property bytes, a uint64 size, then the data. */
const lzmaJs = (input: Buffer, mode = 1): Buffer =>
  Buffer.from(LZMA.compress(input, mode).map((byte) => byte & 0xff))

const hasXz = ((): boolean => {
  try {
    execFileSync('xz', ['--version'])
    return true
  } catch {
    return false
  }
})()

test.describe('redact', () => {
  test('takes out tokens, codes, keys and request codes, and leaves the rest', () => {
    const jwt = 'eyJhbGciOiJFZERTQSJ9.eyJzdWIiOiI3NjU2MTE5OCJ9.c2lnbmF0dXJlLWhlcmUxMjM'
    const key = 'ab'.repeat(32)
    const text = `refresh ${jwt} at https://cache.steamcontent.com/depot/441/chunk/x?token=s3cret&x=1 key=${key} /depot/441/manifest/123/5/9876543210 password=hunter2`
    const out = redact(text)
    for (const secret of [jwt, 's3cret', key, '9876543210', 'hunter2']) {
      expect(out).not.toContain(secret)
    }
    expect(out).toContain('cache.steamcontent.com/depot/441/chunk/x')
    expect(out).toContain('/depot/441/manifest/123/5/[redacted]')
  })

  test('reads through an error and its causes', () => {
    const cause = new Error('token=abc123')
    const error = new Error('Steam refused', { cause })
    expect(redactedMessage(error)).toBe('Steam refused: token=[redacted]')
    expect(redactedMessage('plain')).toBe('plain')
    expect(redactedMessage(undefined)).toBe('Unknown error')
  })
})

test.describe('crypto', () => {
  test('decrypts whatever steam-crypto encrypts, with or without its own IV', () => {
    fc.assert(
      fc.property(data, fc.uint8Array({ minLength: 16, maxLength: 16 }), (plain, iv) => {
        expect(symmetricDecrypt(symmetricEncrypt(plain, KEY), KEY)).toEqual(plain)
        expect(symmetricDecrypt(symmetricEncrypt(plain, KEY, Buffer.from(iv)), KEY)).toEqual(plain)
      })
    )
  })

  test('matches steam-crypto on its own output, and refuses what no key could have made', () => {
    const plain = seeded(1000, 3)
    const sealed = symmetricEncrypt(plain, KEY)
    expect(symmetricDecrypt(sealed, KEY)).toEqual(oracleDecrypt(sealed, KEY))
    expect(() => symmetricDecrypt(sealed, Buffer.alloc(16))).toThrow(SteamCryptoError)
    expect(() => symmetricDecrypt(sealed.subarray(0, 31), KEY)).toThrow(SteamCryptoError)
    expect(() => symmetricDecrypt(sealed.subarray(0, sealed.length - 1), KEY)).toThrow(
      SteamCryptoError
    )
    expect(() => symmetricDecrypt(Buffer.alloc(16), KEY)).toThrow(SteamCryptoError)
    // A wrong key decrypts to garbage whose padding almost never checks out.
    let refused = 0
    for (let i = 0; i < 20; i++) {
      try {
        symmetricDecrypt(sealed, randomBytes(32))
      } catch (error) {
        expect(error).toBeInstanceOf(SteamCryptoError)
        refused++
      }
    }
    expect(refused).toBeGreaterThanOrEqual(18)
  })

  test('decrypts a manifest file name up to its NUL', () => {
    const encoded = symmetricEncrypt(Buffer.from('bin\\game.exe\0'), KEY).toString('base64')
    expect(decryptFilename(encoded, KEY)).toBe('bin\\game.exe')
  })
})

test.describe('lzma', () => {
  test('decodes exactly what LZMA-JS encodes', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          data,
          fc.integer({ min: 1, max: 1 << 30 }).map((seed) => seeded(3000, seed, true)),
          fc.integer({ min: 0, max: 64 }).map((length) => Buffer.alloc(length, 0x61))
        ),
        fc.integer({ min: 1, max: 9 }),
        (input, mode) => {
          const stream = lzmaJs(input, mode)
          expect(decodeLzma(stream, lzmaProperties(stream), input.length, 13)).toEqual(input)
        }
      ),
      { numRuns: 60 }
    )
  })

  test('decodes what xz writes, end marker and all', () => {
    test.skip(!hasXz, 'xz is not installed')
    for (const input of [seeded(200_000, 9), seeded(200_000, 10, true), Buffer.alloc(100_000)]) {
      const stream = execFileSync('xz', ['--format=lzma', '-6', '-c'], { input })
      expect(decodeLzma(stream, lzmaProperties(stream), input.length, 13)).toEqual(input)
    }
  })

  test('refuses a stream that is cut short, corrupt, or longer than declared, quickly', () => {
    const input = seeded(20_000, 4, true)
    const stream = lzmaJs(input)
    const props = lzmaProperties(stream)
    expect(() =>
      decodeLzma(stream.subarray(0, stream.length - 50), props, input.length, 13)
    ).toThrow(LzmaError)
    // More output asked for than the stream holds.
    expect(() => decodeLzma(stream, props, input.length + 1000, 13)).toThrow(LzmaError)
    expect(() => lzmaProperties(Buffer.from([225, 0, 0, 0, 0]))).toThrow(LzmaError)
    fc.assert(
      fc.property(
        fc.integer({ min: 13, max: stream.length - 1 }),
        fc.integer({ min: 1, max: 255 }),
        (at, flip) => {
          const damaged = Buffer.from(stream)
          damaged[at] ^= flip
          const started = Date.now()
          try {
            const out = decodeLzma(damaged, props, input.length, 13)
            // Damage the decoder can't see is still never the original's bytes and length both.
            expect(out.length).toBe(input.length)
          } catch (error) {
            expect(error).toBeInstanceOf(LzmaError)
          }
          expect(Date.now() - started).toBeLessThan(1000)
        }
      ),
      { numRuns: 100 }
    )
  })

  test('decodes random bytes from the fuzzer without ever writing past its output', () => {
    fc.assert(
      fc.property(fc.uint8Array({ minLength: 6, maxLength: 512 }), fc.nat(5000), (bytes, size) => {
        const props = Buffer.from([93, 0, 0, 1, 0])
        try {
          const out = decodeLzma(Buffer.concat([props, bytes]), lzmaProperties(props), size, 5)
          expect(out.length).toBe(size)
        } catch (error) {
          expect(error).toBeInstanceOf(LzmaError)
        }
      }),
      { numRuns: 300 }
    )
  })
})

test.describe('zip', () => {
  test('reads the one file a Steam zip holds, and refuses one that says it is bigger', () => {
    fc.assert(
      fc.property(data, (input) => {
        expect(unzipFirst(zipOne(input), input.length)).toEqual(input)
      })
    )
    const archive = zipOne(seeded(1000, 1))
    expect(() => unzipFirst(archive, 999)).toThrow(ZipError)
    expect(() => unzipFirst(archive.subarray(0, 40), 1000)).toThrow(ZipError)
    const damaged = Buffer.from(archive)
    damaged[35] ^= 0xff
    expect(() => unzipFirst(damaged, 1000)).toThrow(ZipError)
    expect(() => unzipFirst(Buffer.alloc(40), 1000)).toThrow(ZipError)
  })

  test('never inflates past its limit, whatever the archive claims', () => {
    // A zip bomb: a megabyte of zeros deflates to almost nothing.
    const bomb = zipOne(Buffer.alloc(1 << 20))
    // Its central directory claims it inflates to 10 bytes.
    bomb.writeUInt32LE(10, bomb.indexOf(Buffer.from('PK\u0001\u0002', 'latin1')) + 24)
    expect(() => unzipFirst(bomb, 10)).toThrow(ZipError)
  })
})

test.describe('chunks', () => {
  for (const how of ['lzma', 'zstd', 'zip'] as Compression[]) {
    test(`a ${how} chunk decodes to what steam-user's decoder gives`, async () => {
      for (const plain of [seeded(70_000, 2), seeded(70_000, 3, true), Buffer.from('x')]) {
        const compressed = compressChunk(plain, how)
        const oracle = await unzip(compressed)
        expect(decompressChunk(compressed, plain.length)).toEqual(oracle)
        const body = encodeChunk(plain, KEY, how)
        expect(decodeChunk(body, KEY, { sha: sha1(plain), size: plain.length })).toEqual(plain)
      }
    })

    test(`a ${how} chunk that is anything but what the manifest says is refused`, () => {
      const plain = seeded(20_000, 5, true)
      const body = encodeChunk(plain, KEY, how)
      const expected = { sha: sha1(plain), size: plain.length }
      // Wrong id, wrong size, wrong key, truncated, and one byte flipped anywhere.
      expect(() => decodeChunk(body, KEY, { ...expected, sha: sha1(Buffer.from('no')) })).toThrow(
        ChunkError
      )
      expect(() => decodeChunk(body, KEY, { ...expected, size: plain.length - 1 })).toThrow(
        ChunkError
      )
      expect(() => decodeChunk(body, Buffer.alloc(32, 1), expected)).toThrow(ChunkError)
      expect(() => decodeChunk(body.subarray(0, body.length - 16), KEY, expected)).toThrow(
        ChunkError
      )
      // A damaged copy is refused, or decodes to exactly the chunk: damage that lands only in
      // bytes the format doesn't read (a zip's directory dates, say) changes nothing, and what
      // comes out is checked against the chunk's SHA-1 either way. Never anything else.
      let refused = 0
      fc.assert(
        fc.property(
          fc.integer({ min: 0, max: body.length - 1 }),
          fc.integer({ min: 1, max: 255 }),
          (at, flip) => {
            const damaged = Buffer.from(body)
            damaged[at] ^= flip
            let decoded: Buffer
            try {
              decoded = decodeChunk(damaged, KEY, expected)
            } catch (error) {
              expect(error).toBeInstanceOf(ChunkError)
              refused++
              return
            }
            expect(decoded.equals(plain)).toBe(true)
          }
        ),
        { numRuns: 60 }
      )
      expect(refused, 'almost any damage is refused').toBeGreaterThan(30)
    })
  }

  test('a chunk in no known format, or with a lying footer, is refused', () => {
    expect(() => decompressChunk(Buffer.from('nope-nope-nope-nope-nope'), 3)).toThrow(ChunkError)
    const plain = seeded(5000, 6)
    for (const how of ['lzma', 'zstd'] as Compression[]) {
      const compressed = compressChunk(plain, how)
      // The footer's size says more than the manifest does.
      const lying = Buffer.from(compressed)
      lying.writeUInt32LE(plain.length + 1, lying.length - (how === 'lzma' ? 6 : 11))
      expect(() => decompressChunk(lying, plain.length)).toThrow(ChunkError)
      // A wrong CRC.
      const crc = Buffer.from(compressed)
      crc[crc.length - (how === 'lzma' ? 10 : 15)] ^= 1
      expect(() => decompressChunk(crc, plain.length)).toThrow(ChunkError)
    }
  })
})
