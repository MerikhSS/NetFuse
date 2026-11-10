import type { WorkshopItem, WorkshopQuery, WorkshopSort } from '../../shared/steam'

// A game's Steam Workshop: what NetFuse lists of it, and what it needs to download an item. An
// item is stored the way a game is: its files are in the game's Workshop depot, under a manifest
// of its own (its hcontent_file), so it is fetched, checked and written exactly as a game's depot
// is. Items kept in Steam's old Workshop storage (one file at a file_url) are listed, but can't be
// downloaded. What Steam sends comes from the network: everything is checked here, and anything
// that doesn't fit is left out. Pure, so it can be unit-tested.

/** EPublishedFileQueryType, for each order the tab offers. */
const QUERY_TYPES: Record<WorkshopSort, number> = {
  popular: 3, // RankedByTrend, over TREND_DAYS: what Steam's Workshop calls Most Popular
  subscribed: 9, // RankedByTotalUniqueSubscriptions
  recent: 1, // RankedByPublicationDate
  updated: 21 // RankedByLastUpdatedDate
}
/** RankedByTextSearch: a search is in order of how well each item matches. */
const TEXT_SEARCH = 12
const TREND_DAYS = 7
export const WORKSHOP_PAGE_SIZE = 30
/** Steam's search takes a phrase, not an essay. */
const MAX_SEARCH = 100
const MAX_CURSOR = 256
/** The hosts Steam keeps Workshop pictures on. A picture from anywhere else isn't fetched. */
const PREVIEW_HOSTS = new Set(['images.steamusercontent.com', 'steamuserimages-a.akamaihd.net'])

/** A page of an app's Workshop, as PublishedFile.QueryFiles is asked for it. */
export interface RawWorkshopQuery {
  appId: number
  queryType: number
  searchText?: string
  /** For a trend: the days it counts. */
  days?: number
  /** "*" for the first page. */
  cursor: string
  perPage: number
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** A published file id: a 64-bit number, in decimal, never 0. */
export function isPublishedFileId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[1-9]\d{0,19}$/.test(value) &&
    BigInt(value) <= 0xffff_ffff_ffff_ffffn
  )
}

/** A count or size Steam sends as a number, or as a string when it's 64-bit. */
function count(value: unknown): number | undefined {
  const number = typeof value === 'string' && /^\d{1,16}$/.test(value) ? Number(value) : value
  return Number.isSafeInteger(number) && (number as number) >= 0 ? (number as number) : undefined
}

/** Text as the window shows it: no BBCode tags or runs of white space, and not too long. */
function plain(value: unknown, max: number): string {
  if (typeof value !== 'string') return ''
  const text = value
    .replace(/\[\/?[a-z*][^\]]{0,200}\]/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text
}

/** The query that asks Steam for `query`, checked: the window's word isn't taken for it. */
export function workshopQuery(query: WorkshopQuery): RawWorkshopQuery {
  if (
    !Number.isSafeInteger(query.appId) ||
    query.appId <= 0 ||
    !Object.hasOwn(QUERY_TYPES, query.sort)
  ) {
    throw new Error('Choose what to list again.')
  }
  const search = typeof query.search === 'string' ? query.search.trim().slice(0, MAX_SEARCH) : ''
  const cursor =
    typeof query.cursor === 'string' && query.cursor.length > 0 && query.cursor.length <= MAX_CURSOR
      ? query.cursor
      : '*'
  if (search) {
    return {
      appId: query.appId,
      queryType: TEXT_SEARCH,
      searchText: search,
      cursor,
      perPage: WORKSHOP_PAGE_SIZE
    }
  }
  const queryType = QUERY_TYPES[query.sort]
  return {
    appId: query.appId,
    queryType,
    ...(query.sort === 'popular' ? { days: TREND_DAYS } : {}),
    cursor,
    perPage: WORKSHOP_PAGE_SIZE
  }
}

/** The manifest of an item's files on Steam's content servers, or undefined when it has none
 * there (an item in Steam's old Workshop storage, or one with no files). */
export function workshopManifest(raw: unknown): string | undefined {
  const manifest = isRecord(raw) ? String(raw.hcontent_file ?? '') : ''
  return isPublishedFileId(manifest) ? manifest : undefined
}

/** Where an item's picture is: a URL on Steam's Workshop image server, or, for the end-to-end
 * tests, on `testOrigin`. Anything else is left out. */
export function workshopPreview(raw: unknown, testOrigin?: string): string | undefined {
  const value = isRecord(raw) ? raw.preview_url : undefined
  if (typeof value !== 'string' || value.length > 2048) return undefined
  try {
    const url = new URL(value)
    if (testOrigin && url.origin === new URL(testOrigin).origin) return url.href
    if (url.protocol !== 'https:' || !PREVIEW_HOSTS.has(url.hostname)) return undefined
    if (url.username || url.password || url.port) return undefined
    return url.href
  } catch {
    return undefined
  }
}

/** A published file's details, as Steam sends them, checked: null for anything that isn't a
 * public, unbanned item of `appId`'s Workshop. */
export function readWorkshopItem(raw: unknown, appId: number): WorkshopItem | null {
  if (!isRecord(raw)) return null
  const id = String(raw.publishedfileid ?? '')
  if (!isPublishedFileId(id)) return null
  // EResult: OK, or absent where only good items are listed.
  if (raw.result !== undefined && count(raw.result) !== 1) return null
  if (count(raw.consumer_appid) !== appId) return null
  if (raw.banned === true) return null
  const tags = Array.isArray(raw.tags)
    ? raw.tags
        .map((tag) => (isRecord(tag) ? plain(tag.display_name || tag.tag, 40) : ''))
        .filter(Boolean)
        .slice(0, 12)
    : []
  return {
    publishedFileId: id,
    appId,
    title: plain(raw.title, 200) || `Workshop item ${id}`,
    description: plain(raw.short_description || raw.file_description, 400),
    size: count(raw.file_size) ?? 0,
    updatedAt: count(raw.time_updated) ?? count(raw.time_created) ?? 0,
    subscriptions: count(raw.subscriptions) ?? count(raw.lifetime_subscriptions) ?? 0,
    tags: [...new Set(tags)],
    downloadable: workshopManifest(raw) !== undefined
  }
}
