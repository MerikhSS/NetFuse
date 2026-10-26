import { expect, interfacesEnv, LAN_ADDRESS, NETWORKS, test, type NetFuseApp } from './fixtures'
import { syntheticApp, type SteamRequest } from './steamOrigin'
import type { DownloadState } from '../src/shared/types'

// Networks that come, go, and are switched on and off while a game downloads.

/** What the computer's networks are now, as the app will see them at its next look. */
const setNetworks = (netfuse: NetFuseApp, networks: Record<string, string>): Promise<void> =>
  netfuse.evaluateMain((_electron, value) => {
    process.env['NETFUSE_E2E_INTERFACES'] = value
  }, interfacesEnv(networks))

const overB = (request: Pick<SteamRequest, 'from'>): boolean => request.from !== '127.0.0.1'
const network = (state: DownloadState, id: string): DownloadState['networks'][number] | undefined =>
  state.networks.find((entry) => entry.id === id)
const streamsOn = (state: DownloadState, id: string): number =>
  state.streams.filter((stream) => stream.interfaceId === id).length
const settle = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
/** Slow enough per response that a download lasts while a test changes its networks. */
const SLOW = { bytesPerSecond: 256 * 1024 }

test('the only network drops for a while: the download waits, then picks up where it was @smoke', async ({
  netfuse,
  serveSteam
}) => {
  const steam = await serveSteam(syntheticApp(21, 4), SLOW)
  await netfuse.startSteam(steam)
  await netfuse.waitUntil((state) => state.bytesDownloaded > 0)

  await setNetworks(netfuse, {})
  await netfuse.waitUntil((state) => network(state, 'a')?.status === 'offline')
  const gone = (await netfuse.current())!
  // Far longer than a stream's retries last (20 ms apart and doubling, in these tests).
  await settle(1500)
  const waited = (await netfuse.current())!
  expect(waited.status).toBe('downloading')
  expect(waited.streams).toHaveLength(0)
  expect(waited.bytesDownloaded, 'nothing it had was lost').toBe(gone.bytesDownloaded)

  await setNetworks(netfuse, { a: NETWORKS['a'] })
  await netfuse.waitForSteamStatus('completed', 30_000)
})

test.describe('two networks @smoke', () => {
  test.skip(!LAN_ADDRESS, 'needs a LAN address to act as the second network')

  test('a network that drops out and comes back is used again', async ({ netfuse, serveSteam }) => {
    const steam = await serveSteam(syntheticApp(22, 8), SLOW)
    await netfuse.startSteam(steam, { networks: ['a', 'b'] })
    await netfuse.waitUntil((state) => (network(state, 'b')?.bytesDownloaded ?? 0) > 0)

    await setNetworks(netfuse, { a: NETWORKS['a'] })
    const gone = await netfuse.waitUntil(
      (state) => network(state, 'b')?.status === 'offline' && streamsOn(state, 'b') === 0
    )
    expect(network(gone, 'b')?.enabled, 'still the user’s pick').toBe(true)
    const goneAt = steam.log.length

    await setNetworks(netfuse, NETWORKS)
    await netfuse.waitForSteamStatus('completed', 60_000)
    expect(steam.log.slice(goneAt).some(overB), 'b carried more once it was back').toBe(true)
  })

  test('a network that turns up mid-download is listed off; it carries traffic only while switched on', async ({
    netfuse,
    serveSteam
  }) => {
    await setNetworks(netfuse, { a: NETWORKS['a'] })
    const steam = await serveSteam(syntheticApp(23, 10), SLOW)
    const id = await netfuse.startSteam(steam)
    await netfuse.waitUntil((state) => state.bytesDownloaded > 0)
    expect(network((await netfuse.current())!, 'b')).toBeUndefined()

    await setNetworks(netfuse, NETWORKS)
    const listed = await netfuse.waitUntil((state) => network(state, 'b') !== undefined)
    expect(network(listed, 'b')).toMatchObject({ enabled: false, status: 'off' })
    await settle(500)
    expect(steam.chunkRequests().some(overB), 'not used until switched on').toBe(false)

    await netfuse.api.setDownloadNetwork(id, 'b', true)
    await netfuse.waitUntil((state) => (network(state, 'b')?.bytesDownloaded ?? 0) > 0)

    await netfuse.api.setDownloadNetwork(id, 'b', false)
    const off = await netfuse.waitUntil((state) => streamsOn(state, 'b') === 0)
    expect(network(off, 'b')).toMatchObject({ enabled: false, status: 'off' })
    expect(network(off, 'b')!.bytesDownloaded, 'what it delivered stays its own').toBeGreaterThan(0)
    const offAt = steam.log.length

    await settle(500)
    expect(steam.log.slice(offAt).some(overB), 'nothing over b while it is off').toBe(false)

    // Switching off the last network in use pauses the download; switching it back on resumes it.
    await netfuse.api.setDownloadNetwork(id, 'a', false)
    const paused = await netfuse.waitUntil((state) => state.status === 'paused')
    expect(network(paused, 'a')?.enabled).toBe(false)
    const pausedAt = steam.log.length
    await settle(500)
    expect(steam.log.length, 'nothing requested while every network is off').toBe(pausedAt)

    await netfuse.api.setDownloadNetwork(id, 'a', true)
    await netfuse.waitUntil((state) => state.status === 'downloading' && streamsOn(state, 'a') > 0)

    // Resumed with none on, it switches back on the one switched off last.
    await netfuse.api.setDownloadNetwork(id, 'a', false)
    await netfuse.waitUntil((state) => state.status === 'paused')
    await netfuse.api.resumeDownload(id)
    const resumed = await netfuse.waitUntil((state) => state.status === 'downloading')
    expect(network(resumed, 'a')?.enabled).toBe(true)
  })

  test('switching the last network off and on quickly ends up where it was left', async ({
    netfuse,
    serveSteam
  }) => {
    const steam = await serveSteam(syntheticApp(24, 6), SLOW)
    const id = await netfuse.startSteam(steam)
    await netfuse.waitUntil((state) => state.bytesDownloaded > 0)

    // Back on before the pause has wound down: it resumes.
    const off = netfuse.api.setDownloadNetwork(id, 'a', false)
    await netfuse.api.setDownloadNetwork(id, 'a', true)
    await off
    await netfuse.waitUntil((state) => state.status === 'downloading' && streamsOn(state, 'a') > 0)

    // Off, on and off again before the resume has got going: it stays paused.
    await netfuse.api.setDownloadNetwork(id, 'a', false)
    await netfuse.waitUntil((state) => state.status === 'paused')
    await netfuse.api.setDownloadNetwork(id, 'a', true)
    await netfuse.api.setDownloadNetwork(id, 'a', false)
    await settle(1000)
    const left = (await netfuse.current())!
    expect(left.status).toBe('paused')
    expect(network(left, 'a')?.enabled).toBe(false)

    // …and switching it on once more still resumes it.
    await netfuse.api.setDownloadNetwork(id, 'a', true)
    await netfuse.waitForSteamStatus('completed', 30_000)
  })

  test('resumed with none on, it picks a network that is still there', async ({
    netfuse,
    serveSteam
  }) => {
    const steam = await serveSteam(syntheticApp(25, 6), SLOW)
    const id = await netfuse.startSteam(steam, { networks: ['a', 'b'] })
    await netfuse.waitUntil((state) => state.bytesDownloaded > 0)

    await netfuse.api.setDownloadNetwork(id, 'a', false)
    await netfuse.api.setDownloadNetwork(id, 'b', false)
    await netfuse.waitUntil((state) => state.status === 'paused')
    // b, the one switched off last, is unplugged while paused.
    await setNetworks(netfuse, { a: NETWORKS['a'] })

    await netfuse.api.resumeDownload(id)
    const resumed = await netfuse.waitUntil((state) => state.status === 'downloading')
    expect(network(resumed, 'a')?.enabled).toBe(true)
    expect(network(resumed, 'b')?.enabled).toBe(false)
    await netfuse.waitForSteamStatus('completed', 30_000)
  })
})

test.describe('a network that can’t reach Steam @smoke', () => {
  test.use({ appEnv: { NETFUSE_E2E_SILENT_MS: '500' } })

  test('keeps one stream trying, and gets its streams back once it is through', async ({
    netfuse,
    serveSteam
  }) => {
    test.skip(!LAN_ADDRESS, 'needs a LAN address to act as the second network')
    const steam = await serveSteam(syntheticApp(26, 10), SLOW)
    let blocked = true
    // Every chunk asked for over b is cut off before a byte of it: connected, but not getting
    // through.
    steam.setRule((request) =>
      blocked && overB(request) && request.kind === 'chunk' ? { cutAfter: 0 } : undefined
    )
    await netfuse.startSteam(steam, { networks: ['a', 'b'] })

    const cut = await netfuse.waitUntil(
      (state) => network(state, 'b')?.status === 'unreachable' && streamsOn(state, 'b') === 1
    )
    expect(network(cut, 'b')?.enabled).toBe(true)
    expect(cut.status, 'the download carries on over a').toBe('downloading')

    blocked = false
    await netfuse.waitUntil(
      (state) => network(state, 'b')?.status === 'on' && streamsOn(state, 'b') === 2
    )
    await netfuse.waitForSteamStatus('completed', 60_000)
    expect(network((await netfuse.current())!, 'b')!.bytesDownloaded).toBeGreaterThan(0)
  })
})

test.describe('a network that changes address', () => {
  // Far longer than the test waits: a stream only retries in time if it is woken.
  test.use({ appEnv: { NETFUSE_E2E_RETRY_BASE_MS: '10000' } })

  test('gets its streams going again at once, not when their backoff runs out @smoke', async ({
    netfuse,
    serveSteam
  }) => {
    test.skip(!LAN_ADDRESS, 'needs a LAN address to act as the second network')
    const steam = await serveSteam(syntheticApp(27, 12), SLOW)
    // Every chunk asked for over b's first address is cut off before a byte of it.
    steam.setRule((request) =>
      overB(request) && request.kind === 'chunk' ? { cutAfter: 0 } : undefined
    )
    await netfuse.startSteam(steam, { networks: ['a', 'b'] })
    await netfuse.waitUntil((state) =>
      state.streams.some((stream) => stream.interfaceId === 'b' && stream.status === 'retrying')
    )

    // A new DHCP lease, say: b is now reached at another address, which gets through.
    await setNetworks(netfuse, { a: NETWORKS['a'], b: '127.0.0.1' })
    const changedAt = Date.now()
    await netfuse.waitUntil((state) => (network(state, 'b')?.bytesDownloaded ?? 0) > 0, 5000)
    expect(Date.now() - changedAt, 'well before a backoff of 8 s or more').toBeLessThan(5000)
  })
})

test.describe('the computer wakes from sleep', () => {
  // Nothing else would notice the dead connection for a long while.
  test.use({ appEnv: { NETFUSE_E2E_STALL_MS: '60000', NETFUSE_E2E_SILENT_MS: '60000' } })

  test('a connection that died in its sleep is replaced at once @smoke', async ({
    netfuse,
    serveSteam
  }) => {
    const steam = await serveSteam()
    let chunks = 0
    let stalled: string | undefined
    let asked = 0
    // The third chunk's answer stops after its headers, as a connection does across a sleep.
    steam.setRule((request) => {
      if (request.kind !== 'chunk') return undefined
      if (++chunks === 3) stalled = request.sha
      if (request.sha !== stalled) return undefined
      return ++asked === 1 ? 'stallBody' : undefined
    })
    await netfuse.startSteam(steam)
    await netfuse.waitUntil((state) => state.chunksDone >= state.totalChunks - 1)
    expect((await netfuse.current())!.status).toBe('downloading')

    await netfuse.evaluateMain((electron) => {
      electron.powerMonitor.emit('resume')
    }, null)
    await netfuse.waitForSteamStatus('completed', 5000)
    expect(asked, 'the chunk was asked for again').toBeGreaterThan(1)
  })
})
