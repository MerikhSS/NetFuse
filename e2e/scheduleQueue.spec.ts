import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { DEFAULT_DOWNLOAD_SCHEDULE } from '../src/shared/downloadSchedule'
import { expect, test, type NetFuseApp } from './fixtures'
import { syntheticApp, type SteamOrigin } from './steamOrigin'

// The download schedule and the queue: what may run when, and what waits its turn. A game
// downloaded twice installs into a second folder beside the first, which is how these tests get
// two downloads of the one fake game.

const schedule = { ...DEFAULT_DOWNLOAD_SCHEDULE, enabled: true }
const at = (day: number, hour: number): number => new Date(2000, 0, day, hour).getTime()

/** Holds every chunk request after the first `count`; resolves once one is held. */
function holdAfter(steam: SteamOrigin, count: number): Promise<void> {
  let seen = 0
  return steam.hold((request) => request.kind === 'chunk' && ++seen > count)
}

async function clock(netfuse: NetFuseApp, now: number, wake = true): Promise<void> {
  await netfuse.evaluateMain(
    ({ powerMonitor }, value) => {
      Date.now = () => value.now
      if (value.wake) powerMonitor.emit('resume')
    },
    { now, wake }
  )
}

test('scheduled queue holds new downloads and manual resumes; manually paused downloads stay paused @smoke', async ({
  netfuse,
  serveSteam
}) => {
  await clock(netfuse, at(1, 8))
  await netfuse.api.updateSettings({ downloadSchedule: schedule, downloadsAtOnce: 1 })
  const steam = await serveSteam()
  const first = await netfuse.startSteam(steam)
  const second = await netfuse.startSteam(steam)
  expect((await netfuse.byId(first))?.status).toBe('queued')
  expect((await netfuse.byId(second))?.bytesDownloaded).toBe(0)
  await netfuse.api.pauseDownload(first)
  await netfuse.api.resumeDownload(first)
  await expect.poll(async () => (await netfuse.byId(first))?.status).toBe('queued')
  await netfuse.api.pauseDownload(first)
  await clock(netfuse, at(2, 0))
  await expect.poll(async () => (await netfuse.byId(second))?.status).toBe('completed')
  expect((await netfuse.byId(first))?.status).toBe('paused')
  await netfuse.api.resumeDownload(first)
  await expect.poll(async () => (await netfuse.byId(first))?.status).toBe('completed')
})

test('the clock cutoff stops active transfers, preserves progress, and blocks queue draining', async ({
  netfuse,
  serveSteam
}) => {
  await clock(netfuse, at(1, 0))
  await netfuse.api.updateSettings({ downloadSchedule: schedule, downloadsAtOnce: 1 })
  const steam = await serveSteam(syntheticApp(31, 3))
  const held = holdAfter(steam, 4)
  const id = await netfuse.startSteam(steam)
  await held
  await netfuse.waitUntil((state) => state.id === id && state.chunksDone >= 4)
  const next = await netfuse.startSteam(steam)
  // No wake event: the main-process timer must enforce the cutoff itself.
  await clock(netfuse, at(1, 7), false)
  await expect.poll(async () => (await netfuse.byId(id))?.status).toBe('queued')
  const stopped = await netfuse.byId(id)
  expect(stopped?.bytesDownloaded).toBeGreaterThan(0)
  expect(stopped?.speedBytesPerSec).toBe(0)
  expect((await netfuse.byId(next))?.bytesDownloaded).toBe(0)
  steam.release()
  await clock(netfuse, at(2, 0))
  await expect.poll(async () => (await netfuse.byId(id))?.status).toBe('completed')
  await expect.poll(async () => (await netfuse.byId(next))?.status).toBe('completed')
})

test('scheduled intent survives restart, while expiration stays blocked until disabled', async ({
  netfuse,
  serveSteam
}) => {
  await clock(netfuse, at(1, 8))
  await netfuse.api.updateSettings({ downloadSchedule: { ...schedule, endDate: '2000-01-02' } })
  const steam = await serveSteam()
  const id = await netfuse.startSteam(steam)
  await netfuse.relaunch()
  expect((await netfuse.byId(id))?.status).toBe('queued')
  expect((await netfuse.byId(id))?.bytesDownloaded).toBe(0)
  // No login is kept here (see steamAuth.spec.ts): this launch logs in again.
  await netfuse.loginSteam()
  await netfuse.api.updateSettings({ downloadSchedule: { ...schedule, enabled: false } })
  await expect.poll(async () => (await netfuse.byId(id))?.status).toBe('completed')
})

test('a restart inside the window continues scheduled work', async ({ netfuse, serveSteam }) => {
  // The schedule is in the app's local time, so the minute is asked of the app: worked out in a
  // test process that took another time zone, it set a window that hadn't opened (seen on the
  // Windows nightly), and the download waited for it.
  const minute = await netfuse.evaluateMain(() => {
    const now = new Date()
    return now.getHours() * 60 + now.getMinutes()
  }, null)
  const open = { ...schedule, startMinute: (minute + 1420) % 1440, endMinute: (minute + 20) % 1440 }
  await netfuse.api.updateSettings({ downloadSchedule: open })
  const steam = await serveSteam(syntheticApp(32, 3))
  const held = holdAfter(steam, 4)
  const id = await netfuse.startSteam(steam)
  await held
  await netfuse.quit()
  steam.release()
  await netfuse.launch()
  // It goes on at once, and waits for the login only as long as Steam takes to give one.
  await netfuse.loginSteam()
  await expect.poll(async () => (await netfuse.byId(id))?.status).toBe('completed')
})

/** Opens the schedule as the sidebar's networks menu does: the window shows it once logged in. */
async function openSchedule(netfuse: NetFuseApp): Promise<void> {
  if ((await netfuse.api.steamLoginState()).status !== 'logged-in') await netfuse.loginSteam()
  await netfuse.page.getByRole('button', { name: /^\d+ networks?/ }).click()
  await netfuse.page.getByRole('button', { name: 'Speed & data limits', exact: true }).click()
  await netfuse.page.getByRole('region', { name: 'Download schedule' }).scrollIntoViewIfNeeded()
}

async function chooseTime(netfuse: NetFuseApp, label: string, time: string): Promise<void> {
  const [hour, minute] = time.split(':')
  for (const [part, value] of [
    ['hour', hour],
    ['minute', minute]
  ]) {
    await netfuse.page
      .getByRole('spinbutton', { name: `${label} ${part}`, exact: true })
      .fill(value)
  }
}

test('schedule dialog saves, cancels edits, validates times, and restores settings', async ({
  netfuse,
  serveSteam
}, testInfo) => {
  await serveSteam()
  await netfuse.loginSteam()
  const page = netfuse.page
  const indicator = page.getByRole('button', { name: 'Download schedule enabled', exact: true })
  await expect(indicator).toBeHidden()
  await openSchedule(netfuse)
  const dialog = page.getByRole('dialog', { name: 'Speed & data limits' })
  await expect(dialog.getByRole('group', { name: 'Start at', exact: true })).toBeHidden()
  await dialog.getByRole('switch', { name: 'Enable download schedule' }).check()
  await chooseTime(netfuse, 'Start at', '00:00')
  await chooseTime(netfuse, 'Stop at', '00:00')
  await expect(dialog.getByRole('button', { name: 'Save', exact: true })).toBeDisabled()
  await chooseTime(netfuse, 'Stop at', '07:00')
  await expect(dialog.locator('input[type="date"], input[type="time"]')).toHaveCount(0)
  await dialog.getByRole('button', { name: 'Mon', exact: true }).click()
  await expect(dialog.getByRole('button', { name: 'Mon', exact: true })).toHaveAttribute(
    'aria-pressed',
    'false'
  )
  await chooseTime(netfuse, 'Stop at', '07:13')
  await chooseTime(netfuse, 'Stop at', '07:00')
  await dialog.getByRole('button', { name: 'End date', exact: true }).click()
  const calendar = page.getByRole('dialog', { name: 'Choose end date' })
  await calendar.getByRole('button', { name: 'Go to the next month' }).click()
  await page.screenshot({ path: '/tmp/netfuse-schedule-calendar.png' })
  // Choose a day in the displayed month, excluding the adjacent months' trailing dates.
  await calendar
    .locator('[data-slot="calendar"] td:not([data-outside]) button')
    .filter({ hasText: /^15$/ })
    .click()
  const endDateLabel = await dialog
    .getByRole('button', { name: 'End date', exact: true })
    .innerText()
  await testInfo.attach('schedule-dialog.png', {
    body: await page.screenshot({ path: '/tmp/netfuse-schedule-dialog.png' }),
    contentType: 'image/png'
  })
  await dialog.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(dialog).toBeHidden()
  await expect(indicator).toBeVisible()
  await page.screenshot({ path: '/tmp/netfuse-schedule-toolbar.png' })
  await indicator.click()
  await expect(dialog.getByRole('switch', { name: 'Enable download schedule' })).toBeFocused()
  await expect(dialog.getByRole('region', { name: 'Download schedule' })).toBeInViewport()
  await expect(dialog.getByRole('button', { name: 'End date', exact: true })).toBeInViewport({
    ratio: 1
  })
  await chooseTime(netfuse, 'Stop at', '09:00')
  await dialog.getByRole('navigation').getByRole('button').nth(1).click()
  await dialog.getByRole('button', { name: /^All downloads/ }).click()
  await expect(dialog.getByRole('spinbutton', { name: 'Stop at hour', exact: true })).toHaveValue(
    '09'
  )
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
  await netfuse.relaunch()
  await openSchedule(netfuse)
  const restored = netfuse.page.getByRole('dialog', { name: 'Speed & data limits' })
  await expect(restored.getByRole('switch', { name: 'Enable download schedule' })).toBeChecked()
  await expect(restored.getByRole('spinbutton', { name: 'Stop at hour', exact: true })).toHaveValue(
    '07'
  )
  await expect(restored.getByRole('button', { name: 'End date', exact: true })).toHaveText(
    endDateLabel
  )
  await expect(restored.getByRole('button', { name: 'Mon', exact: true })).toHaveAttribute(
    'aria-pressed',
    'false'
  )
  await restored.getByRole('button', { name: 'End date', exact: true }).click()
  await netfuse.page.getByRole('button', { name: 'Clear', exact: true }).click()
  await expect(restored.getByRole('button', { name: 'End date', exact: true })).toHaveText(
    'No end date'
  )
  await restored.getByRole('switch', { name: 'Enable download schedule' }).uncheck()
  await restored.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(
    netfuse.page.getByRole('button', { name: 'Download schedule enabled', exact: true })
  ).toBeHidden()
})

test('an overnight schedule remains usable at the minimum window size', async ({
  netfuse,
  serveSteam
}) => {
  await serveSteam()
  await netfuse.evaluateMain(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0]
    window.setSize(720, 620)
  }, null)
  await netfuse.page.emulateMedia({ colorScheme: 'dark' })
  await openSchedule(netfuse)
  const dialog = netfuse.page.getByRole('dialog', { name: 'Speed & data limits' })
  await dialog.getByRole('switch', { name: 'Enable download schedule' }).check()
  await chooseTime(netfuse, 'Start at', '22:00')
  const minute = dialog.getByRole('spinbutton', { name: 'Start at minute', exact: true })
  const hour = dialog.getByRole('spinbutton', { name: 'Start at hour', exact: true })
  await minute.focus()
  await netfuse.page.keyboard.press('ArrowDown')
  await expect(minute).toHaveValue('59')
  await expect(minute).toHaveAttribute('aria-valuenow', '59')
  await netfuse.page.keyboard.press('ArrowUp')
  await expect(minute).toHaveValue('00')
  await netfuse.page.keyboard.press('ArrowLeft')
  await expect(hour).toBeFocused()
  await netfuse.page.keyboard.press('End')
  await expect(hour).toHaveValue('23')
  await netfuse.page.keyboard.press('ArrowUp')
  await expect(hour).toHaveValue('00')
  await hour.evaluate((input) => {
    const clipboardData = new DataTransfer()
    clipboardData.setData('text/plain', '21:37')
    input.dispatchEvent(
      new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true })
    )
  })
  await expect(hour).toHaveValue('21')
  await expect(minute).toHaveValue('37')
  await hour.focus()
  await netfuse.page.keyboard.press('ControlOrMeta+A')
  await hour.pressSequentially('22')
  await expect(minute).toBeFocused()
  await minute.fill('00')
  await minute.fill('75')
  await expect(minute).toHaveValue('00')
  await netfuse.page.screenshot({ path: '/tmp/netfuse-schedule-time-dark.png' })
  await expect(dialog.getByText('Next day', { exact: true })).toBeVisible()
  await dialog.getByRole('button', { name: 'Save', exact: true }).scrollIntoViewIfNeeded()
  await expect(dialog.getByRole('button', { name: 'Save', exact: true })).toBeInViewport({
    ratio: 1
  })
  await dialog.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(dialog).toBeHidden()
})

test('main refuses invalid schedule changes without clearing the existing window', async ({
  netfuse,
  serveSteam
}) => {
  await clock(netfuse, at(1, 8))
  await netfuse.api.updateSettings({ downloadSchedule: schedule })
  await expect(
    netfuse.api.updateSettings({ downloadSchedule: { ...schedule, days: [] } })
  ).rejects.toThrow()
  const id = await netfuse.startSteam(await serveSteam())
  expect((await netfuse.byId(id))?.status).toBe('queued')
  await netfuse.api.updateSettings({ downloadSchedule: { ...schedule, enabled: false } })
  await expect.poll(async () => (await netfuse.byId(id))?.status).toBe('completed')
})

test('quitting during the cutoff saves progress and leaves the restored queue stopped', async ({
  netfuse,
  serveSteam
}) => {
  await clock(netfuse, at(1, 0))
  await netfuse.api.updateSettings({ downloadSchedule: { ...schedule, endDate: '2000-01-02' } })
  const steam = await serveSteam(syntheticApp(33, 3))
  const held = holdAfter(steam, 4)
  const id = await netfuse.startSteam(steam)
  await held
  await netfuse.waitUntil((state) => state.chunksDone >= 4)
  await clock(netfuse, at(1, 7))
  await netfuse.quit()
  steam.release()
  await netfuse.launch()
  const restored = await netfuse.byId(id)
  expect(restored?.status).toBe('queued')
  expect(restored?.bytesDownloaded).toBeGreaterThan(0)
  await netfuse.loginSteam()
  await netfuse.api.updateSettings({ downloadSchedule: { ...schedule, enabled: false } })
  await expect.poll(async () => (await netfuse.byId(id))?.status).toBe('completed')
})

test('enabling a closed window adopts active work; a manual pause survives its cutoff and restart', async ({
  netfuse,
  serveSteam
}) => {
  const steam = await serveSteam(syntheticApp(34, 3))
  const held = holdAfter(steam, 4)
  await netfuse.api.updateSettings({ downloadsAtOnce: 1 })
  const active = await netfuse.startSteam(steam)
  await held
  const waiting = await netfuse.startSteam(steam)
  await clock(netfuse, at(1, 8))
  await netfuse.api.updateSettings({ downloadSchedule: schedule })
  const stopped = await netfuse.byId(active)
  expect(stopped?.status).toBe('queued')
  expect(stopped?.scheduled).toBe(true)
  expect((await netfuse.byId(waiting))?.scheduled).toBe(true)
  await netfuse.api.pauseDownload(active)
  await netfuse.quit()
  steam.release()
  await netfuse.launch()
  expect((await netfuse.byId(active))?.status).toBe('paused')
  await netfuse.loginSteam()
  // Whichever local time the app restarted in, the scheduled entry can run when disabled.
  await netfuse.api.updateSettings({ downloadSchedule: { ...schedule, enabled: false } })
  await expect.poll(async () => (await netfuse.byId(waiting))?.status).toBe('completed')
  expect((await netfuse.byId(active))?.status).toBe('paused')
  await netfuse.api.resumeDownload(active)
  await expect.poll(async () => (await netfuse.byId(active))?.status).toBe('completed')
})

test('a malformed saved schedule blocks transfers and can be disabled from settings', async ({
  netfuse,
  serveSteam,
  dirs
}) => {
  await clock(netfuse, at(1, 8))
  await netfuse.api.updateSettings({ downloadSchedule: schedule })
  const id = await netfuse.startSteam(await serveSteam())
  await netfuse.quit()
  await writeFile(
    join(dirs.userData, 'app-settings.json'),
    JSON.stringify({
      downloadSchedule: { ...schedule, days: [] }
    })
  )
  await netfuse.launch()
  expect((await netfuse.byId(id))?.status).toBe('queued')
  expect((await netfuse.byId(id))?.bytesDownloaded).toBe(0)
  await netfuse.loginSteam()
  await openSchedule(netfuse)
  const dialog = netfuse.page.getByRole('dialog', { name: 'Speed & data limits' })
  await expect(dialog.getByRole('button', { name: 'Save', exact: true })).toBeDisabled()
  await dialog.getByRole('switch', { name: 'Enable download schedule' }).uncheck()
  await dialog.getByRole('button', { name: 'Save', exact: true }).click()
  await expect.poll(async () => (await netfuse.byId(id))?.status).toBe('completed')
})
