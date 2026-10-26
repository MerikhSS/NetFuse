import { lstat } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, sep } from 'node:path'

/** The files of `root` a download put there, checked before any is removed: each must be inside
 * `root`, and no folder on the way may be a link. Files the user added are never named, and links
 * are never followed. */
export async function ownedFiles(
  root: string,
  files: readonly string[]
): Promise<{
  targets: string[]
  folders: string[]
}> {
  const targets: string[] = []
  const folders = new Set<string>([root])
  const inspect = async (path: string): Promise<Awaited<ReturnType<typeof lstat>> | null> =>
    lstat(path).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null
      throw error
    })
  for (const file of files) {
    const target = join(root, file)
    const within = relative(root, target)
    if (
      !within ||
      isAbsolute(file) ||
      isAbsolute(within) ||
      within === '..' ||
      within.startsWith(`..${sep}`)
    ) {
      throw new Error('NetFuse can’t safely remove these files.')
    }
    let parent = dirname(target)
    while (true) {
      const info = await inspect(parent)
      if (info?.isSymbolicLink())
        throw new Error('Part of the install folder is now a link. Manage it in your file browser.')
      folders.add(parent)
      if (parent === root) break
      parent = dirname(parent)
    }
    const info = await inspect(target)
    if (info) {
      if (info.isDirectory())
        throw new Error('A file of the install is now a folder. Manage it in your file browser.')
      targets.push(target)
    }
  }
  return { targets, folders: [...folders].sort((a, b) => b.length - a.length) }
}
