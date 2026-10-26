import { expect, test } from '@playwright/test'
import { contentMessage, EResult, loginExpired, loginMessage } from '../src/main/steam/eresult'
import {
  chunkUrl,
  manifestUrl,
  rankServers,
  ServerPool,
  TokenCache,
  type ContentServer
} from '../src/main/steam/servers'

// Steam's content servers as a download uses them, and what its result codes say to the user.

const server = (host: string, extra: object = {}): ContentServer => ({
  host,
  vhost: host,
  https: false,
  ...extra
})

test.describe('steam content servers', () => {
  test('only client servers for this app are used, best first, over HTTPS where offered', () => {
    const ranked = rankServers(
      [
        { type: 'CDN', host: 'slow.example', weightedLoad: 90 },
        { type: 'SteamCache', host: 'Fast.Example', weightedLoad: 10, httpsSupport: 'optional' },
        { type: 'CS', host: 'internal.example', weightedLoad: 1 },
        { type: 'CDN', host: 'other-app.example', weightedLoad: 1, allowedAppIds: [7] },
        {
          type: 'CDN',
          host: 'mine.example',
          weightedLoad: 50,
          allowedAppIds: [480],
          vhost: 'v.example'
        },
        { type: 'CDN', host: 'bad host/../x', weightedLoad: 1 }
      ],
      480
    )
    expect(ranked).toEqual([
      { host: 'fast.example', vhost: 'fast.example', https: true },
      { host: 'mine.example', vhost: 'v.example', https: false },
      { host: 'slow.example', vhost: 'slow.example', https: false }
    ])
    expect(rankServers([{ type: 'CDN', host: '127.0.0.1:8080' }], 1)[0].host).toBe('127.0.0.1:8080')
  })

  test('networks start at different servers, so their streams spread over the list', () => {
    const pool = new ServerPool(['a', 'b', 'c', 'd'].map((host) => server(host)))
    const now = 0
    const first = [0, 1].map((network) => pool.pick(`n${network}`, network, 0, now).host)
    expect(new Set(first).size).toBe(2)
    const one = [0, 1, 2, 3].map((slot) => pool.pick('n0', 0, slot, now).host)
    expect(new Set(one).size).toBe(4)
    // A server to avoid is skipped while there is another.
    expect(pool.pick('n0', 0, 0, now, 'a').host).not.toBe('a')
    expect(() => new ServerPool([])).toThrow(/no content servers/)
  })

  test('a server that keeps failing on a network is benched there, and only there, for a while', () => {
    const pool = new ServerPool([server('a'), server('b')])
    expect(pool.failed('wifi', 'a', 0)).toBe(false)
    expect(pool.failed('wifi', 'a', 0)).toBe(false)
    expect(pool.failed('wifi', 'a', 0)).toBe(true)
    expect(pool.pick('wifi', 0, 0, 1000).host).toBe('b')
    expect(pool.pick('usb', 0, 0, 1000).host).toBe('a')
    // Off the bench once its time is up, or once it serves again.
    expect(pool.pick('wifi', 0, 0, 61_000).host).toBe('a')
    pool.failed('wifi', 'a', 0)
    pool.served('wifi', 'a')
    expect(pool.failed('wifi', 'a', 0)).toBe(false)
    // Every server benched: the one back soonest.
    pool.failed('wifi', 'b', 100)
    pool.failed('wifi', 'b', 100)
    pool.failed('wifi', 'b', 100)
    // The failure just above already counts: two more bench it.
    pool.failed('wifi', 'a', 0)
    expect(pool.failed('wifi', 'a', 0)).toBe(true)
    expect(pool.pick('wifi', 0, 0, 200).host).toBe('a')
  })

  test('a CDN token is fetched once, again before it expires, and again when refused', async () => {
    let fetched = 0
    const tokens = new TokenCache(async () => ({
      token: `?token=t${++fetched}`,
      expiresAt: 10 * 60_000
    }))
    const [one, two] = await Promise.all([tokens.get(1, 'h', 0), tokens.get(1, 'h', 0)])
    expect([one, two, fetched]).toEqual(['?token=t1', '?token=t1', 1])
    expect(await tokens.get(1, 'h', 6 * 60_000)).toBe('?token=t2')
    tokens.invalidate(1, 'h')
    expect(await tokens.get(1, 'h', 0)).toBe('?token=t3')
    // A failed fetch isn't kept.
    let fail = true
    const flaky = new TokenCache(async () => {
      if (fail) throw new Error('no')
      return { token: 'x', expiresAt: Infinity }
    })
    await expect(flaky.get(1, 'h', 0)).rejects.toThrow('no')
    fail = false
    expect(await flaky.get(1, 'h', 0)).toBe('x')
  })

  test('chunk and manifest URLs carry the token as a query string, with or without its "?"', () => {
    const https = server('cache.example', { https: true })
    expect(chunkUrl(https, 441, 'ab'.repeat(20)).href).toBe(
      `https://cache.example/depot/441/chunk/${'ab'.repeat(20)}`
    )
    expect(chunkUrl(server('h:81'), 1, 'c', '?token=x').href).toBe(
      'http://h:81/depot/1/chunk/c?token=x'
    )
    expect(chunkUrl(server('h'), 1, 'c', 'token=x').search).toBe('?token=x')
    expect(manifestUrl(https, 441, '123', '456').pathname).toBe('/depot/441/manifest/123/5/456')
  })
})

test.describe('steam results', () => {
  test('login and content refusals read as what they mean', () => {
    expect(loginMessage(EResult.InvalidPassword, 'x')).toMatch(/password is wrong/)
    expect(loginMessage(EResult.TwoFactorCodeMismatch, 'x')).toMatch(/code isn’t right/)
    expect(loginMessage(999, 'Steam said 999')).toBe('Steam said 999')
    expect(loginExpired(EResult.Expired)).toBe(true)
    expect(loginExpired(EResult.NoConnection)).toBe(false)
    expect(contentMessage(EResult.AccessDenied, 441)).toMatch(/isn’t licensed for depot 441/)
    expect(contentMessage(EResult.RegionLocked, 441)).toMatch(/region/)
  })
})
