import type { RawContentServer } from './backend'

// Steam's content servers, as a Steam download uses them: which ones, which stream asks which, a
// server benched on a network that it keeps failing on, and the CDN auth tokens some servers
// want. Pure: what to do is decided from what it is told, the clock included.

export interface ContentServer {
  /** Where to connect, as Steam names it ("host" or "host:port"). */
  host: string
  /** The name to ask for, when Steam gives one apart from the host. */
  vhost: string
  https: boolean
}

/** How many of the best servers a download spreads its streams over. */
const SERVERS_USED = 8
/** A server that failed this many times in a row on a network is benched there for a while. */
const FAILURES_TO_BENCH = 3
const BENCHED_FOR_MS = 60_000
/** A token is fetched again this long before Steam says it expires. */
const TOKEN_MARGIN_MS = 5 * 60_000

const HOST = /^[a-z0-9.-]{1,253}(:\d{1,5})?$/i

/** The servers to use for `appId`, best first: CDN and SteamCache servers only (others aren't for
 * clients), any limited to other apps left out, by Steam's own weighted load. */
export function rankServers(servers: readonly RawContentServer[], appId: number): ContentServer[] {
  return servers
    .filter((server) => server.type === 'CDN' || server.type === 'SteamCache')
    .filter((server) => HOST.test(server.host))
    .filter((server) => !server.allowedAppIds?.length || server.allowedAppIds.includes(appId))
    .sort((a, b) => (a.weightedLoad ?? Infinity) - (b.weightedLoad ?? Infinity))
    .slice(0, SERVERS_USED)
    .map((server) => ({
      host: server.host.toLowerCase(),
      vhost:
        server.vhost && HOST.test(server.vhost)
          ? server.vhost.toLowerCase()
          : server.host.toLowerCase(),
      // Steam serves content over plain HTTP where a server can't do better; the chunks are
      // encrypted and checked either way, but HTTPS is used wherever it is offered.
      https: server.httpsSupport === 'mandatory' || server.httpsSupport === 'optional'
    }))
}

export class ServerPool {
  /** By network, then server host: failures in a row, and until when it is benched. */
  private readonly health = new Map<
    string,
    Map<string, { failures: number; benchedUntil: number }>
  >()

  constructor(readonly servers: readonly ContentServer[]) {
    if (servers.length === 0) throw new Error('Steam listed no content servers for this app.')
  }

  private healthOf(networkId: string, host: string): { failures: number; benchedUntil: number } {
    let byHost = this.health.get(networkId)
    if (!byHost) this.health.set(networkId, (byHost = new Map()))
    let entry = byHost.get(host)
    if (!entry) byHost.set(host, (entry = { failures: 0, benchedUntil: 0 }))
    return entry
  }

  /**
   * The server for the `slot`th stream of network number `networkIndex`, skipping `avoid` and any
   * benched on that network. Networks start at different servers, so two networks' streams spread
   * over the list rather than all asking the first; when every server is benched, the one coming
   * off the bench soonest.
   */
  pick(
    networkId: string,
    networkIndex: number,
    slot: number,
    now: number,
    avoid?: string
  ): ContentServer {
    const count = this.servers.length
    const start = (networkIndex * Math.max(1, Math.floor(count / 2)) + slot) % count
    let fallback: ContentServer = this.servers[start]
    let soonest = Infinity
    for (let i = 0; i < count; i++) {
      const server = this.servers[(start + i) % count]
      const { benchedUntil } = this.healthOf(networkId, server.host)
      if (server.host === avoid && count > 1) continue
      if (benchedUntil <= now) return server
      if (benchedUntil < soonest) {
        soonest = benchedUntil
        fallback = server
      }
    }
    return fallback
  }

  /** A request to `host` over `networkId` failed the way a bad server does (refused, broken,
   * gone silent). Says whether that benched it. */
  failed(networkId: string, host: string, now: number): boolean {
    const entry = this.healthOf(networkId, host)
    entry.failures += 1
    if (entry.failures < FAILURES_TO_BENCH) return false
    entry.failures = 0
    entry.benchedUntil = now + BENCHED_FOR_MS
    return true
  }

  served(networkId: string, host: string): void {
    const entry = this.healthOf(networkId, host)
    entry.failures = 0
    entry.benchedUntil = 0
  }

  /** The computer slept, or a network came back: past judgements of the servers start over. */
  forgive(): void {
    this.health.clear()
  }
}

/** CDN auth tokens, by depot and host, fetched once and again shortly before they expire, or
 * when a server turns one down. */
export class TokenCache {
  private readonly tokens = new Map<string, Promise<{ token: string; expiresAt: number }>>()

  constructor(
    private readonly fetch: (
      depotId: number,
      host: string
    ) => Promise<{ token: string; expiresAt: number }>
  ) {}

  async get(depotId: number, host: string, now: number): Promise<string> {
    const key = `${depotId} ${host}`
    let entry = this.tokens.get(key)
    if (entry) {
      const settled = await entry.catch(() => null)
      if (!settled || settled.expiresAt - TOKEN_MARGIN_MS <= now) entry = undefined
    }
    if (!entry) {
      entry = this.fetch(depotId, host)
      this.tokens.set(key, entry)
      entry.catch(() => this.tokens.delete(key))
    }
    return (await entry).token
  }

  /** A server turned the token down: the next request gets a new one. */
  invalidate(depotId: number, host: string): void {
    this.tokens.delete(`${depotId} ${host}`)
  }
}

/** The URL a chunk is fetched from. Steam's CDN token is a query string of its own ("?token=…"),
 * appended as steam-user does; one without its "?" gets one. */
export function chunkUrl(server: ContentServer, depotId: number, sha: string, token?: string): URL {
  const url = new URL(
    `${server.https ? 'https' : 'http'}://${server.host}/depot/${depotId}/chunk/${sha}`
  )
  if (token) url.search = token.startsWith('?') ? token : `?${token}`
  return url
}

/** The URL a depot manifest is fetched from, with its request code (which grants it for a few
 * minutes). Never shown or logged: redact() strips the code from any message it appears in. */
export function manifestUrl(
  server: ContentServer,
  depotId: number,
  manifestId: string,
  requestCode: string,
  token?: string
): URL {
  const url = new URL(
    `${server.https ? 'https' : 'http'}://${server.host}/depot/${depotId}/manifest/${manifestId}/5/${requestCode}`
  )
  if (token) url.search = token.startsWith('?') ? token : `?${token}`
  return url
}
