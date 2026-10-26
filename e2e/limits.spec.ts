import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { dataPeriodKey, nextDataReset } from '../src/shared/dataLimits'
import { expect, test } from './fixtures'
import { syntheticApp } from './steamOrigin'

// Speed & data limits (main/network/limits.ts): every byte received from a content server goes
// through them. The checks fixture verifies each finished install's bytes, which is what matters
// most here: holding a connection back must never garble it.

const KB = 1024
/** The fake game's chunks are 64 KB before compression. */
const CHUNK = 64 * KB

/** How long `bytes` must take at `limit` bytes a second, less the second's worth a bucket may hold
 * to begin with, with a little room for the timer's rounding. */
const atLeastMs = (bytes: number, limit: number): number => ((bytes - limit) / limit) * 900

test.describe('speed and data limits', () => {
  test('a total speed limit holds a download to it', async ({ netfuse, serveSteam }) => {
    const steam = await serveSteam(syntheticApp(41, 2))
    const limit = 192 * KB
    await netfuse.api.updateSettings({ speedLimit: limit })
    await netfuse.startSteam(steam)
    const done = await netfuse.waitForSteamStatus('completed', 30_000)
    // Timed from its own start, after the plan was made: several seconds' worth at the limit.
    expect(done.bytesDownloaded).toBeGreaterThan(4 * limit)
    expect(done.completedAt! - done.startedAt).toBeGreaterThan(
      atLeastMs(done.bytesDownloaded, limit)
    )
  })

  test('slow mode holds downloads to its speed, the default one included', async ({
    netfuse,
    serveSteam
  }) => {
    const steam = await serveSteam(syntheticApp(42, 12))
    // Switched on as the status bar does, its speed never changed: 2 MB/s.
    const limit = 2 * 1024 * KB
    await netfuse.api.updateSettings({ slowMode: true })
    await netfuse.startSteam(steam)
    const done = await netfuse.waitForSteamStatus('completed', 30_000)
    expect(done.bytesDownloaded).toBeGreaterThan(2 * limit)
    expect(done.completedAt! - done.startedAt).toBeGreaterThan(
      atLeastMs(done.bytesDownloaded, limit)
    )
  })

  for (const period of ['day', 'week', 'month'] as const) {
    test(`a network stops at its ${period} limit and resumes when it is raised`, async ({
      netfuse,
      serveSteam
    }) => {
      const steam = await serveSteam(syntheticApp(43, 3))
      await netfuse.api.updateSettings({
        networkPreferences: { a: { dataLimit: 4 * CHUNK, dataLimitPeriod: period } }
      })
      const id = await netfuse.startSteam(steam)

      const stopped = await netfuse.waitUntil((state) =>
        state.networks.some((network) => network.id === 'a' && network.status === 'limit')
      )
      expect(stopped.status).toBe('downloading')
      expect(stopped.chunksDone).toBeLessThan(stopped.totalChunks)
      expect((await netfuse.api.networkUsage()).a).toBeGreaterThanOrEqual(4 * CHUNK)

      await netfuse.api.updateSettings({
        networkPreferences: { a: { dataLimit: 1024 * CHUNK, dataLimitPeriod: period } }
      })
      await netfuse.waitForSteamStatus('completed')
      expect((await netfuse.byId(id))?.status).toBe('completed')
    })
  }
})

test('usage survives period switches and restart, and expired calendar periods reset', async ({
  netfuse,
  dirs
}) => {
  await netfuse.quit()
  const now = Date.now()
  await writeFile(
    join(dirs.userData, 'network-usage.json'),
    JSON.stringify({
      version: 2,
      periods: Object.fromEntries(
        ['day', 'week', 'month'].map((period, index) => [
          period,
          {
            key: dataPeriodKey(period as 'day' | 'week' | 'month', now),
            bytes: { a: (index + 1) * 1024 }
          }
        ])
      )
    })
  )
  await netfuse.launch()
  for (const [period, count] of [
    ['day', 1024],
    ['week', 2048],
    ['month', 3072]
  ] as const) {
    await netfuse.api.updateSettings({
      networkPreferences: { a: { dataLimit: 1024 ** 3, dataLimitPeriod: period } }
    })
    expect((await netfuse.api.networkUsage()).a).toBe(count)
  }
  await netfuse.quit()
  await netfuse.launch()
  expect((await netfuse.api.networkUsage()).a).toBe(3072)
  const future = nextDataReset('month', now).getTime() + 8 * 86400_000
  await netfuse.evaluateMain((_electron, at) => {
    const original = Date.now
    ;(globalThis as Record<string, unknown>).__originalDateNow = original
    Date.now = () => at
  }, future)
  try {
    for (const period of ['day', 'week', 'month'] as const) {
      await netfuse.api.updateSettings({
        networkPreferences: { a: { dataLimit: 1024 ** 3, dataLimitPeriod: period } }
      })
      expect((await netfuse.api.networkUsage()).a ?? 0).toBe(0)
    }
  } finally {
    await netfuse.evaluateMain(() => {
      Date.now = (globalThis as Record<string, unknown>).__originalDateNow as () => number
      delete (globalThis as Record<string, unknown>).__originalDateNow
    }, null)
  }
})

test('existing monthly usage remains available after migration', async ({ netfuse, dirs }) => {
  await netfuse.quit()
  await writeFile(
    join(dirs.userData, 'network-usage.json'),
    JSON.stringify({
      month: dataPeriodKey('month', Date.now()),
      bytes: { a: 12345 }
    })
  )
  await netfuse.launch()
  expect((await netfuse.api.networkUsage()).a).toBe(12345)
  await netfuse.api.updateSettings({ networkPreferences: { a: { dataLimitPeriod: 'day' } } })
  expect((await netfuse.api.networkUsage()).a).toBe(0)
  await netfuse.api.updateSettings({ networkPreferences: { a: { dataLimitPeriod: 'month' } } })
  expect((await netfuse.api.networkUsage()).a).toBe(12345)
})

test('calendar periods use local midnight, Monday weeks, and correct year boundaries', () => {
  const sunday = new Date(2026, 9, 4, 23, 59, 59, 999).getTime()
  const monday = new Date(2026, 9, 5).getTime()
  expect(dataPeriodKey('week', sunday)).toBe('2026-09-28')
  expect(dataPeriodKey('week', monday)).toBe('2026-10-05')
  expect(nextDataReset('day', sunday).getTime()).toBe(monday)
  expect(nextDataReset('week', sunday).getTime()).toBe(monday)
  expect(nextDataReset('week', monday).getTime()).toBe(new Date(2026, 9, 12).getTime())
  expect(nextDataReset('month', new Date(2026, 11, 31, 23).getTime()).getTime()).toBe(
    new Date(2027, 0, 1).getTime()
  )
  expect(dataPeriodKey('month', new Date(2027, 0, 1).getTime())).toBe('2027-01')
})

for (const period of ['day', 'week', 'month'] as const) {
  test(`resetting ${period} usage preserves other periods and networks and survives restart`, async ({
    netfuse,
    serveSteam
  }) => {
    await netfuse.startSteam(await serveSteam())
    await netfuse.waitForStatus('completed')
    const before = await netfuse.api.networkUsage()
    const id = Object.keys(before).find((key) => before[key] > 0)!
    expect(id).toBeTruthy()
    await netfuse.api.updateSettings({ networkPreferences: { [id]: { dataLimitPeriod: period } } })
    await netfuse.api.resetNetworkUsage(id)
    expect((await netfuse.api.networkUsage())[id]).toBe(0)
    for (const [other, bytes] of Object.entries(before)) {
      if (other !== id) expect((await netfuse.api.networkUsage())[other]).toBe(bytes)
    }
    for (const otherPeriod of ['day', 'week', 'month'] as const) {
      if (otherPeriod === period) continue
      await netfuse.api.updateSettings({
        networkPreferences: { [id]: { dataLimitPeriod: otherPeriod } }
      })
      expect((await netfuse.api.networkUsage())[id]).toBe(before[id])
    }
    await netfuse.api.updateSettings({ networkPreferences: { [id]: { dataLimitPeriod: period } } })
    await netfuse.relaunch()
    expect((await netfuse.api.networkUsage())[id]).toBe(0)
  })
}
