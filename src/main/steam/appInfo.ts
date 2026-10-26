import type {
  SteamAppDetails,
  SteamArch,
  SteamBranch,
  SteamDepot,
  SteamDepotManifest,
  SteamOs
} from '../../shared/steam'
import {
  defaultDepots,
  defaultLanguage,
  depotUnavailable,
  manifestFor,
  steamSystem
} from '../../shared/steamSelection'

// An app's PICS appinfo, as steam-user hands it over: Valve's KeyValues text, parsed into nested
// objects of strings. Its shape isn't documented and has changed over the years (a manifest id
// used to be a bare string, now it is an object with sizes), and it comes from the network, so
// this reads it defensively: whatever is missing or malformed is left out, never trusted.

type Node = Record<string, unknown>

const asNode = (value: unknown): Node | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Node) : undefined

const asString = (value: unknown): string | undefined =>
  typeof value === 'string' ? value : typeof value === 'number' ? String(value) : undefined

const asId = (value: unknown): number | undefined => {
  const text = asString(value)
  if (!text || !/^\d{1,10}$/.test(text)) return undefined
  const id = Number(text)
  return id > 0 && id <= 0xffffffff ? id : undefined
}

const asSize = (value: unknown): number | undefined => {
  const text = asString(value)
  if (!text || !/^\d{1,16}$/.test(text)) return undefined
  const size = Number(text)
  return Number.isSafeInteger(size) ? size : undefined
}

const asFlag = (value: unknown): boolean => asString(value) === '1'

/** A language as Steam names one ("english", "schinese", "latam"). */
const isLanguage = (value: string): boolean => /^[a-z_-]{1,40}$/.test(value)

const OS_NAMES: Record<string, SteamOs> = { windows: 'windows', macos: 'macos', linux: 'linux' }

function osList(value: unknown): SteamOs[] {
  const list = (asString(value) ?? '')
    .split(',')
    .map((entry) => OS_NAMES[entry.trim().toLowerCase()])
    .filter((os): os is SteamOs => os !== undefined)
  return [...new Set(list)]
}

/** A manifest id: a decimal uint64. */
const isGid = (value: string | undefined): value is string =>
  !!value && /^\d{1,20}$/.test(value) && BigInt(value) <= 0xffffffffffffffffn

function manifestOf(value: unknown): SteamDepotManifest | undefined {
  // Old appinfo gives the id itself; current appinfo an object with sizes.
  const bare = asString(value)
  if (isGid(bare)) return { gid: bare }
  const node = asNode(value)
  const gid = asString(node?.gid)
  if (!node || !isGid(gid)) return undefined
  const manifest: SteamDepotManifest = { gid }
  const size = asSize(node.size)
  const download = asSize(node.download)
  if (size !== undefined) manifest.size = size
  if (download !== undefined) manifest.download = download
  return manifest
}

/** Branch names are short identifiers; anything else is refused rather than shown or sent. */
export const isBranchName = (name: string): boolean => /^[\w.-]{1,64}$/.test(name)

function readDepot(depotId: number, node: Node): SteamDepot {
  const config = asNode(node.config) ?? {}
  const manifests: Record<string, SteamDepotManifest> = {}
  for (const [branch, value] of Object.entries(asNode(node.manifests) ?? {})) {
    const manifest = manifestOf(value)
    if (manifest && isBranchName(branch)) manifests[branch] = manifest
  }
  const arch = asString(config.osarch)
  const language = asString(config.language)?.trim().toLowerCase()
  const depot: SteamDepot = {
    depotId,
    name: (asString(node.name) ?? '').slice(0, 200) || `Depot ${depotId}`,
    oslist: osList(config.oslist),
    lowViolence: asFlag(config.lowviolence),
    sharedInstall: asFlag(node.sharedinstall),
    manifests,
    encryptedBranches: Object.keys(asNode(node.encryptedmanifests) ?? {}).filter(isBranchName),
    owned: false
  }
  if (arch === '32' || arch === '64') depot.osarch = arch as SteamArch
  if (language && isLanguage(language)) depot.language = language
  const dlcAppId = asId(node.dlcappid)
  if (dlcAppId !== undefined) depot.dlcAppId = dlcAppId
  const sharedFrom = asId(node.depotfromapp)
  if (sharedFrom !== undefined) depot.sharedFrom = sharedFrom
  // China's realm has depots of its own, which a global account can't install: with no manifest
  // on any branch, it is never offered.
  const realm = asString(config.realm)
  if (realm && realm !== 'steamglobal') depot.manifests = {}
  return depot
}

function readBranches(node: Node | undefined): SteamBranch[] {
  const branches: SteamBranch[] = []
  for (const [name, value] of Object.entries(node ?? {})) {
    const branch = asNode(value)
    if (!branch || !isBranchName(name)) continue
    const entry: SteamBranch = {
      name,
      buildId: asString(branch.buildid) ?? '',
      passwordRequired: asFlag(branch.pwdrequired)
    }
    const description = asString(branch.description)
    if (description) entry.description = description.slice(0, 200)
    const updatedAt = asSize(branch.timeupdated)
    if (updatedAt !== undefined) entry.updatedAt = updatedAt
    branches.push(entry)
  }
  // Public first, then the rest by name.
  return branches.sort((a, b) =>
    a.name === 'public' ? -1 : b.name === 'public' ? 1 : a.name.localeCompare(b.name)
  )
}

/** An app's details from its appinfo. Depots come out unowned: the library marks the owned ones. */
export function readAppInfo(appId: number, appinfo: unknown): SteamAppDetails {
  const root = asNode(appinfo) ?? {}
  const common = asNode(root.common) ?? {}
  const config = asNode(root.config) ?? {}
  const depotsNode = asNode(root.depots) ?? {}
  const depots: SteamDepot[] = []
  for (const [key, value] of Object.entries(depotsNode)) {
    // Among the depots sit a few other keys (branches, baselanguages, …).
    const depotId = asId(key)
    const node = asNode(value)
    if (depotId !== undefined && node) depots.push(readDepot(depotId, node))
  }
  const name = (asString(common.name) ?? '').slice(0, 200) || `App ${appId}`
  const packs = depots.flatMap((depot) => (depot.language ? [depot.language] : []))
  // The content depots that name no language are in the app's base languages: English, unless
  // appinfo says otherwise. A game whose language depots are only the other languages has its
  // English there, so it has to be offered too, or English couldn't be picked at all and the
  // first pack in the list would be the default.
  const hasBase = depots.some(
    (depot) => !depot.language && !depot.sharedInstall && depot.sharedFrom === undefined
  )
  const named = (asString(depotsNode.baselanguages) ?? '')
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter(isLanguage)
  const base = hasBase && packs.length > 0 ? (named.length > 0 ? named : ['english']) : []
  const languages = [...new Set([...packs, ...base])].sort()
  return {
    appId,
    name,
    type: (asString(common.type) ?? '').toLowerCase(),
    installDir: (asString(config.installdir) ?? '').trim(),
    branches: readBranches(asNode(depotsNode.branches)),
    depots,
    languages
  }
}

/** Where an app's pictures are on Steam's store CDN, relative to the app's own folder there. A
 * newer app's carry a hash ("<hash>/library_600x900.jpg"); an older one's are plain names. */
export interface SteamArtPaths {
  /** The portrait capsule a Steam library shows, 600 × 900. */
  capsule?: string
  /** The store's landscape header, 460 × 215, which every app has. */
  header?: string
  /** The wide banner over an app's library page. */
  hero?: string
}

/** A picture's path as appinfo gives one: a file name, after the hash of a newer one. Anything
 * else (a "..", a full URL) is left out: it is put into a URL on Steam's CDN. */
const ART_PATH = /^(?:[0-9a-f]{8,64}\/)?[\w-]{1,80}\.(?:jpg|jpeg|png|webp)$/i

/** One of an asset's languages: English, or failing that the first there is. */
function artPath(value: unknown): string | undefined {
  const byLanguage = asNode(value)
  const path = asString(byLanguage?.english) ?? Object.values(byLanguage ?? {}).map(asString)[0]
  return path && ART_PATH.test(path) ? path : undefined
}

/** Where an app's pictures are, as far as its appinfo says. */
export function readArtPaths(appinfo: unknown): SteamArtPaths {
  const common = asNode(asNode(appinfo)?.common) ?? {}
  const full = asNode(common.library_assets_full)
  const image = (name: string): unknown => asNode(asNode(full?.[name])?.image)
  const paths: SteamArtPaths = {
    capsule: artPath(image('library_capsule')),
    header: artPath(common.header_image),
    hero: artPath(image('library_hero'))
  }
  for (const key of Object.keys(paths) as (keyof SteamArtPaths)[]) {
    if (paths[key] === undefined) delete paths[key]
  }
  return paths
}

// The choice of depots is worked out in the window too, so it lives in shared/.
export { defaultDepots, defaultLanguage, depotUnavailable, manifestFor }

/** This computer, as Steam names systems and architectures. */
export function currentSystem(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch
): { os: SteamOs; arch: SteamArch } {
  return steamSystem(platform, arch)
}
