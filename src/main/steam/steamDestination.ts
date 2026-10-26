import {
  chmod,
  lstat,
  mkdir,
  open,
  readlink,
  rm,
  rmdir,
  stat,
  symlink,
  type FileHandle
} from 'node:fs/promises'
import { join } from 'node:path'
import { markSparse } from '../download/sparseFile'
import { ownedFiles } from '../download/ownedFiles'
import type { SteamLayout } from './layout'

// Where a Steam download installs: its own folder, written in place. Every file
// is made at its full size before any chunk arrives, and each verified chunk is written at its
// offsets, in as many files as share it. Writes stay in the open files below (a game has
// thousands of files; a few dozen are open at once), and a checkpoint syncs the files written
// since the last one, so a chunk saved as done is on disk.
//
// Nothing here ever deletes more than the install made: removing it takes the files and links its
// layout names, checked one by one never to be followed through a link, and then only the folders
// that leaves empty. Anything else in the folder — a save, a mod — stays.

/** Files kept open at once. */
const OPEN_FILES = 64

interface OpenFile {
  handle: Promise<FileHandle>
  /** Writes under way through it: it isn't closed while any is. */
  writing: number
}

export class SteamDestination {
  private readonly open = new Map<number, OpenFile>()
  /** Files written since the last sync, by index into the layout. */
  private touched = new Set<number>()
  /** Installed into a folder that was there before: what this download created, by file index,
   * is all it may remove. */
  readonly created: Set<number>

  constructor(
    /** The install folder. */
    readonly path: string,
    private readonly layout: SteamLayout,
    /** What size() says: the download's size, which is all there for as long as the folder is:
     * an install is written in place, never moved into it. */
    private readonly totalBytes: () => number,
    readonly adopted: boolean,
    created: readonly number[] = []
  ) {
    this.created = new Set(created)
  }

  private pathOf(index: number): string {
    return join(this.path, ...this.layout.files[index].path.split('/'))
  }

  /** Every folder the layout needs, parents first. */
  private folders(): string[] {
    const folders = new Set<string>()
    for (const file of this.layout.files) {
      const parts = file.path.split('/')
      const end = file.kind === 'directory' ? parts.length : parts.length - 1
      for (let i = 1; i <= end; i++) folders.add(parts.slice(0, i).join('/'))
    }
    return [...folders].sort((a, b) => a.split('/').length - b.split('/').length)
  }

  /**
   * Makes the install's folders, files and links, as many as aren't there already: once before
   * the first chunk, and again on every run and before publishing, since something may have
   * removed one meanwhile. A file that is there keeps what it has, at the size the layout says.
   * Returns the files that weren't there (or not at their size): chunks written to them before
   * aren't any more.
   */
  async prepare(): Promise<Set<number>> {
    // A handle kept from the last run may be to a file removed since: writes through it would
    // land in a file no longer in the folder.
    await this.close()
    await mkdir(this.path, { recursive: true })
    for (const folder of this.folders()) {
      const path = join(this.path, ...folder.split('/'))
      const info = await lstat(path).catch(() => null)
      if (info && !info.isDirectory()) {
        throw new Error(
          `${folder} in the install folder isn't a folder, but the game needs one there.`
        )
      }
      if (!info) await mkdir(path)
    }
    const remade = new Set<number>()
    for (const [index, file] of this.layout.files.entries()) {
      const path = this.pathOf(index)
      if (file.kind === 'directory') continue
      const info = await lstat(path).catch(() => null)
      if (file.kind === 'symlink') {
        if (info?.isSymbolicLink() && (await readlink(path)) === file.linkTarget) continue
        if (info)
          throw new Error(
            `${file.path} in the install folder is in the way of a link the game needs.`
          )
        await this.makeLink(path, file.linkTarget!)
        this.created.add(index)
        continue
      }
      if (info && !info.isFile()) {
        throw new Error(
          `${file.path} in the install folder isn't a file, but the game needs one there.`
        )
      }
      if (!info || info.size !== file.size) {
        remade.add(index)
        if (!info) this.created.add(index)
        const handle = await open(path, info ? 'r+' : 'wx')
        try {
          await handle.truncate(file.size)
        } finally {
          await handle.close()
        }
        // Chunks land all over a file; on NTFS a sparse one doesn't fill the gaps first.
        if (!info && file.size > 0) await markSparse(path)
      }
      // A range no chunk covers reads as zeros in a file made here. In one that was there
      // before, it has to be written.
      if (info && file.holes) {
        const handle = await open(path, 'r+')
        try {
          for (const [start, end] of file.holes) {
            const zeros = Buffer.alloc(Math.min(end - start, 1 << 20))
            for (let at = start; at < end; at += zeros.length) {
              await handle.write(zeros, 0, Math.min(zeros.length, end - at), at)
            }
          }
        } finally {
          await handle.close()
        }
      }
      if (file.executable && process.platform !== 'win32') await chmod(path, 0o755)
    }
    return remade
  }

  private async makeLink(path: string, target: string): Promise<void> {
    try {
      await symlink(process.platform === 'win32' ? target.split('/').join('\\') : target, path)
    } catch (error) {
      if (process.platform === 'win32' && (error as NodeJS.ErrnoException).code === 'EPERM') {
        throw new Error(
          'This game has symbolic links, and Windows lets NetFuse create them only with Developer Mode on. Turn it on in Settings, then resume.'
        )
      }
      throw error
    }
  }

  private file(index: number): OpenFile {
    let entry = this.open.get(index)
    if (entry) {
      // Most recently used last, so the first is the one to close when there are too many.
      this.open.delete(index)
      this.open.set(index, entry)
      return entry
    }
    if (this.open.size >= OPEN_FILES) {
      for (const [other, candidate] of this.open) {
        if (candidate.writing > 0) continue
        this.open.delete(other)
        void candidate.handle.then((handle) => handle.close()).catch(() => {})
        break
      }
    }
    entry = { handle: open(this.pathOf(index), 'r+'), writing: 0 }
    entry.handle.catch(() => this.open.delete(index))
    this.open.set(index, entry)
    return entry
  }

  /** Writes a verified chunk to every place it goes. Once this resolves, the chunk is done. */
  async writeChunk(
    data: Buffer,
    targets: readonly { file: number; offset: number }[]
  ): Promise<void> {
    for (const target of targets) {
      const entry = this.file(target.file)
      entry.writing++
      try {
        const handle = await entry.handle
        let written = 0
        while (written < data.length) {
          const { bytesWritten } = await handle.write(
            data,
            written,
            data.length - written,
            target.offset + written
          )
          if (bytesWritten <= 0) throw new Error('The disk took nothing of a write')
          written += bytesWritten
        }
        this.touched.add(target.file)
      } finally {
        entry.writing--
      }
    }
  }

  /** Reads a chunk's bytes back from its first place, to check what is on disk. */
  async readChunk(target: { file: number; offset: number }, size: number): Promise<Buffer> {
    const handle = await open(this.pathOf(target.file), 'r')
    try {
      const buffer = Buffer.alloc(size)
      const { bytesRead } = await handle.read(buffer, 0, size, target.offset)
      return buffer.subarray(0, bytesRead)
    } finally {
      await handle.close()
    }
  }

  /** Flushes every file written since the last sync. A failure puts them back for the next. */
  async sync(): Promise<void> {
    const files = [...this.touched]
    this.touched = new Set()
    try {
      for (const index of files) {
        const entry = this.open.get(index)
        if (entry) {
          await (await entry.handle).sync()
          continue
        }
        const handle = await open(this.pathOf(index), 'r+')
        try {
          await handle.sync()
        } finally {
          await handle.close()
        }
      }
    } catch (error) {
      for (const index of files) this.touched.add(index)
      throw error
    }
  }

  /** Closes every file it holds open; the next write opens them again. */
  async close(): Promise<void> {
    const entries = [...this.open.values()]
    this.open.clear()
    await Promise.all(
      entries.map((entry) => entry.handle.then((handle) => handle.close()).catch(() => {}))
    )
  }

  async size(): Promise<number> {
    await stat(this.path)
    return this.totalBytes()
  }

  /** Already in place: what the layout needs is made sure of, flushed, and it stays where it is.
   * A file with content that went missing since the run checked is never made again here: made
   * empty, it would pass for installed (see SteamTransfer.checkFiles, which fetches it again). */
  async publish(
    _destinationPath: string,
    _expectedBytes: number,
    beforeAttempt: (candidate: string) => Promise<void>
  ): Promise<string> {
    for (const [index, file] of this.layout.files.entries()) {
      if (file.kind !== 'file' || file.size === 0) continue
      const info = await lstat(this.pathOf(index)).catch(() => null)
      if (!info?.isFile() || info.size !== file.size) {
        throw new Error(
          `${file.path} went missing from the install folder before it finished. Resume to fetch it again.`
        )
      }
    }
    await this.prepare()
    await this.sync()
    await this.close()
    await beforeAttempt(this.path)
    return this.path
  }

  /** Removes what this download installed: its files and links, then the folders that leaves
   * empty (the install folder too, when nothing else is in it). */
  async discard(): Promise<void> {
    await this.close()
    if (!(await lstat(this.path).catch(() => null))?.isDirectory()) return
    const mine = this.layout.files
      .map((file, index) => ({ file, index }))
      .filter(
        ({ file, index }) => file.kind !== 'directory' && (!this.adopted || this.created.has(index))
      )
      .map(({ file }) => file.path.split('/').join('/'))
    const { targets } = await ownedFiles(this.path, mine)
    for (const target of targets) await rm(target, { force: true })
    // Deepest first, so a folder emptied by removing its subfolders goes too; only empty ones go.
    const folders = this.folders()
      .reverse()
      .map((folder) => join(this.path, ...folder.split('/')))
    for (const folder of folders) await rmdir(folder).catch(() => {})
    if (!this.adopted) await rmdir(this.path).catch(() => {})
  }
}
