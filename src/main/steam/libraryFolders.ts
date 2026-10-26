// The Steam client's list of its libraries (steamapps/libraryfolders.vdf): every folder on this
// computer where Steam keeps games, the client's own folder first. It is Valve's KeyValues text,
// read here with a small parser of its own, written defensively: the file is the user's, and an
// odd one is read for what can be read from it, never trusted beyond that.

export type VdfNode = { [key: string]: string | VdfNode }

/** Bigger than any libraryfolders.vdf (a few kilobytes): something else. */
const MAX_TEXT = 1024 * 1024
const MAX_DEPTH = 32

export class VdfError extends Error {}

/** Valve's KeyValues text: quoted (or bare) keys and values, braces for sections, backslash
 * escapes and // comments. A later duplicate key replaces an earlier one. */
export function parseVdf(text: string): VdfNode {
  if (text.length > MAX_TEXT) throw new VdfError('Too long for a Steam settings file')
  let at = 0

  const skipSpace = (): void => {
    for (;;) {
      while (at < text.length && /\s/.test(text[at])) at++
      if (text.startsWith('//', at)) {
        while (at < text.length && text[at] !== '\n') at++
        continue
      }
      return
    }
  }

  const token = (): string | null => {
    skipSpace()
    if (at >= text.length) return null
    const char = text[at]
    if (char === '{' || char === '}') {
      at++
      return char
    }
    if (char === '"') {
      at++
      let value = ''
      while (at < text.length && text[at] !== '"') {
        if (text[at] === '\\' && at + 1 < text.length) {
          const next = text[at + 1]
          value += next === 'n' ? '\n' : next === 't' ? '\t' : next
          at += 2
        } else {
          value += text[at++]
        }
      }
      if (at >= text.length) throw new VdfError('A quoted value never ends')
      at++
      return value
    }
    const start = at
    while (at < text.length && !/[\s{}"]/.test(text[at])) at++
    return text.slice(start, at)
  }

  const section = (depth: number, closed: boolean): VdfNode => {
    if (depth > MAX_DEPTH) throw new VdfError('Nested too deep')
    const node: VdfNode = {}
    for (;;) {
      const key = token()
      if (key === null) {
        if (closed) throw new VdfError('A section never ends')
        return node
      }
      if (key === '}') {
        if (!closed) throw new VdfError('A section ends that never began')
        return node
      }
      if (key === '{') throw new VdfError('A section has no name')
      const value = token()
      if (value === null) throw new VdfError(`${key} has no value`)
      if (value === '}') throw new VdfError(`${key} has no value`)
      node[key] = value === '{' ? section(depth + 1, true) : value
    }
  }

  return section(0, false)
}

/**
 * The library folders a parsed libraryfolders.vdf lists, in its order. Both layouts Steam has
 * written: today's (`"libraryfolders" { "0" { "path" "…" … } }`) and the older one, where each
 * numbered key's value is the path itself, next to other settings.
 */
export function libraryPaths(vdf: VdfNode): string[] {
  const top = Object.entries(vdf).find(([key]) => key.toLowerCase() === 'libraryfolders')?.[1]
  if (!top || typeof top === 'string') return []
  const paths: string[] = []
  for (const [key, value] of Object.entries(top)) {
    if (!/^\d+$/.test(key)) continue
    const path = typeof value === 'string' ? value : value.path
    if (typeof path === 'string' && path.length > 0 && path.length <= 4096) paths.push(path)
  }
  return paths
}
