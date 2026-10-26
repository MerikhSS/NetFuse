import { existsSync } from 'node:fs'
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  expect,
  expectSteam,
  interfacesEnv,
  LAN_ADDRESS,
  NETWORKS,
  test,
  type NetFuseApp
} from './fixtures'
import { syntheticApp, type LoggedSteamRequest, type SteamOrigin } from './steamOrigin'

// A Steam download paused, crashed, quit, cut off from a network, cancelled, and installed over
// a folder that already has the game in it. What a run has written and saved is kept; what it
// hadn't is fetched again; nothing of the user's is ever removed.

const INSTALL = 'NetFuse Test Game'

/** Holds every chunk request after the first `count`; resolves once one is held. */
function holdAfter(steam: SteamOrigin, count: number): Promise<void> {
  let seen = 0
  return steam.hold((request) => request.kind === 'chunk' && ++seen > count)
}

const fullyServed = (steam: SteamOrigin, entry: LoggedSteamRequest): boolean =>
  entry.status === 200 &&
  entry.bytesSent === steam.manifests.get(entry.depotId)?.chunks.get(entry.sha!)?.body.length

const setNetworks = (netfuse: NetFuseApp, networks: Record<string, string>): Promise<void> =>
  netfuse.evaluateMain((_electron, value) => {
    process.env['NETFUSE_E2E_INTERFACES'] = value
  }, interfacesEnv(networks))

test.describe('steam lifecycle', () => {
  test('pauses and resumes, its progress kept @smoke', async ({ netfuse, serveSteam }) => {
    const steam = await serveSteam(syntheticApp(4, 3))
    const held = holdAfter(steam, 4)
    const id = await netfuse.startSteam(steam)
    await held
    await netfuse.waitUntil((state) => expectSteam(state).chunksDone >= 4)

    await netfuse.api.pauseDownload(id)
    const paused = await netfuse.waitForSteamStatus('paused')
    expect(paused.chunksDone).toBe(4)
    expect(paused.streams.every((stream) => stream.status === 'paused')).toBe(true)

    steam.release()
    await netfuse.api.resumeDownload(id)
    const done = await netfuse.waitForSteamStatus('completed')
    expect(done.chunksDone).toBe(done.totalChunks)
  })

  test('killed and relaunched, it fetches only what it hadn’t saved @smoke', async ({
    netfuse,
    serveSteam
  }) => {
    const steam = await serveSteam(syntheticApp(5, 3))
    const held = holdAfter(steam, 6)
    const id = await netfuse.startSteam(steam)
    await held
    await netfuse.waitUntil((state) => expectSteam(state).chunksDone >= 6)
    // A pause saves its progress, synced: what a checkpoint does every 15 s.
    await netfuse.api.pauseDownload(id)
    await netfuse.api.resumeDownload(id)
    await netfuse.waitUntil((state) => state.status === 'downloading')
    await netfuse.kill()
    const before = steam.log.length
    const saved = new Set(
      steam
        .chunkRequests()
        .filter((entry) => fullyServed(steam, entry))
        .map((entry) => `${entry.depotId}/${entry.sha}`)
    )
    expect(saved.size).toBe(6)
    steam.release()

    await netfuse.launch()
    const restored = expectSteam((await netfuse.byId(id))!)
    expect(restored.status).toBe('paused')
    expect(restored.chunksDone).toBe(6)
    // A login isn't kept without the system keychain: the test logs in again, as the user would.
    await netfuse.loginSteam()
    await netfuse.api.resumeDownload(id)
    await netfuse.waitForSteamStatus('completed')
    const again = steam.log
      .slice(before)
      .filter((entry) => entry.kind === 'chunk' && saved.has(`${entry.depotId}/${entry.sha}`))
    expect(again, 'a chunk saved as done is never fetched again').toEqual([])
  })

  test('killed mid-chunk with nothing saved, it still installs every byte right', async ({
    netfuse,
    serveSteam
  }) => {
    const steam = await serveSteam(syntheticApp(6, 3))
    const held = holdAfter(steam, 3)
    const id = await netfuse.startSteam(steam)
    await held
    await netfuse.kill()
    steam.release()

    await netfuse.launch()
    expect((await netfuse.byId(id))?.status).toBe('paused')
    await netfuse.loginSteam()
    await netfuse.api.resumeDownload(id)
    await netfuse.waitForSteamStatus('completed')
  })

  test('quit and relaunched, it goes on by itself once Steam is logged in again', async ({
    netfuse,
    serveSteam
  }) => {
    const steam = await serveSteam(syntheticApp(7, 3))
    const held = holdAfter(steam, 3)
    const id = await netfuse.startSteam(steam)
    await held
    await netfuse.quit()
    steam.release()

    await netfuse.launch()
    expect((await netfuse.byId(id))?.status).toBe('paused')
    // Not logged in: the download says so, and keeps what it has.
    await netfuse.api.resumeDownload(id)
    const stopped = await netfuse.waitForSteamStatus('error', 45_000)
    expect(stopped.error).toBe('Log in to Steam to continue.')
    expect(stopped.resumable).not.toBe(false)
    expect(stopped.chunksDone).toBeGreaterThan(0)

    await netfuse.loginSteam()
    await netfuse.waitForSteamStatus('completed')
  })

  test('files removed while it was paused are fetched again', async ({ netfuse, serveSteam }) => {
    const steam = await serveSteam(syntheticApp(8, 2))
    const held = holdAfter(steam, 5)
    const id = await netfuse.startSteam(steam)
    await held
    await netfuse.waitUntil((state) => expectSteam(state).chunksDone >= 5)
    await netfuse.api.pauseDownload(id)
    const paused = await netfuse.waitForSteamStatus('paused')

    const folder = join(netfuse.dirs.dest, INSTALL)
    for (const entry of await readdir(folder, { recursive: true, withFileTypes: true })) {
      if (entry.isFile()) await rm(join(entry.parentPath, entry.name))
    }
    const before = steam.log.length
    steam.release()
    await netfuse.api.resumeDownload(id)
    await netfuse.waitForSteamStatus('completed')
    const fetched = steam.log.slice(before).filter((entry) => entry.kind === 'chunk')
    expect(fetched.length).toBeGreaterThanOrEqual(paused.totalChunks)
  })

  test('cancelled, it removes what it installed and nothing else @smoke', async ({
    netfuse,
    serveSteam
  }) => {
    const steam = await serveSteam(syntheticApp(9, 2))
    const held = holdAfter(steam, 3)
    const id = await netfuse.startSteam(steam)
    await held
    const folder = join(netfuse.dirs.dest, INSTALL)
    await mkdir(join(folder, 'saves'), { recursive: true })
    await writeFile(join(folder, 'saves', 'slot1.sav'), 'mine')
    await writeFile(join(folder, 'data', 'notes.txt'), 'also mine')

    await netfuse.api.cancelDownload(id)
    steam.release()
    await netfuse.waitForSteamStatus('cancelled')
    const left = (await readdir(folder, { recursive: true })).map((name) =>
      name.split('\\').join('/')
    )
    expect(left.sort()).toEqual(['data', 'data/notes.txt', 'saves', 'saves/slot1.sav'])

    // Cleared up, so that the automatic checks see the folder as the cancel should leave it
    // with nothing of the user's in it: gone.
    await rm(folder, { recursive: true })
  })

  test('cancelled before anything came in, it leaves no folder behind', async ({
    netfuse,
    serveSteam
  }) => {
    const steam = await serveSteam()
    const held = holdAfter(steam, 0)
    const id = await netfuse.startSteam(steam)
    await held
    await netfuse.api.cancelDownload(id)
    steam.release()
    await netfuse.waitForSteamStatus('cancelled')
    expect(existsSync(join(netfuse.dirs.dest, INSTALL))).toBe(false)
  })

  test('installs over an existing folder, fetching only what is missing or wrong @smoke', async ({
    netfuse,
    serveSteam
  }) => {
    const steam = await serveSteam(syntheticApp(10, 2))
    const first = await netfuse.startSteam(steam)
    await netfuse.waitForSteamStatus('completed')
    // History forgets the first install; its folder stays, as it would with Steam's own.
    await netfuse.api.removeDownload(first)
    netfuse.tracked.delete(first)

    const folder = join(netfuse.dirs.dest, INSTALL)
    await rm(join(folder, 'extras', 'art.bin'))
    await writeFile(join(folder, 'data', 'nested', 'deep', 'readme.txt'), 'changed by the user')
    await mkdir(join(folder, 'saves'))
    await writeFile(join(folder, 'saves', 'slot1.sav'), 'mine')
    const before = steam.log.length

    const plan = await netfuse.api.steamPrepare({
      appId: steam.app.appId,
      branch: 'public',
      depotIds: [4001, 4002, 4004],
      destinationDir: netfuse.dirs.dest,
      adopt: true
    })
    expect(plan.presentBytes).toBeGreaterThan(0)
    const art = [...steam.manifests.get(4002)!.chunks.values()]
    expect(plan.downloadBytes).toBeLessThan(
      [...steam.manifests.values()].reduce(
        (sum, manifest) =>
          sum +
          [...manifest.chunks.values()].reduce((total, chunk) => total + chunk.body.length, 0),
        0
      )
    )
    expect(art.length).toBeGreaterThan(0)

    const id = await netfuse.api.startDownload({
      kind: 'steam',
      planId: plan.planId,
      interfaceIds: ['a']
    })
    netfuse.tracked.set(id, {
      expectedSha: steam.expectedSha(),
      destBefore: await readdir(netfuse.dirs.dest),
      destinationDir: netfuse.dirs.dest
    })
    const done = await netfuse.waitForSteamStatus('completed')
    expect(done.adopted).toBe(true)
    const refetched = steam.log.slice(before).filter((entry) => entry.kind === 'chunk')
    expect(refetched.length).toBe(done.totalChunks)
    expect(refetched.length).toBeLessThan(steam.uniqueChunks().length)
    expect(existsSync(join(folder, 'saves', 'slot1.sav'))).toBe(true)
    // The user's save is theirs: taken out only so that the automatic checks compare the game.
    await rm(join(folder, 'saves'), { recursive: true })
  })

  test('a plan is started once: a second start of it is refused', async ({
    netfuse,
    serveSteam
  }) => {
    const steam = await serveSteam()
    await netfuse.loginSteam()
    const plan = await netfuse.api.steamPrepare({
      appId: steam.app.appId,
      branch: 'public',
      depotIds: [4001],
      destinationDir: netfuse.dirs.dest,
      adopt: false
    })
    const id = await netfuse.api.startDownload({
      kind: 'steam',
      planId: plan.planId,
      interfaceIds: ['a']
    })
    netfuse.tracked.set(id, {
      expectedSha: steam.expectedSha([4001]),
      destBefore: [],
      destinationDir: netfuse.dirs.dest
    })
    await expect(
      netfuse.api.startDownload({ kind: 'steam', planId: plan.planId, interfaceIds: ['a'] })
    ).rejects.toThrow(/expired/)
    await netfuse.waitForSteamStatus('completed')
  })

  test.describe('two networks', () => {
    test.skip(!LAN_ADDRESS, 'needs a second test network')

    test('a network that goes away mid-download leaves the rest to the other @smoke', async ({
      netfuse,
      serveSteam
    }) => {
      const steam = await serveSteam(syntheticApp(11, 6), { bytesPerSecond: 512 * 1024 })
      await netfuse.startSteam(steam, { networks: ['a', 'b'] })
      await netfuse.waitUntil(
        (state) => (state.networks.find((network) => network.id === 'b')?.bytesDownloaded ?? 0) > 0
      )
      await setNetworks(netfuse, { a: NETWORKS['a'] })
      const gone = await netfuse.waitUntil(
        (state) => state.networks.find((network) => network.id === 'b')?.status === 'offline'
      )
      expect(gone.status).toBe('downloading')
      const goneAt = steam.log.length
      await netfuse.waitForSteamStatus('completed', 60_000)
      const overB = steam.log.slice(goneAt + 4).filter((entry) => entry.from !== '127.0.0.1')
      expect(overB, 'nothing more over b once it was gone').toEqual([])
    })
  })
})
