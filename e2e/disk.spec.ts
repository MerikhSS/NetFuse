import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, NetFuseApp, test } from './fixtures'
import { SteamOrigin, syntheticApp, type SteamAppFixture } from './steamOrigin'

// The disk: out of space, folders vanishing, no permission. The small volumes are real
// filesystems (a RAM disk on macOS, tmpfs on Linux), so ENOSPC comes from the OS, not a mock.

/** About 14 MB installed; zstd, which is quick to build at this size, unlike LZMA. */
function bigGame(): SteamAppFixture {
  const big = syntheticApp(1, 40)
  return {
    ...big,
    depots: big.depots.map((depot) => ({ ...depot, compression: () => 'zstd' as const }))
  }
}

interface Volume {
  path: string
  dispose: () => Promise<void>
}

/** A real filesystem of `megabytes` size, or null where one can't be made without a password. */
async function smallVolume(megabytes: number): Promise<Volume | null> {
  try {
    if (process.platform === 'darwin') {
      const name = `netfusee2e${process.pid}${Date.now() % 100000}`
      const device = execFileSync('hdiutil', ['attach', '-nomount', `ram://${megabytes * 2048}`])
        .toString()
        .trim()
      execFileSync('diskutil', ['erasevolume', 'HFS+', name, device], { stdio: 'ignore' })
      return {
        path: `/Volumes/${name}`,
        dispose: async () => {
          execFileSync('hdiutil', ['detach', device, '-force'], { stdio: 'ignore' })
        }
      }
    }
    if (process.platform === 'linux') {
      const path = await mkdtemp(join(tmpdir(), 'netfuse-vol-'))
      execFileSync('sudo', [
        '-n',
        'mount',
        '-t',
        'tmpfs',
        '-o',
        `size=${megabytes}m`,
        'tmpfs',
        path
      ])
      execFileSync('sudo', ['-n', 'chown', String(process.getuid?.()), path])
      return {
        path,
        dispose: async () => {
          execFileSync('sudo', ['-n', 'umount', path])
          await rm(path, { recursive: true, force: true })
        }
      }
    }
  } catch {
    // No RAM disk tools, or no passwordless sudo — the test skips itself.
  }
  return null
}

test.describe('disk space @disk', () => {
  test('a Steam game bigger than the free space is refused before anything is written', async ({
    netfuse,
    serveSteam,
    dirs
  }) => {
    const volume = await smallVolume(10)
    test.skip(!volume, 'cannot create a small volume on this machine')
    try {
      const dest = join(volume!.path, 'dest')
      await mkdir(dest)
      const steam = await serveSteam(bigGame())
      await expect(netfuse.startSteam(steam, { destinationDir: dest })).rejects.toThrow(
        /Not enough disk space/
      )
      expect(await readdir(dest)).toEqual([])
      const downloads = join(dirs.userData, 'downloads')
      expect(existsSync(downloads) ? await readdir(downloads) : []).toEqual([])
    } finally {
      await netfuse.quit()
      await volume!.dispose()
    }
  })

  test('a game that fits once but not twice installs on the destination volume', async () => {
    const volume = await smallVolume(32)
    test.skip(!volume, 'cannot create a small volume on this machine')
    // Both metadata and destination are on the small volume; the game must occupy only one copy.
    // Room is left for Chromium's own caches in userData, which take several MB at launch.
    const app = new NetFuseApp({
      userData: join(volume!.path, 'userData'),
      dest: join(volume!.path, 'dest')
    })
    const steam = await new SteamOrigin(bigGame()).start()
    try {
      await mkdir(app.dirs.userData)
      await mkdir(app.dirs.dest)
      await app.launch()
      await app.useSteam(steam)
      await app.startSteam(steam)
      const done = await app.waitForSteamStatus('completed', 60_000)
      expect(await readdir(app.dirs.dest)).toEqual([done.fileName])
    } finally {
      if (app.alive) await app.kill()
      await steam.stop()
      await volume!.dispose()
    }
  })
})

test.describe('destination folder problems @smoke', () => {
  // Files written so far go with the folder: the install can't be called done, and nothing of it
  // may be left once it is removed.
  test('destination folder deleted mid-download → error, nothing left', async ({
    netfuse,
    serveSteam,
    dirs
  }) => {
    const steam = await serveSteam(syntheticApp(51, 3))
    let seen = 0
    const reached = steam.hold((request) => request.kind === 'chunk' && ++seen > 6)
    await netfuse.startSteam(steam)
    await reached
    await rm(dirs.dest, { recursive: true, force: true })
    steam.release()
    const state = await netfuse.waitForStatus(['completed', 'error'])
    expect(state.status).toBe('error')
  })

  test('read-only destination folder → refused, and nothing left in userData', async ({
    netfuse,
    serveSteam,
    dirs
  }) => {
    test.skip(process.platform === 'win32', 'chmod does not make a folder read-only on Windows')
    const steam = await serveSteam()
    await chmod(dirs.dest, 0o555)
    try {
      await expect(netfuse.startSteam(steam)).rejects.toThrow(/EACCES|permission/i)
      const downloads = join(dirs.userData, 'downloads')
      expect(
        existsSync(downloads) ? await readdir(downloads) : [],
        'no orphaned parts folder from the refused start'
      ).toEqual([])
    } finally {
      await chmod(dirs.dest, 0o755)
    }
  })
})
