import { readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { Locator } from '@playwright/test'
import { expect, test, type NetFuseApp } from './fixtures'
import { syntheticApp, type SteamOrigin } from './steamOrigin'

// A game's Steam Workshop, through the API the window uses: listed in Steam's orders and searched,
// and an item downloaded into a folder named after it, through the same engine as a game, checked
// byte for byte by the automatic checks. Then the Workshop tab, driven as a person would. The pure
// parts are in workshop.spec.ts.

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

/** Loads `src` as the window would show a picture: its width, or 0 when it doesn't load. */
const loadPicture = (netfuse: NetFuseApp, src: string): Promise<number> =>
  netfuse.page.evaluate(
    (url) =>
      new Promise<number>((resolve) => {
        const image = new Image()
        image.onload = () => resolve(image.naturalWidth)
        image.onerror = () => resolve(0)
        image.src = url
      }),
    src
  )

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

  test('an item’s picture comes through the app, from Steam’s Workshop images, once', async ({
    netfuse,
    serveSteam
  }) => {
    const steam = await serveSteam()
    await netfuse.loginSteam()
    await netfuse.api.steamWorkshop({ appId: 4000, sort: 'popular' })
    expect(await loadPicture(netfuse, `game-art://workshop/${SHIPS}`)).toBe(64)
    // Kept on disk: asked for again, it isn't fetched again.
    expect(await loadPicture(netfuse, `game-art://workshop/${SHIPS}?again`)).toBe(64)
    expect(steam.workshopArtRequests).toEqual([SHIPS])
    // One the listing hasn't seen is looked up; a made-up id is nothing.
    await netfuse.relaunch()
    await netfuse.loginSteam()
    expect(await loadPicture(netfuse, `game-art://workshop/${LANES}`)).toBe(64)
    expect(steam.workshopArtRequests).toEqual([SHIPS, LANES])
    expect(await loadPicture(netfuse, 'game-art://workshop/0123')).toBe(0)
    expect(await loadPicture(netfuse, 'game-art://workshop/..%2F..%2Fsecret')).toBe(0)
  })
})

/** The folder picker is native OS UI: it answers with the test's folder. */
async function stubFolderPicker(netfuse: NetFuseApp, destination: string): Promise<void> {
  await netfuse.evaluateMain(({ dialog }, dest) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [dest] })) as never
  }, destination)
}

const nav = (netfuse: NetFuseApp, name: string): Locator =>
  netfuse.page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name, exact: true })
const items = (netfuse: NetFuseApp): Locator =>
  netfuse.page.getByRole('list', { name: 'Workshop items' }).getByRole('listitem')

test.describe('the Workshop tab', () => {
  test('lists a game’s Workshop, orders and searches it, and downloads an item @smoke', async ({
    netfuse,
    serveSteam,
    dirs
  }) => {
    const steam = await serveSteam()
    await stubFolderPicker(netfuse, dirs.dest)
    await netfuse.loginSteam()
    const page = netfuse.page

    // First the games with a Workshop, to choose one.
    await nav(netfuse, 'Workshop').click()
    await page
      .getByRole('list', { name: 'Games with a Workshop' })
      .getByRole('button', { name: 'NetFuse Test Game' })
      .click()
    await expect(page.getByRole('heading', { name: 'NetFuse Test Game Workshop' })).toBeVisible()
    await expect(items(netfuse)).toHaveText([
      /^Faster Lanes/,
      /^Bigger Ships/,
      // In Steam's old storage: listed, and said not to be downloadable.
      /^Old Map Pack.*Can’t be downloaded/
    ])
    // Each picture comes from Steam's Workshop images, through the app.
    await expect(items(netfuse).first().locator('img')).toHaveAttribute(
      'src',
      `game-art://workshop/${LANES}`
    )
    await expect(page.getByText('3 of 3')).toBeVisible()

    await page.getByRole('button', { name: 'Order' }).click()
    await page.getByRole('menuitemradio', { name: 'Recently updated' }).click()
    await expect(items(netfuse).first()).toContainText('Bigger Ships')
    expect(steam.workshopQueries.at(-1)).toMatchObject({ queryType: 21 })

    // A search lists the best matches, whatever the order.
    await page.getByLabel('Search the Workshop').fill('lanes')
    await expect(items(netfuse)).toHaveText([/^Faster Lanes/])
    await expect(page.getByRole('button', { name: 'Order' })).toHaveText('Best matches')
    await expect(page.getByRole('button', { name: 'Order' })).toBeDisabled()
    await page.getByLabel('Search the Workshop').fill('')
    await expect(items(netfuse)).toHaveCount(3)

    // An item's page: what it is, then where it goes.
    await items(netfuse).getByRole('button', { name: 'Bigger Ships' }).click()
    await expect(page.getByRole('heading', { name: 'Bigger Ships' })).toBeVisible()
    await expect(page.getByText('Doubles the size of every ship in the game.')).toBeVisible()
    await expect(page.getByLabel('Tags')).toHaveText('GameplayShips')
    await page.getByRole('button', { name: 'Change' }).click()
    await netfuse.expectNextDownload(steam.expectedWorkshopSha(SHIPS))
    await page.getByRole('button', { name: 'Download', exact: true }).click()

    // Started: its own screen opens, with the item's picture and name.
    await expect(page.getByRole('table', { name: 'Networks' })).toBeVisible()
    await expect(page.locator(`img[src="game-art://workshop/${SHIPS}"]`)).toBeVisible()
    const done = await netfuse.waitForSteamStatus('completed')
    expect(done.workshop?.publishedFileId).toBe(SHIPS)
    expect(done.destinationPath).toBe(join(dirs.dest, 'Bigger Ships'))

    // Back in the Workshop, where it was left: the item says it's downloaded, and where to.
    await nav(netfuse, 'Workshop').click()
    await expect(items(netfuse).first()).toContainText(/Bigger Ships\s*Downloaded/)
    await items(netfuse).getByRole('button', { name: 'Bigger Ships' }).click()
    await expect(page.getByRole('region', { name: 'Installed' })).toContainText(
      join(dirs.dest, 'Bigger Ships')
    )
    await expect(page.getByRole('heading', { name: 'Download again' })).toBeVisible()

    // One in Steam's old storage can't be downloaded, and its page says why.
    await page.getByRole('button', { name: 'NetFuse Test Game Workshop' }).click()
    await items(netfuse).getByRole('button', { name: 'Old Map Pack' }).click()
    await expect(page.getByText(/kept in Steam’s old Workshop storage/)).toBeVisible()
    await expect(page.getByRole('button', { name: 'Download', exact: true })).toHaveCount(0)

    // The game's own page leads to its Workshop, and its library card doesn't count the item.
    await nav(netfuse, 'Steam').click()
    await page
      .getByRole('list', { name: 'Your Steam library' })
      .getByRole('button', {
        name: 'NetFuse Test Game'
      })
      .click()
    await expect(page.getByRole('heading', { name: 'Install', exact: true })).toBeVisible()
    await page.getByRole('main').getByRole('button', { name: 'Workshop', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'NetFuse Test Game Workshop' })).toBeVisible()
  })

  test('a Workshop download started again opens the game’s Workshop, searched for it', async ({
    netfuse,
    serveSteam,
    dirs
  }) => {
    const steam = await serveSteam(syntheticApp(5, 3))
    const held = holdAfter(steam, 2)
    await netfuse.startWorkshop(steam, SHIPS)
    await held
    await netfuse.quit()
    steam.release()
    // Its folder gone while NetFuse was closed, it can't go on: only start again.
    await rm(join(dirs.dest, 'Bigger Ships'), { recursive: true, force: true })
    await netfuse.launch()
    await netfuse.loginSteam()

    await nav(netfuse, 'Downloads').click()
    await netfuse.page.getByRole('button', { name: 'Download again Bigger Ships' }).click()
    await expect(
      netfuse.page.getByRole('heading', { name: 'NetFuse Test Game Workshop' })
    ).toBeVisible()
    await expect(netfuse.page.getByLabel('Search the Workshop')).toHaveValue('Bigger Ships')
    await expect(items(netfuse)).toHaveText([/^Bigger Ships/])
    expect(await netfuse.api.listDownloads()).toEqual([])
  })
})

// Games the account doesn't own: Steam decides game by game whether its anonymous account may have
// a Workshop, as SteamCMD's "login anonymous" finds. Only with the Workshop tab's switch on.
const STORE_GAMES = [
  { appId: 7001, name: 'Open Sandbox', open: true },
  { appId: 7002, name: 'Closed Strategy', open: false },
  // The store lists a soundtrack beside its game: not a game with a Workshop of its own.
  { appId: 7003, name: 'Open Sandbox Soundtrack', open: true, type: 'Music' }
]

test.describe('Workshops of games the account doesn’t own', () => {
  test('with the switch on, a Workshop Steam opens to everyone downloads through its anonymous account @smoke', async ({
    netfuse,
    serveSteam,
    dirs
  }) => {
    const steam = await serveSteam(undefined, {
      ownsApp: false,
      anonymousWorkshop: true,
      storeWorkshops: STORE_GAMES
    })
    await netfuse.loginSteam()
    const prepare = (): Promise<unknown> =>
      netfuse.api.steamPrepareWorkshop({
        appId: 4000,
        publishedFileId: SHIPS,
        destinationDir: dirs.dest,
        adopt: false
      })

    // Off, as it starts: neither listed nor downloaded, and nothing asked anonymously.
    await expect(netfuse.api.steamWorkshop({ appId: 4000, sort: 'popular' })).rejects.toThrow(
      /doesn’t own this game/
    )
    await expect(netfuse.api.steamWorkshopGames({})).rejects.toThrow(/doesn’t own this game/)
    await expect(prepare()).rejects.toThrow(/doesn’t own this game/)
    expect(steam.anonymousRequests).toEqual([])

    await netfuse.api.updateSettings({ workshopAnonymous: true })
    // The store's games with a Workshop, in its order, those Steam keeps to their owners left out.
    const page = await netfuse.api.steamWorkshopGames({})
    expect(page).toEqual({
      games: [
        { appId: 4000, name: 'NetFuse Test Game', owned: false },
        { appId: 7001, name: 'Open Sandbox', owned: false }
      ]
    })
    expect(steam.storeSearches[0].get('category2')).toBe('30')
    expect((await netfuse.api.steamWorkshopGames({ search: 'sandbox' })).games).toEqual([
      { appId: 7001, name: 'Open Sandbox', owned: false }
    ])
    expect(steam.storeSearches.at(-1)?.get('term')).toBe('sandbox')

    expect(await titles(netfuse, { appId: 4000, sort: 'popular' })).toEqual([
      'Faster Lanes',
      'Bigger Ships',
      'Old Map Pack'
    ])
    await expect(netfuse.api.steamWorkshop({ appId: 7002, sort: 'popular' })).rejects.toThrow(
      /doesn’t let anyone download this game’s Workshop/
    )

    await netfuse.startWorkshop(steam, SHIPS)
    const done = await netfuse.waitForSteamStatus('completed')
    expect(done.workshop).toEqual({
      publishedFileId: SHIPS,
      title: 'Bigger Ships',
      anonymous: true
    })
    expect(done.destinationPath).toBe(join(dirs.dest, 'Bigger Ships'))

    // The anonymous account was asked for Workshop depots' keys, never a game's own depots.
    const asked = steam.anonymousRequests.filter((request) =>
      /^\/cm\/(depotkey|requestcode|token)/.test(request)
    )
    expect(asked.length).toBeGreaterThan(0)
    expect(asked.every((request) => /depot=(4090|7001|7002)(&|$)/.test(request))).toBe(true)
    // And the game itself still isn't the account's to download.
    await expect(
      netfuse.api.steamPrepare({
        appId: 4000,
        branch: 'public',
        depotIds: [4001],
        destinationDir: dirs.dest,
        adopt: false
      })
    ).rejects.toThrow(/doesn’t own this app/)
  })

  test('a Workshop Steam keeps to the game’s owners is neither listed nor downloaded', async ({
    netfuse,
    serveSteam,
    dirs
  }) => {
    await serveSteam(undefined, { ownsApp: false, storeWorkshops: STORE_GAMES })
    await netfuse.loginSteam()
    await netfuse.api.updateSettings({ workshopAnonymous: true })
    expect((await netfuse.api.steamWorkshopGames({})).games).toEqual([
      { appId: 7001, name: 'Open Sandbox', owned: false }
    ])
    await expect(netfuse.api.steamWorkshop({ appId: 4000, sort: 'popular' })).rejects.toThrow(
      /doesn’t let anyone download this game’s Workshop/
    )
    await expect(
      netfuse.api.steamPrepareWorkshop({
        appId: 4000,
        publishedFileId: SHIPS,
        destinationDir: dirs.dest,
        adopt: false
      })
    ).rejects.toThrow(/doesn’t let anyone download this game’s Workshop/)
  })

  test('the account’s own game is still its own, with the switch on', async ({
    netfuse,
    serveSteam
  }) => {
    const steam = await serveSteam(undefined, { storeWorkshops: STORE_GAMES })
    await netfuse.loginSteam()
    await netfuse.api.updateSettings({ workshopAnonymous: true })
    expect((await netfuse.api.steamWorkshopGames({})).games).toEqual([
      { appId: 4000, name: 'NetFuse Test Game', owned: true },
      { appId: 7001, name: 'Open Sandbox', owned: false }
    ])
    await netfuse.startWorkshop(steam, LANES)
    const done = await netfuse.waitForSteamStatus('completed')
    expect(done.workshop).toEqual({ publishedFileId: LANES, title: 'Faster Lanes' })
    expect(steam.anonymousRequests.some((request) => request.includes('depot=4090'))).toBe(false)
  })

  test('quit and relaunched, an anonymous download resumes with no login of the user’s', async ({
    netfuse,
    serveSteam
  }) => {
    const steam = await serveSteam(syntheticApp(5, 3), { ownsApp: false, anonymousWorkshop: true })
    await netfuse.loginSteam()
    await netfuse.api.updateSettings({ workshopAnonymous: true })
    const held = holdAfter(steam, 2)
    const id = await netfuse.startWorkshop(steam, SHIPS)
    await held
    await netfuse.quit()
    steam.release()

    await netfuse.launch()
    expect((await netfuse.api.steamLoginState()).status).toBe('logged-out')
    const restored = await netfuse.byId(id)
    expect(restored?.workshop).toMatchObject({ title: 'Bigger Ships', anonymous: true })
    await netfuse.api.resumeDownload(id)
    const done = await netfuse.waitForSteamStatus('completed')
    expect(done.workshop?.anonymous).toBe(true)
  })

  test('the switch in the window lists the store’s open Workshops, and an item downloads @smoke', async ({
    netfuse,
    serveSteam,
    dirs
  }) => {
    const steam = await serveSteam(undefined, {
      ownsApp: false,
      anonymousWorkshop: true,
      storeWorkshops: STORE_GAMES
    })
    await stubFolderPicker(netfuse, dirs.dest)
    await netfuse.loginSteam()
    const page = netfuse.page
    const games = page.getByRole('list', { name: 'Games with a Workshop' })

    await nav(netfuse, 'Workshop').click()
    await expect(
      page.getByText('None of the games this account owns has a Steam Workshop.')
    ).toBeVisible()
    await page.getByRole('switch', { name: 'Games you don’t own' }).click()
    await expect(games.getByRole('button')).toHaveText(['NetFuse Test Game', 'Open Sandbox'])
    // Kept: the next time the window opens, it's on.
    await expect
      .poll(async () => {
        const saved = await readFile(join(dirs.userData, 'app-settings.json'), 'utf8')
        return JSON.parse(saved).workshopAnonymous
      })
      .toBe(true)

    await page.getByLabel('Search Steam').fill('sandbox')
    await expect(games.getByRole('button')).toHaveText(['Open Sandbox'])
    await page.getByLabel('Search Steam').fill('')
    await games.getByRole('button', { name: 'NetFuse Test Game' }).click()
    await expect(page.getByRole('heading', { name: 'NetFuse Test Game Workshop' })).toBeVisible()
    await items(netfuse).getByRole('button', { name: 'Bigger Ships' }).click()
    await expect(page.getByText(/comes through Steam’s anonymous account/)).toBeVisible()
    await page.getByRole('button', { name: 'Change' }).click()
    await netfuse.expectNextDownload(steam.expectedWorkshopSha(SHIPS))
    await page.getByRole('button', { name: 'Download', exact: true }).click()
    await expect(page.getByRole('table', { name: 'Networks' })).toBeVisible()
    const done = await netfuse.waitForSteamStatus('completed')
    expect(done.workshop?.anonymous).toBe(true)
  })
})
