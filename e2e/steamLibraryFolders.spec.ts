import { expect, test } from '@playwright/test'
import { libraryPaths, parseVdf, VdfError } from '../src/main/steam/libraryFolders'

// The Steam client's libraryfolders.vdf, in both layouts it has written, and in the shapes a
// file the user has edited (or a newer client) might take.

test.describe('steam library folders', () => {
  test('reads today’s layout, Windows paths and all', () => {
    const text = [
      '"libraryfolders"',
      '{',
      '\t"0"',
      '\t{',
      '\t\t"path"\t\t"C:\\\\Program Files (x86)\\\\Steam"',
      '\t\t"label"\t\t""',
      '\t\t"contentid"\t\t"123"',
      '\t\t"apps"',
      '\t\t{',
      '\t\t\t"228980"\t\t"1234"',
      '\t\t}',
      '\t}',
      '\t"1"',
      '\t{',
      '\t\t"path"\t\t"D:\\\\SteamLibrary"',
      '\t}',
      '}'
    ].join('\n')
    expect(libraryPaths(parseVdf(text))).toEqual([
      'C:\\Program Files (x86)\\Steam',
      'D:\\SteamLibrary'
    ])
  })

  test('reads the older layout, where each numbered key is a path', () => {
    const text = `"LibraryFolders"
{
	// written by an older client
	"TimeNextStatsReport"		"1700000000"
	"ContentStatsID"		"-123"
	"1"		"/mnt/games/SteamLibrary"
	"2"		"/media/usb/Steam"
}`
    expect(libraryPaths(parseVdf(text))).toEqual(['/mnt/games/SteamLibrary', '/media/usb/Steam'])
  })

  test('takes escapes, bare words and comments as Valve’s format has them', () => {
    expect(parseVdf('a "x\\"y" // a note\n b { c "line\\nbreak" }')).toEqual({
      a: 'x"y',
      b: { c: 'line\nbreak' }
    })
  })

  test('refuses what isn’t a settings file, and keeps only what makes sense in one that is', () => {
    for (const broken of ['"a" {', '"a" "b" }', '{ "a" "b" }', '"a"', '"a" "never closed', 'a }']) {
      expect(() => parseVdf(broken), broken).toThrow(VdfError)
    }
    expect(() => parseVdf('a { '.repeat(40) + '}'.repeat(40))).toThrow(/too deep/)
    expect(() => parseVdf('x'.repeat(2 * 1024 * 1024))).toThrow(/Too long/)
    // A library with no path, or one that isn't numbered, is skipped.
    const odd = parseVdf(
      'libraryfolders { "0" { "label" "x" } "x" { "path" "/a" } "1" { "path" "" } "2" "/b" }'
    )
    expect(libraryPaths(odd)).toEqual(['/b'])
    expect(libraryPaths(parseVdf('other { "0" "/a" }'))).toEqual([])
    expect(libraryPaths(parseVdf('libraryfolders "/a"'))).toEqual([])
  })
})
