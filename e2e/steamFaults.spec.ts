import { open } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, expectSteam, test } from './fixtures'
import { sha1 } from './steamContent'
import { syntheticApp, type SteamOrigin } from './steamOrigin'

// Content servers that misbehave the ways real ones do: damaged copies, busy answers, dropped
// connections, stalls, refusals for want of a token, and chunks they don't have. Whatever comes,
// nothing that hasn't checked out is ever written, and the install ends byte for byte right.

const INSTALL = 'NetFuse Test Game'

/** The SHA-1 (hex) of bin/game's first chunk, which is written at its offset 0. */
function firstGameChunk(steam: SteamOrigin): string {
  const game = steam.app.depots[0].files.find((file) => file.name === 'bin/game')!.data!
  return sha1(game.subarray(0, 64 * 1024)).toString('hex')
}

test.describe('steam content server faults', () => {
  test('a damaged chunk is never written, and is fetched again from the other server @smoke', async ({
    netfuse,
    serveSteam
  }) => {
    const steam = await serveSteam()
    const sha = firstGameChunk(steam)
    let damaged = 0
    steam.setRule((request) =>
      request.sha === sha && damaged++ === 0 ? { corruptAt: 100 } : undefined
    )
    let asked = 0
    const refetching = steam.hold((request) => request.sha === sha && ++asked === 2)
    await netfuse.startSteam(steam)
    await refetching

    // The damaged copy came in whole and was turned down: what is on disk there is still nothing.
    const handle = await open(join(netfuse.dirs.dest, INSTALL, 'bin', 'game'), 'r')
    const there = Buffer.alloc(64 * 1024)
    await handle.read(there, 0, there.length, 0)
    await handle.close()
    expect(there.every((byte) => byte === 0)).toBe(true)

    steam.release()
    await netfuse.waitForSteamStatus('completed')
    const tries = steam.chunkRequests().filter((entry) => entry.sha === sha)
    expect(tries).toHaveLength(2)
    expect(tries[1].server).not.toBe(tries[0].server)
  })

  test('a chunk every server damages stops the download, which can be resumed', async ({
    netfuse,
    serveSteam
  }) => {
    const steam = await serveSteam()
    const sha = firstGameChunk(steam)
    steam.setRule((request) => (request.sha === sha ? { corruptAt: 7 } : undefined))
    await netfuse.startSteam(steam)
    const failed = await netfuse.waitForSteamStatus('error')
    expect(failed.error).toMatch(/keep sending a damaged copy/)
    expect(failed.resumable).not.toBe(false)
  })

  test('a server that says it is busy is waited out as long as it asks @smoke', async ({
    netfuse,
    serveSteam
  }) => {
    // Slow enough that the other server can't finish the game while this one is waited out.
    const steam = await serveSteam(syntheticApp(), { bytesPerSecond: 256 * 1024 })
    let refused = false
    steam.setRule((request) => {
      if (request.kind !== 'chunk' || request.server !== 0 || refused) return undefined
      refused = true
      return { status: 429, headers: { 'Retry-After': '1' } }
    })
    await netfuse.startSteam(steam)
    await netfuse.waitForSteamStatus('completed')
    const busy = steam.chunkRequests().find((entry) => entry.status === 429)!
    // Requests that set out after the answer was in: none to that server, from that network,
    // until the second it asked for had passed.
    const next = steam
      .chunkRequests()
      .filter(
        (entry) =>
          entry.server === busy.server && entry.from === busy.from && entry.at > busy.at + 100
      )
    expect(next.length).toBeGreaterThan(0)
    for (const entry of next) expect(entry.at - busy.at).toBeGreaterThanOrEqual(900)
  })

  test('errors and dropped connections are retried until the game is in', async ({
    netfuse,
    serveSteam
  }) => {
    const steam = await serveSteam(syntheticApp(12, 2))
    // Each chunk's first try goes wrong one way or another; the next one is answered. (A wrong
    // length from every server would rightly count as a chunk no server can send.)
    const faults = [{ status: 503 }, { cutAfter: 1000 }, { endAfter: 10 }, 'overlong'] as const
    const tries = new Map<string, number>()
    let next = 0
    steam.setRule((request) => {
      if (request.kind !== 'chunk') return undefined
      const tried = tries.get(request.sha!) ?? 0
      tries.set(request.sha!, tried + 1)
      return tried === 0 ? faults[next++ % faults.length] : undefined
    })
    await netfuse.startSteam(steam)
    await netfuse.waitForSteamStatus('completed', 40_000)
  })

  test('a stalled response is given up on and asked for again', async ({ netfuse, serveSteam }) => {
    const steam = await serveSteam()
    steam.setRule((request) =>
      request.kind !== 'chunk'
        ? undefined
        : request.n === 2
          ? 'stallBody'
          : request.n === 3
            ? 'stallHeaders'
            : undefined
    )
    await netfuse.startSteam(steam)
    await netfuse.waitForSteamStatus('completed', 30_000)
  })

  test('servers that want a CDN token get one, and a fresh one once it expires @smoke', async ({
    netfuse,
    serveSteam
  }) => {
    const steam = await serveSteam(syntheticApp(13, 2), { requireToken: true })
    await netfuse.startSteam(steam)
    await netfuse.waitUntil((state) => expectSteam(state).chunksDone >= 3)
    steam.expireCdnTokens()
    await netfuse.waitForSteamStatus('completed')
    const refused = steam.log.filter((entry) => entry.status === 403)
    expect(refused.length).toBeGreaterThan(0)
    expect(steam.log.filter((entry) => entry.status === 200 && entry.token).length).toBeGreaterThan(
      0
    )
  })

  test('a server that doesn’t have a chunk sends it to the other', async ({
    netfuse,
    serveSteam
  }) => {
    const steam = await serveSteam()
    steam.setRule((request) =>
      request.kind === 'chunk' && request.server === 0 ? { status: 404 } : undefined
    )
    await netfuse.startSteam(steam)
    await netfuse.waitForSteamStatus('completed')
    const served = steam.chunkRequests().filter((entry) => entry.status === 200)
    expect(served.every((entry) => entry.server === 1)).toBe(true)
  })

  test('logged out mid-download, it stops, says to log in, and resumes after', async ({
    netfuse,
    serveSteam
  }) => {
    const steam = await serveSteam(syntheticApp(14, 3), {
      requireToken: true,
      bytesPerSecond: 256 * 1024
    })
    const id = await netfuse.startSteam(steam)
    await netfuse.waitUntil((state) => expectSteam(state).chunksDone >= 2)
    steam.revokeLogins()
    steam.expireCdnTokens()
    const stopped = await netfuse.waitForSteamStatus('error')
    expect(stopped.error).toBe('Log in to Steam to continue.')
    expect(stopped.resumable).not.toBe(false)
    await expect.poll(async () => (await netfuse.api.steamLoginState()).status).toBe('logged-out')

    await netfuse.loginSteam()
    await netfuse.api.resumeDownload(id)
    await netfuse.waitForSteamStatus('completed', 30_000)
  })
})
