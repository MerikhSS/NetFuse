import { mkdir, readdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { Locator } from '@playwright/test'
import { expect, test, type NetFuseApp } from './fixtures'
import { ACCOUNT, gradientPng, GUARD_CODE } from './steamOrigin'

// The window, driven as a person would: logging in on the screen it opens on, the library, a
// game's page and its choices, ending on the download's own screen. What it downloads is checked
// by the automatic checks, as for the API-level specs.

/** The folder picker is native OS UI: it answers with the test's folder. */
async function stubFolderPicker(netfuse: NetFuseApp, destination: string): Promise<void> {
  await netfuse.evaluateMain(({ dialog }, dest) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [dest] })) as never
  }, destination)
}

const library = (netfuse: NetFuseApp): Locator =>
  netfuse.page.getByRole('list', { name: 'Your Steam library' })
const nav = (netfuse: NetFuseApp, name: string): Locator =>
  netfuse.page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name, exact: true })

/** Starts the download from a game's page. On Windows the test game's links bring a warning
 * first (see steam/prepare.ts), and it's started anyway. */
async function clickDownload(netfuse: NetFuseApp): Promise<void> {
  await netfuse.page.getByRole('button', { name: 'Download', exact: true }).click()
  if (process.platform === 'win32') {
    await expect(netfuse.page.getByText(/This game has symbolic links/)).toBeVisible()
    await netfuse.page.getByRole('button', { name: 'Download anyway' }).click()
  }
}

/** Opens a game's page from the library, as clicking its picture does. */
async function openGame(netfuse: NetFuseApp, name: string): Promise<void> {
  await library(netfuse).getByRole('button', { name }).click()
  await expect(netfuse.page.getByRole('heading', { name })).toBeVisible()
}

test.describe('the window', () => {
  test('logs in with a Guard code, picks a game from the library and downloads it @smoke', async ({
    netfuse,
    serveSteam,
    dirs
  }) => {
    const steam = await serveSteam(undefined, { guard: 'email' })
    await stubFolderPicker(netfuse, dirs.dest)
    const page = netfuse.page

    // Logged out, the window opens on the login and nothing else.
    const login = page.getByRole('region', { name: 'Steam login' })
    await expect(login).toBeVisible()
    await expect(page.getByRole('navigation', { name: 'Main' })).toBeHidden()
    await login.getByLabel('Account name', { exact: true }).fill(ACCOUNT.name)
    await login.getByLabel('Password').fill('not it')
    await login.getByRole('button', { name: 'Log in' }).click()
    await expect(login.getByRole('alert')).toHaveText('The account name or password is wrong.')
    // The password field is cleared as soon as it's handed over.
    await expect(login.getByLabel('Password')).toHaveValue('')

    await login.getByLabel('Password').fill(ACCOUNT.password)
    await login.getByRole('button', { name: 'Log in' }).click()
    await expect(login.getByText('Steam sent a code to your email at …@example.com.')).toBeVisible()
    await login.getByLabel('Steam Guard code').fill('WRONG')
    await login.getByRole('button', { name: 'Continue' }).click()
    await expect(login.getByRole('alert')).toHaveText(/Steam Guard code isn’t right/)
    await login.getByLabel('Steam Guard code').fill(GUARD_CODE)
    await login.getByRole('button', { name: 'Continue' }).click()

    // Logged in: the library, with the account at the foot of the sidebar.
    await expect(library(netfuse)).toBeVisible()
    await expect(page.getByRole('button', { name: `Steam account ${ACCOUNT.name}` })).toBeVisible()
    await page.getByLabel('Search your library').fill('test game')
    await openGame(netfuse, 'NetFuse Test Game')

    const depots = page.getByRole('group', { name: 'Depots' })
    await expect(
      depots.getByRole('checkbox', { name: /^NetFuse Test Game Content Depot/ })
    ).toBeChecked()
    await expect(
      depots.getByRole('checkbox', { name: /^NetFuse Test Game DLC Depot/ })
    ).toBeChecked()
    // Not owned: offered as such, and not picked.
    await expect(
      depots.getByRole('checkbox', { name: /^NetFuse Test Game Soundtrack Depot/ })
    ).toBeDisabled()
    await expect(depots.getByText(/Not owned by this account/)).toBeVisible()
    await expect(
      page.getByText(/3 of 4 depots · .* installed · .* to download · .* free/)
    ).toBeVisible()

    await page.getByRole('button', { name: 'Change' }).click()
    await netfuse.expectNextDownload(steam.expectedSha())
    await clickDownload(netfuse)

    // Started: its own screen opens.
    await expect(page.getByRole('table', { name: 'Networks' })).toBeVisible()
    await netfuse.waitForSteamStatus('completed')
    await expect(page.getByText('NetFuse Test Game').first()).toBeVisible()

    // Back in the library, the game says it's installed, and on its page where.
    await nav(netfuse, 'Steam').click()
    await page.getByLabel('Search your library').fill('')
    await expect(library(netfuse).getByRole('listitem').first()).toContainText('Installed')
    await openGame(netfuse, 'NetFuse Test Game')
    await expect(page.getByRole('region', { name: 'Installed' })).toContainText(
      join(dirs.dest, 'NetFuse Test Game')
    )
    await expect(page.getByRole('heading', { name: 'Install again' })).toBeVisible()
  })

  test('a download from before a relaunch is kept, and resumes from Downloads once logged in', async ({
    netfuse,
    serveSteam
  }) => {
    const steam = await serveSteam()
    let seen = 0
    const held = steam.hold((request) => request.kind === 'chunk' && ++seen > 2)
    await netfuse.startSteam(steam)
    await held
    await netfuse.quit()
    steam.release()
    await netfuse.launch()

    const login = netfuse.page.getByRole('region', { name: 'Steam login' })
    await expect(login).toBeVisible()
    await login.getByLabel('Account name', { exact: true }).fill(ACCOUNT.name)
    await login.getByLabel('Password').fill(ACCOUNT.password)
    await login.getByRole('button', { name: 'Log in' }).click()
    await expect(library(netfuse)).toBeVisible()
    // The library says where it got to.
    await expect(library(netfuse).getByRole('listitem').first()).toContainText(/Paused at \d+%/)

    await nav(netfuse, 'Downloads').click()
    await netfuse.page.getByRole('button', { name: 'Resume NetFuse Test Game' }).click()
    await netfuse.waitForSteamStatus('completed')
  })

  test('the library searches, filters, and draws only the games in view', async ({
    netfuse,
    serveSteam
  }) => {
    const otherApps = Array.from({ length: 400 }, (_, index) => ({
      appId: 10_000 + index * 10,
      name: `Game ${String(index).padStart(3, '0')}`,
      borrowed: index === 0
    }))
    const steam = await serveSteam(undefined, { otherApps })
    // One game with only a landscape header, as old games have.
    steam.art.set('/10010/header.jpg', gradientPng(92, 43, [40, 120, 90], [10, 30, 20]))
    await netfuse.loginSteam()
    const page = netfuse.page
    await expect(library(netfuse).getByRole('button', { name: 'Game 000' })).toBeVisible()
    // Hundreds owned, a screenful drawn.
    expect(await library(netfuse).getByRole('listitem').count()).toBeLessThan(80)
    await expect(library(netfuse).getByRole('listitem').first()).toContainText('Family Sharing')

    // A picture comes from Steam once: going away and back asks for none again.
    await expect
      .poll(() => steam.artRequests.filter((path) => path.startsWith('/10010/')))
      .toEqual(['/10010/library_600x900.jpg', '/10010/header.jpg'])
    await nav(netfuse, 'Downloads').click()
    await nav(netfuse, 'Steam').click()
    await expect(library(netfuse).getByRole('button', { name: 'Game 000' })).toBeVisible()
    expect(steam.artRequests.filter((path) => path.startsWith('/10010/'))).toHaveLength(2)

    await page.getByLabel('Search your library').fill('game 39')
    await expect(library(netfuse).getByRole('listitem')).toHaveCount(10)
    await page.getByLabel('Search your library').fill('')
    await page
      .getByRole('group', { name: 'Show' })
      .getByRole('button', { name: 'Installed', exact: true })
      .click()
    await expect(page.getByText('Nothing in your library matches')).toBeVisible()
    await page.getByRole('button', { name: 'Show everything' }).click()
    await expect(library(netfuse).getByRole('button', { name: 'Game 000' })).toBeVisible()
  })

  test('the library lists games by default, and tools or both when asked', async ({
    netfuse,
    serveSteam
  }) => {
    const otherApps = [
      { appId: 7010, name: 'Level Editor', type: 'Tool' },
      { appId: 7020, name: 'Wallpaper Studio', type: 'Application' },
      { appId: 7030, name: 'Starfall Demo', type: 'Demo' }
    ]
    await serveSteam(undefined, { otherApps })
    await netfuse.loginSteam()
    const page = netfuse.page
    const names = (): Promise<string[]> =>
      library(netfuse)
        .getByRole('button')
        .evaluateAll((buttons) => buttons.map((button) => button.getAttribute('aria-label') ?? ''))

    await expect(library(netfuse).getByRole('button', { name: 'NetFuse Test Game' })).toBeVisible()
    expect(await names()).toEqual(['NetFuse Test Game', 'Starfall Demo'])

    const show = async (label: string): Promise<void> => {
      await page
        .getByRole('heading')
        .getByRole('button', { name: /^(Games|Tools|Games & tools)$/ })
        .click()
      // Each says how many it has, after its name.
      await page.getByRole('menuitemradio', { name: new RegExp(`^${label}`) }).click()
    }
    await show('Tools')
    await expect(library(netfuse).getByRole('button', { name: 'Level Editor' })).toBeVisible()
    expect(await names()).toEqual(['Level Editor', 'Wallpaper Studio'])
    await show('Games & tools')
    await expect(library(netfuse).getByRole('button')).toHaveCount(4)

    // The choice holds while the window shows other things.
    await nav(netfuse, 'Downloads').click()
    await nav(netfuse, 'Steam').click()
    await expect(
      page.getByRole('heading').getByRole('button', { name: 'Games & tools' })
    ).toBeVisible()
  })

  test('Auto-detect finds the Steam libraries, and installs into the one that has the game', async ({
    netfuse,
    serveSteam,
    dirs
  }) => {
    const steam = await serveSteam()
    // A Steam client with two libraries; the second already has part of the game.
    const root = join(dirname(dirs.dest), 'Steam')
    const other = join(dirname(dirs.dest), 'SteamLibrary')
    const game = join(other, 'steamapps', 'common', 'NetFuse Test Game')
    await mkdir(join(root, 'steamapps', 'common'), { recursive: true })
    await mkdir(join(game, 'bin'), { recursive: true })
    const binGame = steam.app.depots[0].files.find((file) => file.name === 'bin/game')!.data!
    await writeFile(join(game, 'bin', 'game'), binGame)
    // Steam lists it as installed there.
    await writeFile(join(other, 'steamapps', 'appmanifest_4000.acf'), '"AppState" {}')
    const vdfPath = (path: string): string => path.replaceAll('\\', '\\\\')
    await writeFile(
      join(root, 'steamapps', 'libraryfolders.vdf'),
      `"libraryfolders"\n{\n\t"0"\n\t{\n\t\t"path"\t\t"${vdfPath(root)}"\n\t}\n\t"1"\n\t{\n\t\t"path"\t\t"${vdfPath(other)}"\n\t}\n}\n`
    )
    await netfuse.evaluateMain((_electron, value) => {
      process.env.NETFUSE_E2E_STEAM_ROOT = value
    }, root)

    await netfuse.loginSteam()
    const page = netfuse.page
    await expect(library(netfuse).getByRole('listitem').first()).toContainText('Installed in Steam')
    await openGame(netfuse, 'NetFuse Test Game')
    await page.getByRole('button', { name: 'Auto-detect' }).click()

    const libraries = page.getByRole('group', { name: 'Steam libraries' }).getByRole('button')
    await expect(libraries).toHaveCount(2)
    // The one that has the game comes first.
    await expect(libraries.first()).toContainText('Has this game')
    await expect(libraries.nth(1)).not.toContainText('Has this game')
    await libraries.first().click()
    await expect(page.getByRole('checkbox', { name: /^Install over the existing/ })).toBeChecked()
    await expect(page.getByText(/is already in this Steam library/)).toBeVisible()

    const common = await realpath(join(other, 'steamapps', 'common'))
    netfuse.nextDownload = {
      expectedSha: steam.expectedSha(),
      destBefore: await readdir(common),
      destinationDir: common
    }
    await clickDownload(netfuse)
    const done = await netfuse.waitForSteamStatus('completed')
    expect(done.destinationPath).toBe(join(common, 'NetFuse Test Game'))
    expect(done.adopted).toBe(true)
    // What was there already was kept, not fetched again.
    expect(steam.chunkRequests().length).toBeLessThan(steam.uniqueChunks().length)
    // The next game goes there too.
    const settings = async (): Promise<Record<string, unknown>> =>
      JSON.parse(await readFile(join(dirs.userData, 'app-settings.json'), 'utf8'))
    await expect.poll(async () => (await settings()).destinationDir).toBe(common)
  })

  test('Auto-detect says so when Steam isn’t on this computer', async ({
    netfuse,
    serveSteam,
    dirs
  }) => {
    await serveSteam()
    await netfuse.evaluateMain(
      (_electron, value) => {
        process.env.NETFUSE_E2E_STEAM_ROOT = value
      },
      join(dirname(dirs.dest), 'no Steam here')
    )
    await netfuse.loginSteam()
    await openGame(netfuse, 'NetFuse Test Game')
    await netfuse.page.getByRole('button', { name: 'Auto-detect' }).click()
    await expect(
      netfuse.page.getByText('NetFuse couldn’t find Steam on this computer.', { exact: false })
    ).toBeVisible()
  })

  test('a password-protected branch is listed, but can’t be picked; logging out goes back to the login', async ({
    netfuse,
    serveSteam
  }) => {
    await serveSteam()
    await netfuse.loginSteam()
    const page = netfuse.page
    await openGame(netfuse, 'NetFuse Test Game')
    await page.getByRole('button', { name: 'Branch' }).click()
    const beta = page.getByRole('menuitemradio', { name: /beta/ })
    await expect(beta).toBeVisible()
    await expect(beta).toHaveAttribute('aria-disabled', 'true')
    await page.keyboard.press('Escape')

    await page.getByRole('button', { name: `Steam account ${ACCOUNT.name}` }).click()
    await page.getByRole('menuitem', { name: 'Log out of Steam' }).click()
    await expect(page.getByRole('region', { name: 'Steam login' })).toBeVisible()
    await expect(page.getByRole('navigation', { name: 'Main' })).toBeHidden()
  })
})
