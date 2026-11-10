import type {
  SteamAppDetails,
  SteamOwnedApp,
  WorkshopGame,
  WorkshopGamesPage,
  WorkshopGamesQuery,
  WorkshopPage,
  WorkshopQuery
} from '../../shared/steam'
import type { SteamAccount } from './account'
import type { SteamAnonymous } from './anonymous'
import {
  depotNameSources,
  hasWorkshop,
  nameDepots,
  readAppInfo,
  readArtPaths,
  type SteamArtPaths
} from './appInfo'
import type { SteamSession } from './backend'
import { searchStore } from './store'
import { readWorkshopItem, STORE_PAGE_SIZE, workshopQuery } from './workshop'

// What the logged-in account owns, and what an app is made of. Ownership comes from the account's
// own licenses: each license is a package, and a package lists the apps and depots it grants
// (Steam's PICS). Only apps and depots licensed to the account are offered, Family Sharing's
// borrowed licenses included and marked. Steam has the last word either way: it hands out a
// depot's key only to an account licensed for it.
//
// A Workshop is listed and downloaded from for a game the account owns. With the Workshop tab's
// switch on, also for one Steam lets its anonymous account have (see anonymous.ts): those are
// found on Steam's store, and their items come through that account.

/** Appinfo requests are batched: a big library is thousands of apps. */
const PACKAGES_PER_REQUEST = 500
const APPS_PER_REQUEST = 200
/** Workshop pictures' addresses kept: a few hundred pages of a Workshop. */
const PREVIEWS_KEPT = 5000

/** App types listed in the library. DLC installs with its game; the rest isn't installable. */
const LISTED_TYPES = new Set(['game', 'application', 'tool', 'demo', 'beta'])
/** App types whose Workshops are offered from the store: not a DLC's or a soundtrack's, which
 * the store lists beside their game's. */
const WORKSHOP_TYPES = new Set(['game', 'application', 'tool'])
/** Steam is asked about this many games' Workshops at once. */
const OPEN_CHECKS_AT_ONCE = 6

const NOT_OWNED =
  'This Steam account doesn’t own this game. With “Games you don’t own” on, NetFuse gets a Workshop’s items through Steam’s anonymous account, where Steam allows it.'
const CLOSED = 'Steam doesn’t let anyone download this game’s Workshop without owning the game.'

/** How a game's Workshop is had: through the account, which owns the game, or through Steam's
 * anonymous account. */
export type WorkshopAccess = 'account' | 'anonymous'

/** What a game's Workshop needs of its appinfo. */
export interface WorkshopGameInfo {
  appId: number
  name: string
  type: string
  workshop: boolean
  workshopDepot: number
}

interface Ownership {
  session: SteamSession
  /** By app id: whether every license for it is borrowed. */
  apps: Map<number, boolean>
  /** By depot id: whether every license for it is borrowed. */
  depots: Map<number, boolean>
}

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : undefined

/** A package's app or depot ids: an array, or an object of them keyed "0", "1", … */
function idsOf(value: unknown): number[] {
  const list = Array.isArray(value) ? value : Object.values(asRecord(value) ?? {})
  return list
    .map((id) => Number(id))
    .filter((id) => Number.isInteger(id) && id > 0 && id <= 0xffffffff)
}

function chunked<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = []
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size))
  return chunks
}

export class SteamLibrary {
  private ownership: Promise<Ownership> | null = null
  private apps: Promise<SteamOwnedApp[]> | null = null
  /** Where each listed app's pictures are, from the appinfo the listing fetched. */
  private readonly art = new Map<number, SteamArtPaths>()
  /** Where Workshop items' pictures are, as Steam gave them, by item: art.ts checks and fetches
   * them. */
  private readonly previews = new Map<string, string>()

  constructor(
    private readonly account: SteamAccount,
    private readonly anonymous: SteamAnonymous,
    /** Whether the Workshop tab's switch for games the account doesn't own is on. */
    private readonly workshopAnonymous: () => Promise<boolean>
  ) {
    // A different login owns different things.
    account.onChange((state) => {
      if (state.status !== 'logged-in') this.forget()
    })
  }

  forget(): void {
    this.ownership = null
    this.apps = null
  }

  private async loadOwnership(): Promise<Ownership> {
    const session = await this.account.current()
    const licenses = await session.licenses()
    const borrowedPackage = new Map<number, boolean>()
    for (const license of licenses) {
      // Owned outright through any one license is owned outright.
      borrowedPackage.set(
        license.packageId,
        (borrowedPackage.get(license.packageId) ?? true) && license.borrowed
      )
    }
    const apps = new Map<number, boolean>()
    const depots = new Map<number, boolean>()
    const grant = (map: Map<number, boolean>, id: number, borrowed: boolean): void => {
      map.set(id, (map.get(id) ?? true) && borrowed)
    }
    for (const batch of chunked([...borrowedPackage.keys()], PACKAGES_PER_REQUEST)) {
      const info = await session.productInfo([], batch)
      for (const [id, entry] of Object.entries(info.packages)) {
        const packageInfo = asRecord(entry.packageinfo)
        const borrowed = borrowedPackage.get(Number(id)) ?? false
        for (const appId of idsOf(packageInfo?.appids)) grant(apps, appId, borrowed)
        for (const depotId of idsOf(packageInfo?.depotids)) grant(depots, depotId, borrowed)
      }
    }
    return { session, apps, depots }
  }

  private owned(): Promise<Ownership> {
    this.ownership ??= this.loadOwnership().catch((error) => {
      this.ownership = null
      throw error
    })
    return this.ownership
  }

  /** The installable apps the account owns, by name. `refresh` asks Steam again. */
  ownedApps(refresh = false): Promise<SteamOwnedApp[]> {
    if (refresh) this.forget()
    this.apps ??= (async () => {
      const { session, apps } = await this.owned()
      const listed: SteamOwnedApp[] = []
      for (const batch of chunked([...apps.keys()], APPS_PER_REQUEST)) {
        const info = await session.productInfo(batch, [])
        for (const [id, entry] of Object.entries(info.apps)) {
          const appId = Number(id)
          const appinfo = asRecord(entry.appinfo)
          const common = asRecord(appinfo?.common)
          const type = String(common?.type ?? '').toLowerCase()
          const name = typeof common?.name === 'string' ? common.name.slice(0, 200) : ''
          if (!name || !LISTED_TYPES.has(type) || !asRecord(appinfo?.depots)) continue
          listed.push({
            appId,
            name,
            type,
            borrowed: apps.get(appId) ?? false,
            workshop: hasWorkshop(appinfo)
          })
          this.art.set(appId, readArtPaths(appinfo))
        }
      }
      return listed.sort((a, b) => a.name.localeCompare(b.name))
    })().catch((error) => {
      this.apps = null
      throw error
    })
    return this.apps
  }

  /** Where an app's pictures are, once the listing has seen it; undefined before. */
  artPaths(appId: number): SteamArtPaths | undefined {
    return this.art.get(appId)
  }

  /** An owned app's details, its depots marked owned (and borrowed) by the account's licenses. */
  async appDetails(appId: number): Promise<SteamAppDetails> {
    const { session, apps, depots } = await this.owned()
    if (!apps.has(appId)) {
      throw new Error('This Steam account doesn’t own this app, so NetFuse won’t download it.')
    }
    const info = await session.productInfo([appId], [])
    const entry = info.apps[String(appId)]
    if (!entry) throw new Error('Steam didn’t send this app’s details.')
    const details = readAppInfo(appId, entry.appinfo)
    for (const depot of details.depots) {
      // A DLC's depots belong to the DLC's license; the rest are granted with the app's.
      const borrowed = depots.get(depot.depotId)
      depot.owned = borrowed !== undefined
      if (borrowed) depot.borrowed = true
    }
    const sources = depotNameSources(details)
    try {
      const appinfo: Record<string, unknown> = {}
      for (const batch of chunked(sources, APPS_PER_REQUEST)) {
        const named = await session.productInfo(batch, [])
        for (const [id, entry] of Object.entries(named.apps)) appinfo[id] = entry.appinfo
      }
      nameDepots(details, appinfo)
    } catch {
      // Only names: without them, those depots go by their numbers.
    }
    return details
  }

  /** A page of the Workshop of a game whose items NetFuse can download (see workshopAccess). The
   * account's own session lists it either way: listing a Workshop needs no license. */
  async workshop(query: WorkshopQuery): Promise<WorkshopPage> {
    const request = workshopQuery(query)
    await this.workshopAccess(request.appId)
    const { session } = await this.owned()
    const page = await session.queryWorkshop(request)
    const items: WorkshopPage['items'] = []
    for (const raw of page.items) {
      const item = readWorkshopItem(raw, request.appId)
      if (!item) continue
      items.push(item)
      this.rememberPreview(item.publishedFileId, raw)
    }
    return { items, total: Math.max(page.total, items.length), nextCursor: page.nextCursor }
  }

  /** Where a Workshop item's picture is, as Steam gave it: the listing's, or asked for. */
  async workshopPreview(publishedFileId: string): Promise<string | undefined> {
    if (!this.previews.has(publishedFileId)) {
      const { session } = await this.owned()
      const [raw] = await session.workshopDetails([publishedFileId])
      this.rememberPreview(publishedFileId, raw)
    }
    return this.previews.get(publishedFileId) || undefined
  }

  /** An empty address is kept too: the item has no picture, and isn't asked about again. */
  private rememberPreview(publishedFileId: string, raw: unknown): void {
    const url = (raw as { preview_url?: unknown } | null)?.preview_url
    this.previews.delete(publishedFileId)
    this.previews.set(publishedFileId, typeof url === 'string' && url.length <= 2048 ? url : '')
    if (this.previews.size > PREVIEWS_KEPT) {
      this.previews.delete(this.previews.keys().next().value!)
    }
  }

  /** How `appId`'s Workshop items can be had: through the account, which owns the game; or, with
   * the switch on, through Steam's anonymous account when Steam lets it. Throws otherwise. */
  async workshopAccess(appId: number): Promise<WorkshopAccess> {
    const { apps } = await this.owned()
    if (apps.has(appId)) return 'account'
    if (!(await this.workshopAnonymous())) throw new Error(NOT_OWNED)
    const [game] = await this.gameInfo([appId])
    if (game?.workshop && (await this.anonymous.workshopOpen(appId, game.workshopDepot))) {
      return 'anonymous'
    }
    throw new Error(CLOSED)
  }

  /** What games' Workshops need of their appinfo, owned or not; a game Steam has no appinfo for
   * is left out. Asked through the anonymous account, which needs no license to read it. */
  async gameInfo(appIds: number[]): Promise<WorkshopGameInfo[]> {
    const session = await this.anonymous.current()
    const games: WorkshopGameInfo[] = []
    for (const batch of chunked(appIds, APPS_PER_REQUEST)) {
      const info = await session.productInfo(batch, [])
      for (const appId of batch) {
        const appinfo = info.apps[String(appId)]?.appinfo
        if (!asRecord(appinfo)) continue
        const details = readAppInfo(appId, appinfo)
        games.push({
          appId,
          name: details.name,
          type: details.type,
          workshop: hasWorkshop(appinfo),
          workshopDepot: details.workshopDepot
        })
        if (!this.art.has(appId)) this.art.set(appId, readArtPaths(appinfo))
      }
    }
    return games
  }

  /**
   * A page of the games on Steam's store with a Workshop NetFuse can download from, in the store's
   * order (the most popular first, or by how well their names match `search`): those the account
   * owns, and those Steam lets its anonymous account have. Only with the switch on.
   */
  async workshopGames(query: WorkshopGamesQuery): Promise<WorkshopGamesPage> {
    if (!(await this.workshopAnonymous())) throw new Error(NOT_OWNED)
    const start = query.start ?? 0
    const found = await searchStore(query.search ?? '', start)
    const { apps } = await this.owned()
    const info = new Map(
      (await this.gameInfo(found.map((game) => game.appId))).map((game) => [game.appId, game])
    )
    const games: (WorkshopGame | null)[] = found.map(() => null)
    let next = 0
    const check = async (): Promise<void> => {
      while (next < found.length) {
        const index = next++
        const game = info.get(found[index].appId)
        if (!game?.workshop || !WORKSHOP_TYPES.has(game.type)) continue
        const owned = apps.has(game.appId)
        // A game Steam can't be asked about now is left off this page, rather than failing it.
        const open =
          owned ||
          (await this.anonymous.workshopOpen(game.appId, game.workshopDepot).catch(() => false))
        if (open) games[index] = { appId: game.appId, name: game.name, owned }
      }
    }
    await Promise.all(Array.from({ length: OPEN_CHECKS_AT_ONCE }, check))
    return {
      games: games.filter((game): game is WorkshopGame => game !== null),
      nextStart: found.length >= STORE_PAGE_SIZE ? start + STORE_PAGE_SIZE : undefined
    }
  }

  /** Whether the account is licensed for `depotId`, and how. */
  async depotOwnership(depotId: number): Promise<'owned' | 'borrowed' | null> {
    const borrowed = (await this.owned()).depots.get(depotId)
    return borrowed === undefined ? null : borrowed ? 'borrowed' : 'owned'
  }
}
