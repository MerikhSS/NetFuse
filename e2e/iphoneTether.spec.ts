import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Locator } from '@playwright/test'
import { expect, test, type NetFuseApp } from './fixtures'

// An iPhone plugged into Windows that isn't a network: the popup that says how, driven through the
// test stand-in for looking (NETFUSE_E2E_IPHONE), which also runs the watch off Windows.

test.use({ appEnv: { NETFUSE_E2E_IPHONE: 'unplugged', NETFUSE_E2E_IPHONE_SETTLE_MS: '1' } })

const APPLE_DEVICES = 'ms-windows-store://pdp/?ProductId=9NP83LWLPZ9K'

/** Plugs the stand-in iPhone in, as `state`, or unplugs it. */
function plug(
  netfuse: NetFuseApp,
  state: 'unplugged' | 'no-driver' | 'hotspot-off' | 'tethered'
): Promise<void> {
  return netfuse.evaluateMain((_electron, value) => {
    process.env.NETFUSE_E2E_IPHONE = value
  }, state)
}

/** The popup while it's open, rather than while it's in the page: closed, it stays there to fade
 * out, which a window that's never shown doesn't finish. */
const popupOf = (netfuse: NetFuseApp): Locator =>
  netfuse.page
    .getByRole('alertdialog', { name: 'Use your iPhone as a network' })
    .and(netfuse.page.locator('[data-open]'))

/** Links the app opens, kept instead of opened. */
async function recordLinks(netfuse: NetFuseApp): Promise<() => Promise<string[]>> {
  await netfuse.evaluateMain(({ shell }) => {
    const opened: string[] = []
    ;(globalThis as { openedLinks?: string[] }).openedLinks = opened
    shell.openExternal = (async (url: string) => {
      opened.push(url)
    }) as never
  }, null)
  return () =>
    netfuse.evaluateMain(() => (globalThis as { openedLinks?: string[] }).openedLinks ?? [], null)
}

test('an iPhone that isn’t a network gets a popup with the way to Apple Devices @smoke', async ({
  netfuse,
  serveSteam
}) => {
  await serveSteam()
  const links = await recordLinks(netfuse)
  const page = netfuse.page
  const popup = popupOf(netfuse)

  // Not over the login, where it would take the keyboard from a password.
  await plug(netfuse, 'no-driver')
  await expect
    .poll(() => netfuse.api.iphoneTether())
    .toEqual({
      status: 'not-tethered',
      driverInstalled: false
    })
  await expect(page.getByRole('region', { name: 'Steam login' })).toBeVisible()
  await expect(popup).toBeHidden()

  await netfuse.loginSteam()
  await expect(popup).toBeVisible()
  // Enter mustn't turn it off for good.
  await expect(popup.getByRole('button', { name: 'Not now' })).toBeFocused()
  await expect(popup.getByRole('listitem')).toHaveCount(3)
  await expect(popup.getByRole('listitem').first()).toContainText('Install Apple Devices')
  await popup.getByRole('button', { name: 'Get Apple Devices' }).click()
  await expect.poll(links).toEqual([APPLE_DEVICES])
  // Still open: the steps after the install are on it.
  await expect(popup).toBeVisible()

  // Apple Devices installed, the hotspot still off: only the phone's steps are left.
  await plug(netfuse, 'hotspot-off')
  await expect(popup.getByRole('button', { name: 'Get Apple Devices' })).toBeHidden()
  await expect(popup.getByRole('listitem')).toHaveCount(2)
  await expect(popup.getByRole('listitem').last()).toContainText('Allow Others to Join')

  // A network now: the popup goes by itself.
  await plug(netfuse, 'tethered')
  await expect(popup).toBeHidden()

  // Not now holds while the iPhone stays plugged in, and ends when it's unplugged.
  await plug(netfuse, 'no-driver')
  await expect(popup).toBeVisible()
  await popup.getByRole('button', { name: 'Not now' }).click()
  await expect(popup).toBeHidden()
  expect(await netfuse.api.iphoneTether()).toEqual({
    status: 'not-tethered',
    driverInstalled: false
  })
  await plug(netfuse, 'unplugged')
  await expect.poll(() => netfuse.api.iphoneTether()).toEqual({ status: 'none' })
  await plug(netfuse, 'no-driver')
  await expect(popup).toBeVisible()
})

test('Never show again keeps it away, across restarts', async ({ netfuse, serveSteam, dirs }) => {
  await serveSteam()
  await netfuse.loginSteam()
  const popup = popupOf(netfuse)
  await plug(netfuse, 'no-driver')
  await expect(popup).toBeVisible()
  await popup.getByRole('button', { name: 'Never show again' }).click()
  await expect(popup).toBeHidden()
  await expect.poll(() => netfuse.api.iphoneTether()).toEqual({ status: 'none' })
  const settings = JSON.parse(await readFile(join(dirs.userData, 'app-settings.json'), 'utf8'))
  expect(settings).toMatchObject({ iphoneTetherPopup: false })

  // Plugged in again, then after a restart: nothing, for longer than it would take to show.
  await plug(netfuse, 'unplugged')
  await plug(netfuse, 'no-driver')
  await netfuse.page.waitForTimeout(3000)
  expect(await netfuse.api.iphoneTether()).toEqual({ status: 'none' })
  await netfuse.relaunch()
  await plug(netfuse, 'no-driver')
  await netfuse.page.waitForTimeout(3000)
  expect(await netfuse.api.iphoneTether()).toEqual({ status: 'none' })
})
