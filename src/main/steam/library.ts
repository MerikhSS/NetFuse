import type { SteamAppDetails, SteamOwnedApp } from '../../shared/steam'
import type { SteamAccount } from './account'
import { readAppInfo, readArtPaths, type SteamArtPaths } from './appInfo'
import type { SteamSession } from './backend'

// What the logged-in account owns, and what an app is made of. Ownership comes from the account's
// own licenses: each license is a package, and a package lists the apps and depots it grants
// (Steam's PICS). Only apps and depots licensed to the account are offered, Family Sharing's
// borrowed licenses included and marked. Steam has the last word either way: it hands out a
// depot's key only to an account licensed for it.

/** Appinfo requests are batched: a big library is thousands of apps. */
const PACKAGES_PER_REQUEST = 500
const APPS_PER_REQUEST = 200
/** App types listed in the library. DLC installs with its game; the rest isn't installable. */
const LISTED_TYPES = new Set(['game', 'application', 'tool', 'demo', 'beta'])

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

  constructor(private readonly account: SteamAccount) {
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
          listed.push({ appId, name, type, borrowed: apps.get(appId) ?? false })
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
    return details
  }

  /** Whether the account is licensed for `depotId`, and how. */
  async depotOwnership(depotId: number): Promise<'owned' | 'borrowed' | null> {
    const borrowed = (await this.owned()).depots.get(depotId)
    return borrowed === undefined ? null : borrowed ? 'borrowed' : 'owned'
  }
}
