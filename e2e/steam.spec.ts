import { lstat, readlink, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, LAN_ADDRESS, test } from './fixtures'
import { OWNED_DEPOTS, syntheticApp } from './steamOrigin'

// A Steam download from login to the last chunk, against the fake Steam in steamOrigin.ts: real
// manifests and chunks, fetched over the app's pinned connections and checked before they are
// written. The automatic checks (fixtures.ts) compare the install with the game's files.

test.describe('steam downloads', () => {
  test('installs an owned game, its links, executables and empty files too @smoke', async ({
    netfuse,
    serveSteam
  }) => {
    const steam = await serveSteam(syntheticApp(), { guard: 'email' })
    await netfuse.startSteam(steam)
    const done = await netfuse.waitForSteamStatus('completed')

    expect(done.destinationPath).toBe(join(netfuse.dirs.dest, 'NetFuse Test Game'))
    expect(done.chunksDone).toBe(done.totalChunks)
    expect(done.app).toMatchObject({ appId: 4000, name: 'NetFuse Test Game', branch: 'public' })
    expect(done.depots.map((depot) => depot.depotId)).toEqual(OWNED_DEPOTS)
    // treeSha counts regular files only: the rest is checked here.
    const link = join(done.destinationPath, 'game.sh')
    expect((await lstat(link)).isSymbolicLink()).toBe(true)
    expect(await readlink(link)).toBe('bin/game')
    if (process.platform !== 'win32') {
      expect((await stat(join(done.destinationPath, 'bin/game'))).mode & 0o111).not.toBe(0)
      expect((await stat(join(done.destinationPath, 'extras/art.bin'))).mode & 0o111).toBe(0)
    }
    expect((await stat(join(done.destinationPath, 'data/empty.txt'))).size).toBe(0)
    // The soundtrack depot isn't owned: none of it is installed.
    await expect(lstat(join(done.destinationPath, 'soundtrack'))).rejects.toThrow()
  })

  test('fetches each distinct chunk once, however many places it goes @smoke', async ({
    netfuse,
    serveSteam
  }) => {
    const steam = await serveSteam()
    await netfuse.startSteam(steam)
    await netfuse.waitForSteamStatus('completed')
    const fetched = steam.chunkRequests().map((entry) => `${entry.depotId}/${entry.sha}`)
    expect(fetched.sort()).toEqual(steam.uniqueChunks().sort())
  })

  test('spreads the chunks over two networks @smoke', async ({ netfuse, serveSteam }) => {
    test.skip(!LAN_ADDRESS, 'needs a second test network')
    const steam = await serveSteam(syntheticApp(2, 6), { bytesPerSecond: 2 * 1024 * 1024 })
    await netfuse.startSteam(steam, { networks: ['a', 'b'] })
    const done = await netfuse.waitForSteamStatus('completed', 40_000)
    for (const network of done.networks) {
      expect(network.bytesDownloaded, `network ${network.id}`).toBeGreaterThan(0)
    }
    const sources = new Set(steam.chunkRequests().map((entry) => entry.from))
    expect(sources).toEqual(new Set(['127.0.0.1', LAN_ADDRESS]))
  })

  test('refuses a depot the account isn’t licensed for, and a password branch @smoke', async ({
    netfuse,
    serveSteam
  }) => {
    const steam = await serveSteam()
    await netfuse.loginSteam()
    const details = await netfuse.api.steamAppDetails(steam.app.appId)
    expect(details.depots.find((depot) => depot.depotId === 4003)?.owned).toBe(false)
    expect(details.branches.find((branch) => branch.name === 'beta')?.passwordRequired).toBe(true)

    const prepare = (depotIds: number[], branch = 'public'): Promise<unknown> =>
      netfuse.api.steamPrepare({
        appId: steam.app.appId,
        branch,
        depotIds,
        destinationDir: netfuse.dirs.dest,
        adopt: false
      })
    await expect(prepare([4001, 4003])).rejects.toThrow(/isn’t licensed|not owned|doesn’t own/i)
    await expect(prepare([4001], 'beta')).rejects.toThrow(/Password-protected branches/)
    // Nothing was fetched for either, and nothing was made.
    expect(steam.chunkRequests()).toEqual([])
    expect((await netfuse.api.listDownloads()).length).toBe(0)
  })
})
