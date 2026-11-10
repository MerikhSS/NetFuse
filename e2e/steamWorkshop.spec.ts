import { join } from 'node:path'
import { expect, test, type NetFuseApp } from './fixtures'
import { syntheticApp, type SteamOrigin } from './steamOrigin'

// A game's Steam Workshop, through the API the window uses: listed in Steam's orders and searched,
// and an item downloaded into a folder named after it, through the same engine as a game, checked
// byte for byte by the automatic checks. The pure parts are in workshop.spec.ts.

const SHIPS = '3000000001'
const LANES = '3000000002'
const OLD_MAPS = '3000000003'

/** Holds every chunk request after the first `count`; resolves once one is held. */
function holdAfter(steam: SteamOrigin, count: number): Promise<void> {
  let seen = 0
  return steam.hold((request) => request.kind === 'chunk' && ++seen > count)
}

const titles = async (
  netfuse: NetFuseApp,
  query: Parameters<NetFuseApp['api']['steamWorkshop']>[0]
): Promise<string[]> => (await netfuse.api.steamWorkshop(query)).items.map((item) => item.title)

test.describe('the Steam Workshop', () => {
  test('a game’s Workshop is listed in Steam’s orders, and searched @smoke', async ({
    netfuse,
    serveSteam
  }) => {
    const steam = await serveSteam()
    await netfuse.loginSteam()
    const owned = await netfuse.api.steamOwnedApps()
    expect(owned.find((app) => app.appId === 4000)?.workshop).toBe(true)

    const popular = await netfuse.api.steamWorkshop({ appId: 4000, sort: 'popular' })
    expect(popular.total).toBe(3)
    expect(popular.nextCursor).toBeUndefined()
    expect(popular.items.map((item) => [item.title, item.downloadable])).toEqual([
      ['Faster Lanes', true],
      ['Bigger Ships', true],
      // Listed, but in Steam's old storage: not something NetFuse can fetch.
      ['Old Map Pack', false]
    ])
    expect(popular.items[1]).toMatchObject({
      publishedFileId: SHIPS,
      appId: 4000,
      description: 'Doubles the size of every ship in the game.',
      tags: ['Gameplay', 'Ships'],
      subscriptions: 9_000
    })
    // Most popular is a week's trend, as on Steam.
    expect(steam.workshopQueries[0]).toMatchObject({ queryType: 3, days: 7, cursor: '*' })

    expect(await titles(netfuse, { appId: 4000, sort: 'recent' })).toEqual([
      'Faster Lanes',
      'Bigger Ships',
      'Old Map Pack'
    ])
    expect(await titles(netfuse, { appId: 4000, sort: 'updated' })).toEqual([
      'Bigger Ships',
      'Faster Lanes',
      'Old Map Pack'
    ])
    expect(await titles(netfuse, { appId: 4000, sort: 'subscribed', search: 'ships' })).toEqual([
      'Bigger Ships'
    ])

    // Only the Workshops of games the account owns.
    await expect(netfuse.api.steamWorkshop({ appId: 99999, sort: 'popular' })).rejects.toThrow(
      /doesn’t own this game/
    )
    await expect(
      netfuse.api.steamWorkshop({ appId: 4000, sort: 'newest' as never })
    ).rejects.toThrow(/Choose what to list again/)
  })

  test('an item downloads into a folder named after it, from the game’s Workshop depot @smoke', async ({
    netfuse,
    serveSteam,
    dirs
  }) => {
    const steam = await serveSteam()
    await netfuse.startWorkshop(steam, SHIPS)
    const done = await netfuse.waitForSteamStatus('completed')
    expect(done.destinationPath).toBe(join(dirs.dest, 'Bigger Ships'))
    expect(done.workshop).toEqual({ publishedFileId: SHIPS, title: 'Bigger Ships' })
    expect(done.app.appId).toBe(4000)
    expect(done.depots.map((depot) => depot.depotId)).toEqual([4090])
    expect(done.url).toBe(`steam://url/CommunityFilePage/${SHIPS}`)
    // Only the Workshop depot was fetched from.
    expect(steam.chunkRequests().every((request) => request.depotId === 4090)).toBe(true)
    expect(steam.chunkRequests().length).toBeGreaterThan(0)

    // It stays a Workshop item in the history, apart from the game's own downloads.
    const history = await netfuse.api.listHistory()
    expect(history.find((entry) => entry.id === done.id)?.workshop?.title).toBe('Bigger Ships')
  })

  test('an item in Steam’s old storage, or not in the game’s Workshop, is refused', async ({
    netfuse,
    serveSteam,
    dirs
  }) => {
    const steam = await serveSteam()
    await netfuse.loginSteam()
    const prepare = (publishedFileId: string): Promise<unknown> =>
      netfuse.api.steamPrepareWorkshop({
        appId: steam.app.appId,
        publishedFileId,
        destinationDir: dirs.dest,
        adopt: false
      })
    await expect(prepare(OLD_MAPS)).rejects.toThrow(/old Workshop storage/)
    await expect(prepare('3999999999')).rejects.toThrow(/isn’t an item of this game’s Workshop/)
    await expect(prepare('0123')).rejects.toThrow(/Choose what to download again/)
  })

  test('quit and relaunched, a Workshop download resumes and finishes as one', async ({
    netfuse,
    serveSteam
  }) => {
    const steam = await serveSteam(syntheticApp(5, 3))
    const held = holdAfter(steam, 2)
    const id = await netfuse.startWorkshop(steam, SHIPS)
    await held
    await netfuse.quit()
    steam.release()

    await netfuse.launch()
    const restored = await netfuse.byId(id)
    expect(restored?.status).toBe('paused')
    expect(restored?.workshop?.title).toBe('Bigger Ships')
    await netfuse.loginSteam()
    await netfuse.api.resumeDownload(id)
    const done = await netfuse.waitForSteamStatus('completed')
    expect(done.workshop?.publishedFileId).toBe(SHIPS)
  })

  test('an item asked for again into its folder is up to date, and nothing is fetched', async ({
    netfuse,
    serveSteam
  }) => {
    const steam = await serveSteam()
    await netfuse.startWorkshop(steam, LANES)
    await netfuse.waitForSteamStatus('completed')
    const before = steam.chunkRequests().length
    // Asked again into the same folder, it's already up to date.
    await expect(
      netfuse.api.steamPrepareWorkshop({
        appId: 4000,
        publishedFileId: LANES,
        destinationDir: netfuse.dirs.dest,
        adopt: true
      })
    ).rejects.toThrow(/already up to date/)
    expect(steam.chunkRequests().length).toBe(before)
  })
})
