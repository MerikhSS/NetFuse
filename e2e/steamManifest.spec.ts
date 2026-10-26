import { expect, test } from '@playwright/test'
import fc from 'fast-check'
import { parse as oracleParse } from 'steam-user/components/content_manifest.js'
import {
  decryptManifestNames,
  FileFlag,
  ManifestError,
  parseManifest,
  readManifest
} from '../src/main/steam/manifest'
import { buildManifest, seeded, zipOne } from './steamContent'

// Depot manifests: NetFuse's own bounded protobuf reader against steam-user's protobufjs one, on
// manifests built the way Steam's tools build them, and on everything a network can send instead.

const KEY = Buffer.alloc(32, 9)

const files = [
  { name: 'bin\\game.exe', data: seeded(150_000, 1), flags: FileFlag.Executable },
  { name: 'data/levels/one.pak', data: seeded(70_000, 2, true) },
  { name: 'data/empty.txt', data: Buffer.alloc(0) },
  { name: 'data/levels', flags: FileFlag.Directory },
  { name: 'lib/libgame.so', flags: FileFlag.Symlink, linkTarget: 'libgame.so.1' },
  // The same bytes as another file: one chunk, written twice.
  { name: 'data/copy.pak', data: seeded(70_000, 2, true) }
]

test.describe('manifest', () => {
  test('reads what steam-user reads, ids, sizes, flags and chunks alike', () => {
    const fixture = buildManifest({
      depotId: 441,
      manifestId: '7280959080077824592',
      key: KEY,
      files
    })
    const ours = readManifest(fixture.zipped)
    const theirs = oracleParse(fixture.raw)
    expect(ours.depotId).toBe(441)
    expect(ours.manifestId).toBe('7280959080077824592')
    expect(ours.manifestId).toBe(theirs.gid_manifest)
    expect(ours.files.length).toBe(theirs.files.length)
    ours.files.forEach((file, i) => {
      const other = theirs.files[i]
      expect(file.name).toBe(other.filename)
      expect(String(file.size)).toBe(String(other.size))
      expect(file.flags).toBe(other.flags)
      expect(file.linkTarget).toBe(other.linktarget ?? '')
      expect(
        file.chunks.map((chunk) => [
          chunk.sha.toString('hex'),
          String(chunk.offset),
          chunk.size,
          chunk.compressedSize
        ])
      ).toEqual(
        other.chunks.map((chunk) => [
          chunk.sha,
          String(chunk.offset),
          chunk.cb_original,
          chunk.cb_compressed
        ])
      )
    })
    // Chunks are deduplicated by content: the copy shares the original's.
    expect(fixture.chunks.size).toBe(Math.ceil(150_000 / 65536) + Math.ceil(70_000 / 65536))
  })

  test('decrypts encrypted file names with the depot key, and refuses the wrong key', () => {
    const fixture = buildManifest({
      depotId: 1,
      manifestId: '1',
      key: KEY,
      files: files.slice(0, 2),
      encryptNames: true
    })
    const manifest = readManifest(fixture.zipped)
    expect(manifest.filenamesEncrypted).toBe(true)
    expect(manifest.files[0].name).not.toBe('bin\\game.exe')
    expect(() => decryptManifestNames(readManifest(fixture.zipped), Buffer.alloc(32, 1))).toThrow(
      ManifestError
    )
    decryptManifestNames(manifest, KEY)
    expect(manifest.files.map((file) => file.name)).toEqual([
      'bin\\game.exe',
      'data/levels/one.pak'
    ])
    expect(manifest.filenamesEncrypted).toBe(false)
  })

  test('a manifest cut short anywhere, or with any byte changed, is refused or still well-formed', () => {
    const { raw } = buildManifest({ depotId: 2, manifestId: '2', key: KEY, files })
    fc.assert(
      fc.property(fc.integer({ min: 0, max: raw.length - 1 }), (end) => {
        expect(() => parseManifest(raw.subarray(0, end))).toThrow(ManifestError)
      }),
      { numRuns: 200 }
    )
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: raw.length - 1 }),
        fc.integer({ min: 1, max: 255 }),
        (at, flip) => {
          const damaged = Buffer.from(raw)
          damaged[at] ^= flip
          try {
            const manifest = parseManifest(damaged)
            for (const file of manifest.files) {
              expect(Number.isSafeInteger(file.size)).toBe(true)
              for (const chunk of file.chunks) expect(chunk.sha.length).toBe(20)
            }
          } catch (error) {
            expect(error).toBeInstanceOf(ManifestError)
          }
        }
      ),
      { numRuns: 300 }
    )
  })

  test('random bytes, a Steam3 manifest, or a zip of nothing are refused', () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 200 }), (bytes) => {
        try {
          parseManifest(Buffer.from(bytes))
        } catch (error) {
          expect(error).toBeInstanceOf(ManifestError)
        }
      }),
      { numRuns: 300 }
    )
    const steam3 = Buffer.alloc(8)
    steam3.writeUInt32LE(0x16349781)
    expect(() => parseManifest(steam3)).toThrow(/old format/)
    expect(() => readManifest(zipOne(Buffer.alloc(0)))).toThrow(ManifestError)
    expect(() => readManifest(Buffer.from('not a zip at all, honestly'))).toThrow(ManifestError)
  })

  test('a section that claims to be longer than the manifest is refused before it is read', () => {
    const header = Buffer.alloc(8)
    header.writeUInt32LE(0x71f617d0, 0)
    header.writeUInt32LE(0xffffffff, 4)
    expect(() => parseManifest(Buffer.concat([header, Buffer.alloc(100)]))).toThrow(/truncated/)
  })
})
