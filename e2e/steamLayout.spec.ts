import { expect, test } from '@playwright/test'
import fc from 'fast-check'
import { posix } from 'node:path'
import { buildLayout, UnsafeLayoutError } from '../src/main/steam/layout'
import {
  FileFlag,
  type Manifest,
  type ManifestChunk,
  type ManifestFile
} from '../src/main/steam/manifest'

// What a Steam download writes. A manifest's names come from the network, so the property that
// matters most is about paths: every path either stays inside the install folder, or the whole
// download is refused before anything is written.

let shaSeed = 0
const chunk = (offset: number, size: number, sha?: Buffer): ManifestChunk => ({
  sha: sha ?? Buffer.alloc(20, ++shaSeed % 256).fill(shaSeed >> 8, 0, 1),
  offset,
  size,
  compressedSize: size + 16
})

const file = (name: string, size = 10, extra: Partial<ManifestFile> = {}): ManifestFile => ({
  name,
  size,
  flags: 0,
  linkTarget: '',
  chunks: size > 0 ? [chunk(0, size)] : [],
  ...extra
})

const manifest = (files: ManifestFile[], depotId = 1): Manifest => ({
  depotId,
  manifestId: String(depotId),
  filenamesEncrypted: false,
  files
})

const segment = fc.oneof(
  fc.constantFrom(
    '..',
    '.',
    '',
    'CON',
    'con.txt',
    'a:b',
    'x\u0000y',
    'A',
    'a',
    'dir',
    'name. ',
    'C:'
  ),
  fc.string({ maxLength: 8 }),
  fc.string({ minLength: 250, maxLength: 300 })
)
const name = fc
  .tuple(fc.array(segment, { minLength: 1, maxLength: 4 }), fc.constantFrom('/', '\\'))
  .map(([segments, separator]) => segments.join(separator))
const entry = fc.oneof(
  name.map((path) => file(path)),
  name.map((path) => file(path, 0, { flags: FileFlag.Directory })),
  fc
    .tuple(name, name)
    .map(([path, target]) => file(path, 0, { flags: FileFlag.Symlink, linkTarget: target }))
)

test.describe('steam layout', () => {
  for (const platform of ['darwin', 'linux', 'win32'] as const) {
    test(`on ${platform}, every path and link stays inside the install, or nothing is written`, () => {
      fc.assert(
        fc.property(
          fc.array(fc.array(entry, { minLength: 1, maxLength: 5 }), { minLength: 1, maxLength: 2 }),
          (depots) => {
            let layout
            try {
              layout = buildLayout(
                depots.map((files, i) => manifest(files, i + 1)),
                platform
              )
            } catch (error) {
              expect(error).toBeInstanceOf(UnsafeLayoutError)
              return
            }
            const seen = new Set<string>()
            for (const entry of layout.files) {
              expect(posix.isAbsolute(entry.path)).toBe(false)
              for (const part of entry.path.split('/')) {
                expect(['', '.', '..']).not.toContain(part)
                expect(part).not.toMatch(/[\\/]/)
                expect(part).not.toContain('\u0000')
                expect(Buffer.byteLength(part)).toBeLessThanOrEqual(255)
              }
              const key =
                platform === 'linux' ? entry.path : entry.path.normalize('NFC').toLowerCase()
              expect(seen.has(key)).toBe(false)
              seen.add(key)
              if (entry.linkTarget !== undefined) {
                const resolved = posix.normalize(
                  posix.join(posix.dirname(entry.path), entry.linkTarget)
                )
                expect(resolved === '..' || resolved.startsWith('../')).toBe(false)
              }
            }
            // Nothing sits inside a file or a link.
            for (const entry of layout.files) {
              const parts = entry.path.split('/')
              for (let end = 1; end < parts.length; end++) {
                const parent = layout.files.find(
                  (other) => other.path === parts.slice(0, end).join('/')
                )
                if (parent) expect(parent.kind).toBe('directory')
              }
            }
          }
        ),
        { numRuns: 400 }
      )
    })
  }

  test('a game keeps its layout, with Windows separators made "/", and chunks shared between copies', () => {
    const shared = Buffer.alloc(20, 0xaa)
    const layout = buildLayout(
      [
        manifest([
          file('bin\\game.exe', 30, {
            flags: FileFlag.Executable,
            chunks: [chunk(0, 10, shared), chunk(10, 20)]
          }),
          file('data', 0, { flags: FileFlag.Directory }),
          file('data\\copy.bin', 10, { chunks: [chunk(0, 10, shared)] }),
          file('lib/libgame.so', 0, { flags: FileFlag.Symlink, linkTarget: 'libgame.so.1' }),
          file('empty.txt', 0)
        ])
      ],
      'linux'
    )
    expect(
      layout.files.map((entry) => [entry.path, entry.kind, entry.size, entry.executable])
    ).toEqual([
      ['bin/game.exe', 'file', 30, true],
      ['data', 'directory', 0, false],
      ['data/copy.bin', 'file', 10, false],
      ['empty.txt', 'file', 0, false],
      ['lib/libgame.so', 'symlink', 0, false]
    ])
    expect(layout.installBytes).toBe(40)
    expect(layout.units.length).toBe(2)
    const sharedUnit = layout.units.find((unit) => unit.sha === shared.toString('hex'))!
    expect(sharedUnit.targets).toEqual([
      { file: 0, offset: 0 },
      { file: 2, offset: 0 }
    ])
    expect(layout.downloadBytes).toBe(26 + 36)
  })

  test('a later depot replaces an earlier one’s file, and folders differing only in case merge where the disk does', () => {
    const base = manifest([file('Data/text.txt', 5), file('Data/other.txt', 5)], 1)
    const language = manifest([file('data/TEXT.txt', 7)], 2)
    const mac = buildLayout([base, language], 'darwin')
    expect(mac.files.map((entry) => [entry.path, entry.size])).toEqual([
      ['Data/other.txt', 5],
      ['Data/text.txt', 7]
    ])
    // Linux keeps them apart, as its file systems do.
    const linux = buildLayout([base, language], 'linux')
    expect(linux.files.map((entry) => entry.path)).toEqual([
      'Data/other.txt',
      'Data/text.txt',
      'data/TEXT.txt'
    ])
  })

  test('two files of one depot that one disk would make one file are refused there', () => {
    const depot = manifest([file('Readme.txt'), file('README.txt')])
    expect(() => buildLayout([depot], 'win32')).toThrow(UnsafeLayoutError)
    expect(() => buildLayout([depot], 'linux')).not.toThrow()
  })

  test('links that lead out, or through a link and back up, are refused', () => {
    const cases: [string, string][] = [
      ['a', '../outside'],
      ['a', '/etc/passwd'],
      ['a', 'C:\\Windows'],
      ['dir/a', '../../x'],
      ['a', '\\\\server\\share']
    ]
    for (const [path, target] of cases) {
      expect(() =>
        buildLayout(
          [manifest([file(path, 0, { flags: FileFlag.Symlink, linkTarget: target })])],
          'linux'
        )
      ).toThrow(UnsafeLayoutError)
    }
    // "L" points at the install's own folder, so "L/../x" leads out of it, though it reads as "x".
    expect(() =>
      buildLayout(
        [
          manifest([
            file('L', 0, { flags: FileFlag.Symlink, linkTarget: '.' }),
            file('M', 0, { flags: FileFlag.Symlink, linkTarget: 'L/../x' })
          ])
        ],
        'linux'
      )
    ).toThrow(UnsafeLayoutError)
    // A macOS framework's links go through each other without ever stepping back.
    expect(() =>
      buildLayout(
        [
          manifest([
            file('Foo.framework/Versions/Current', 0, { flags: FileFlag.Symlink, linkTarget: 'A' }),
            file('Foo.framework/Foo', 0, {
              flags: FileFlag.Symlink,
              linkTarget: 'Versions/Current/Foo'
            }),
            file('Foo.framework/Versions/A/Foo', 10)
          ])
        ],
        'darwin'
      )
    ).not.toThrow()
  })

  test('nothing may be written inside a file, or through a link', () => {
    expect(() => buildLayout([manifest([file('a'), file('a/b')])], 'linux')).toThrow(
      UnsafeLayoutError
    )
    expect(() =>
      buildLayout(
        [manifest([file('a', 0, { flags: FileFlag.Symlink, linkTarget: 'b' }), file('a/c')])],
        'linux'
      )
    ).toThrow(UnsafeLayoutError)
  })

  test('chunks that overlap, overrun their file or are absurdly large are refused; gaps are noted', () => {
    expect(() =>
      buildLayout([manifest([file('a', 20, { chunks: [chunk(0, 12), chunk(10, 10)] })])], 'linux')
    ).toThrow(/don't fit/)
    expect(() =>
      buildLayout([manifest([file('a', 10, { chunks: [chunk(5, 10)] })])], 'linux')
    ).toThrow(/don't fit/)
    expect(() =>
      buildLayout([manifest([file('a', 1 << 26, { chunks: [chunk(0, 1 << 25)] })])], 'linux')
    ).toThrow(/impossible size/)
    const layout = buildLayout([manifest([file('a', 30, { chunks: [chunk(10, 10)] })])], 'linux')
    expect(layout.files[0].holes).toEqual([
      [0, 10],
      [20, 30]
    ])
  })

  test('a 64-bit size beyond what can be addressed never gets this far, and huge files still lay out', () => {
    const size = 2 ** 40
    const layout = buildLayout(
      [manifest([file('big.bin', size, { chunks: [chunk(size - 10, 10)] })])],
      'linux'
    )
    expect(layout.installBytes).toBe(size)
  })
})
