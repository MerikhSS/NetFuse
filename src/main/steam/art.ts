import { app, net, protocol } from 'electron'
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { testSteamFake } from '../testKnobs'
import type { SteamArtPaths } from './appInfo'
import type { SteamLibrary } from './library'
import { isPublishedFileId, workshopPreview } from './workshop'

// Game pictures for the window: a Steam app's capsule, header and banner, from Steam's store CDN,
// kept on disk so that a library of thousands is fetched once. The window asks for them as
// game-art://steam/<appId>/<kind>, which only this answers: the renderer never reaches the
// network itself, and its CSP lets it load pictures from here and nowhere else.
//
// A Workshop item's picture comes the same way, as game-art://workshop/<publishedFileId>: from
// where Steam's details for the item say, and only from Steam's Workshop image servers.

export const ART_SCHEME = 'game-art'

/** Each picture's usual name, for an app whose appinfo doesn't say (or hasn't been listed). */
const DEFAULT_PATHS: Record<keyof SteamArtPaths, string> = {
  capsule: 'library_600x900.jpg',
  header: 'header.jpg',
  hero: 'library_hero.jpg'
}
const CDN = 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps'
/** A banner is a megabyte or two; anything far past that isn't a picture worth keeping. */
const MAX_BYTES = 12 * 1024 * 1024
const FETCH_TIMEOUT_MS = 15_000
/** Fetches at once: a screenful of a library asks for a few dozen together. */
const AT_ONCE = 6
/** How long a picture Steam doesn't have is taken to be missing before it's asked for again. */
const MISSING_FOR_MS = 3 * 24 * 60 * 60_000
/** Steam's Workshop pages ask its image servers for a picture this size, rather than the
 * original, which can be several megabytes. */
const WORKSHOP_SIZE = {
  imw: '512',
  imh: '512',
  ima: 'fit',
  impolicy: 'Letterbox',
  imcolor: '#000000',
  letterbox: 'false'
}

/** Before the app is ready: the scheme is a standard, secure one, so the CSP can name it. */
export function registerArtScheme(): void {
  protocol.registerSchemesAsPrivileged([
    { scheme: ART_SCHEME, privileges: { standard: true, secure: true } }
  ])
}

/** What a picture's bytes are, or null when they aren't one. */
function imageType(bytes: Buffer): string | null {
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  if (bytes.subarray(0, 4).toString('hex') === '89504e47') return 'image/png'
  if (/^GIF8[79]a$/.test(bytes.subarray(0, 6).toString('latin1'))) return 'image/gif'
  if (bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP') {
    return 'image/webp'
  }
  return null
}

export function handleArt(library: SteamLibrary): void {
  const cache = join(app.getPath('userData'), 'art')
  const inFlight = new Map<string, Promise<Buffer | null>>()
  let running = 0
  const waiting: (() => void)[] = []

  const inTurn = async <T>(work: () => Promise<T>): Promise<T> => {
    if (running >= AT_ONCE) await new Promise<void>((resolve) => waiting.push(resolve))
    running++
    try {
      return await work()
    } finally {
      running--
      waiting.shift()?.()
    }
  }

  /** A picture kept on disk under `name`, or fetched from where `locate` says and kept. */
  const cached = async (
    name: string,
    locate: () => Promise<string | undefined>
  ): Promise<Buffer | null> => {
    const file = join(cache, name)
    const missing = `${file}.missing`
    const kept = await readFile(file).catch(() => null)
    if (kept && imageType(kept)) return kept
    const missingSince = await stat(missing).then(
      (info) => info.mtimeMs,
      () => null
    )
    if (missingSince !== null && Date.now() - missingSince < MISSING_FOR_MS) return null

    const markMissing = async (): Promise<null> => {
      await mkdir(cache, { recursive: true })
      await writeFile(missing, '')
      return null
    }
    const url = await locate()
    if (!url) return markMissing()
    const response = await net.fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
    // Not there, which Steam's CDN says either way. Anything else may be passing: asked again
    // next time.
    if (response.status === 404 || response.status === 403) return markMissing()
    if (!response.ok) return null
    if (Number(response.headers.get('content-length') ?? 0) > MAX_BYTES) return null
    const bytes = Buffer.from(await response.arrayBuffer())
    if (bytes.length > MAX_BYTES) return null
    if (!imageType(bytes)) return markMissing()
    await mkdir(cache, { recursive: true })
    const partial = `${file}.${process.pid}.part`
    await writeFile(partial, bytes)
    await rename(partial, file)
    return bytes
  }

  const fetchArt = (appId: number, kind: keyof SteamArtPaths): Promise<Buffer | null> =>
    cached(`${appId}-${kind}`, async () => {
      const path = library.artPaths(appId)?.[kind] ?? DEFAULT_PATHS[kind]
      const fake = testSteamFake()
      return `${fake ? `${fake}/art` : CDN}/${appId}/${path}`
    })

  const fetchWorkshopArt = (publishedFileId: string): Promise<Buffer | null> =>
    cached(`workshop-${publishedFileId}`, async () => {
      const fake = testSteamFake()
      const found = workshopPreview(
        { preview_url: await library.workshopPreview(publishedFileId) },
        fake
      )
      if (!found || fake) return found
      const url = new URL(found)
      for (const [name, value] of Object.entries(WORKSHOP_SIZE)) url.searchParams.set(name, value)
      return url.href
    })

  /** Which picture a game-art:// URL names, and how to get it; null for anything else. */
  const pictureOf = (url: URL): { key: string; fetch: () => Promise<Buffer | null> } | null => {
    if (url.host === 'steam') {
      const match = /^\/(\d{1,10})\/(capsule|header|hero)$/.exec(url.pathname)
      if (!match) return null
      const appId = Number(match[1])
      const kind = match[2] as keyof SteamArtPaths
      return { key: `${appId}-${kind}`, fetch: () => fetchArt(appId, kind) }
    }
    const id = url.pathname.slice(1)
    if (url.host === 'workshop' && isPublishedFileId(id)) {
      return { key: `workshop-${id}`, fetch: () => fetchWorkshopArt(id) }
    }
    return null
  }

  protocol.handle(ART_SCHEME, async (request) => {
    const picture = pictureOf(new URL(request.url))
    if (!picture) return new Response(null, { status: 404 })
    const key = picture.key
    let pending = inFlight.get(key)
    if (!pending) {
      pending = inTurn(picture.fetch)
        .catch(() => null)
        .finally(() => inFlight.delete(key))
      inFlight.set(key, pending)
    }
    const bytes = await pending
    const type = bytes && imageType(bytes)
    if (!bytes || !type) return new Response(null, { status: 404 })
    return new Response(new Uint8Array(bytes), {
      headers: { 'content-type': type, 'cache-control': 'max-age=86400' }
    })
  })
}
