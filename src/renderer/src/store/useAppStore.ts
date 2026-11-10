import { applyDownloadUpdate } from '@shared/downloadUpdate'
import { describeError } from '@shared/errors'
import type {
  SteamLoginState,
  SteamOwnedApp,
  WorkshopGame,
  WorkshopGamesPage,
  WorkshopItem,
  WorkshopPage,
  WorkshopSort
} from '@shared/steam'
import type {
  AppSettings,
  DownloadSchedule,
  DownloadState,
  DownloadUpdate,
  FinishedDownload,
  NetworkInterfaceInfo,
  NetworkPreference,
  NetworkPreferences,
  SpeedUnit,
  ThemeSource
} from '@shared/types'
import { create } from 'zustand'

export type DownloadFilter = 'all' | 'progress' | 'finished' | 'failed'

type LoadStatus = 'idle' | 'loading' | 'ready' | 'error'

/** What the window shows: a launcher's library (Steam's, so far), one game, the Workshop (the
 * game chosen in it, or the games to choose from) and one of its items, the list of downloads, or
 * one download. */
export type View =
  | { name: 'library' }
  | { name: 'game'; appId: number }
  | { name: 'workshop' }
  | { name: 'workshop-item'; item: WorkshopItem }
  | { name: 'downloads' }
  | { name: 'download'; id: string }

/** The games the account owns, as Steam last listed them. */
export type LibraryLoad =
  | { status: 'idle' | 'loading' }
  | { status: 'ready'; apps: SteamOwnedApp[] }
  | { status: 'error'; message: string }

export type LibraryFilter = 'all' | 'installed' | 'not-installed'

/** What the Workshop lists: a game's items, in one of Steam's orders or matching a search. */
export interface WorkshopBrowse {
  /** null until a game is chosen. */
  appId: number | null
  /** The game's name, when it isn't in the library to look it up by. */
  name?: string
  sort: WorkshopSort
  search: string
}

/** The games whose Workshops can be had through Steam's anonymous account (and the account's
 * own), from Steam's store, page after page: for the Workshop's switch. */
export interface WorkshopGamesList {
  /** The search they were asked for: an answer for another one, come late, is dropped. */
  of: string
  status: 'loading' | 'ready' | 'error'
  games: WorkshopGame[]
  /** Where the store's next page starts; absent after the last. */
  nextStart?: number
  error?: string
}

/** The items listed so far for one WorkshopBrowse, page after page. */
export interface WorkshopList {
  /** The browse they were asked for: an answer for another one, come late, is dropped. */
  of: WorkshopBrowse
  status: 'loading' | 'ready' | 'error'
  items: WorkshopItem[]
  total: number
  /** Where Steam's next page starts; absent on the last. */
  nextCursor?: string
  error?: string
}

/** Which of the library's apps are listed: games (demos and betas too), tools (Steam's tools and
 * software), or both. */
export type LibraryKind = 'games' | 'tools' | 'all'

interface AppStore {
  interfaces: NetworkInterfaceInfo[]
  interfacesStatus: LoadStatus
  interfacesError: string | null
  /** User customizations (name/color) per network interface id — persisted in the main process. */
  networkPreferences: NetworkPreferences

  /** Persisted in the main process alongside nativeTheme.themeSource. */
  themeSource: ThemeSource

  homeDir: string
  downloadsDir: string

  /** Every download that isn't finished, by id — running, queued, paused or failed. */
  downloads: Record<string, DownloadState>
  /** Finished downloads, newest first (see main/download/history.ts). */
  history: FinishedDownload[]
  view: View
  downloadFilter: DownloadFilter
  setDownloadFilter: (filter: DownloadFilter) => void
  downloadSchedule: DownloadSchedule | undefined
  /** The Steam login as main last said; null until the window has asked. */
  steamLogin: SteamLoginState | null
  library: LibraryLoad
  /** What the library's search and filter are set to, kept while the window shows other things. */
  libraryQuery: string
  libraryFilter: LibraryFilter
  libraryKind: LibraryKind
  /** The apps the Steam client itself has installed on this computer. */
  clientApps: number[]
  /** The Workshop's game, order and search, kept while the window shows other things, and what
   * it has listed. */
  workshop: WorkshopBrowse
  workshopList: WorkshopList | null
  /** Persisted — the Workshop also lists games the account doesn't own, whose Workshops Steam lets
   * its anonymous account have. */
  workshopAnonymous: boolean
  workshopGames: WorkshopGamesList | null
  /** Persisted — how many downloads run at once; the rest wait in the queue. */
  downloadsAtOnce: number
  /** Persisted — the speed limits (see AppSettings). */
  speedLimit: number | undefined
  slowMode: boolean
  slowModeSpeed: number
  /** Persisted — MB/s or Mbps, for every speed shown. */
  speedUnit: SpeedUnit

  /** Persisted — the games folder last picked, falling back to downloadsDir. */
  destinationDir: string

  /** Asks the main process for the network list now; it also pushes every change. */
  loadInterfaces: () => Promise<void>
  receiveInterfaces: (interfaces: NetworkInterfaceInfo[]) => void
  setNetworkPreference: (id: string, patch: NetworkPreference) => void
  setThemeSource: (source: ThemeSource) => void
  /** A snapshot or an update of a download, from the main process. */
  receiveDownloadUpdate: (update: DownloadUpdate) => void
  /** Finished downloads as main lists them; any that finished leave `downloads`. */
  receiveHistory: (history: FinishedDownload[]) => void
  /** Drops a download from the window's view once the main process has removed it. */
  forgetDownload: (id: string) => void
  setView: (view: View) => void
  /** Opens a game's own page. */
  openGame: (appId: number) => void
  /** Opens the Workshop: a game's, with `browse` (its search, say) when given. */
  openWorkshop: (browse?: Partial<WorkshopBrowse>) => void
  /** Changes what the Workshop lists, and lists its first page. */
  browseWorkshop: (browse: Partial<WorkshopBrowse>) => void
  /** Lists the Workshop's first page, unless it's listed already; `more` lists the next. */
  loadWorkshop: (more?: boolean) => Promise<void>
  setWorkshopAnonymous: (on: boolean) => void
  /** Lists the store's games for `search`, unless they're listed already; `more`, the next page. */
  loadWorkshopGames: (search: string, more?: boolean) => Promise<void>
  receiveSteamLogin: (state: SteamLoginState) => void
  /** Lists the library, once; `refresh` asks Steam again. */
  loadLibrary: (refresh?: boolean) => Promise<void>
  setLibraryQuery: (query: string) => void
  setLibraryFilter: (filter: LibraryFilter) => void
  setLibraryKind: (kind: LibraryKind) => void
  loadClientApps: () => Promise<void>
  setDownloadsAtOnce: (count: number) => void
  /** Each one applies at once, to every download (see main/network/limits.ts). */
  setSpeedLimit: (bytesPerSec: number | undefined) => void
  setSlowMode: (on: boolean) => void
  setSlowModeSpeed: (bytesPerSec: number) => void
  setSpeedUnit: (unit: SpeedUnit) => void
  setDestinationDir: (dir: string) => void
}

const sameBrowse = (a: WorkshopBrowse | undefined, b: WorkshopBrowse): boolean =>
  a !== undefined && a.appId === b.appId && a.sort === b.sort && a.search.trim() === b.search.trim()

// Settings saved by the main process, read once before the first paint (see InitialState).
const initial = window.netfuse.initialState

/** The Workshop switch's last save: main reads the saved setting before listing the store's games,
 * so they're asked for only once it's written. */
let workshopAnonymousSaved: Promise<void> = Promise.resolve()

/** Every setting changes optimistically: the store is updated first so the UI feels instant,
 * then this saves it. The store stays the source of truth either way — a failed save just means
 * the change isn't remembered next launch. */
function persist(patch: AppSettings): void {
  window.netfuse.updateSettings(patch).catch(() => {})
}

export const useAppStore = create<AppStore>((set, get) => ({
  interfaces: [],
  interfacesStatus: 'idle',
  interfacesError: null,
  networkPreferences: initial.networkPreferences,
  themeSource: initial.themeSource,

  homeDir: initial.homeDir,
  downloadsDir: initial.downloadsDir,

  downloads: {},
  history: [],
  view: { name: 'library' },
  downloadFilter: 'all',
  setDownloadFilter: (downloadFilter) => set({ downloadFilter }),
  downloadSchedule: initial.downloadSchedule,
  steamLogin: null,
  library: { status: 'idle' },
  libraryQuery: '',
  libraryFilter: 'all',
  libraryKind: 'games',
  clientApps: [],
  workshop: { appId: null, sort: 'popular', search: '' },
  workshopList: null,
  workshopAnonymous: initial.workshopAnonymous,
  workshopGames: null,
  downloadsAtOnce: initial.downloadsAtOnce,
  speedLimit: initial.speedLimit,
  slowMode: initial.slowMode,
  slowModeSpeed: initial.slowModeSpeed,
  speedUnit: initial.speedUnit,

  destinationDir: initial.destinationDir ?? initial.downloadsDir,

  loadInterfaces: async () => {
    // A re-scan keeps showing the last result rather than flashing back to 'loading'.
    if (get().interfacesStatus !== 'ready') set({ interfacesStatus: 'loading' })
    set({ interfacesError: null })
    try {
      get().receiveInterfaces(await window.netfuse.listInterfaces())
    } catch (error) {
      set({
        interfacesStatus: 'error',
        interfacesError: error instanceof Error ? error.message : String(error)
      })
    }
  },

  receiveInterfaces: (interfaces) =>
    set({ interfaces, interfacesStatus: 'ready', interfacesError: null }),

  // An explicit `undefined` in `patch` clears that field; main drops an entry left with neither.
  setNetworkPreference: (id, patch) => {
    const networkPreferences = {
      ...get().networkPreferences,
      [id]: { ...get().networkPreferences[id], ...patch }
    }
    set({ networkPreferences })
    persist({ networkPreferences })
  },

  setThemeSource: (themeSource) => {
    set({ themeSource })
    persist({ themeSource })
  },

  receiveDownloadUpdate: (update) => {
    const { downloads, history } = get()
    // Finished already: an update that arrives late mustn't bring it back.
    if (history.some((entry) => entry.id === update.state.id)) return
    const previous = downloads[update.state.id] ?? null
    const download = applyDownloadUpdate(previous, update)
    if (!download || download === previous) return
    set({ downloads: { ...downloads, [download.id]: download } })
  },

  receiveHistory: (history) => {
    const downloads = { ...get().downloads }
    for (const entry of history) delete downloads[entry.id]
    set({ history, downloads })
  },

  forgetDownload: (id) => {
    const { [id]: removed, ...downloads } = get().downloads
    void removed
    set({ downloads, history: get().history.filter((entry) => entry.id !== id) })
  },

  setView: (view) => set({ view }),

  openGame: (appId) => set({ view: { name: 'game', appId } }),

  openWorkshop: (browse) => {
    set({ view: { name: 'workshop' } })
    if (browse) get().browseWorkshop(browse)
  },

  browseWorkshop: (browse) => {
    const workshop = { ...get().workshop, ...browse }
    // Another game's Workshop isn't searched for what the last one was.
    if (browse.appId !== undefined && browse.appId !== get().workshop.appId) {
      workshop.search = browse.search ?? ''
      workshop.name = browse.name
    }
    set({ workshop })
    // A new game or order starts from its first page; the same one keeps what's listed.
    if (!sameBrowse(get().workshopList?.of, workshop)) void get().loadWorkshop()
  },

  loadWorkshop: async (more = false) => {
    const { workshop, workshopList } = get()
    if (workshop.appId === null) return
    const listed = sameBrowse(workshopList?.of, workshop) ? workshopList : null
    if (more) {
      if (!listed?.nextCursor || listed.status === 'loading') return
    } else if (listed && listed.status !== 'error') return
    const cursor = more ? listed?.nextCursor : undefined
    const before = more && listed ? listed.items : []
    const loading: WorkshopList = {
      of: workshop,
      status: 'loading',
      items: before,
      total: listed?.total ?? 0,
      nextCursor: listed?.nextCursor
    }
    set({ workshopList: loading })
    let page: WorkshopPage
    try {
      page = await window.netfuse.steamWorkshop({
        appId: workshop.appId,
        sort: workshop.sort,
        search: workshop.search.trim() || undefined,
        cursor
      })
    } catch (error) {
      if (get().workshopList === loading) {
        set({ workshopList: { ...loading, status: 'error', error: describeError(error) } })
      }
      return
    }
    if (get().workshopList !== loading) return
    // A page can repeat an item the one before had, when the order shifted in between.
    const seen = new Set(before.map((item) => item.publishedFileId))
    set({
      workshopList: {
        of: workshop,
        status: 'ready',
        items: [...before, ...page.items.filter((item) => !seen.has(item.publishedFileId))],
        total: page.total,
        nextCursor: page.nextCursor
      }
    })
  },

  receiveSteamLogin: (steamLogin) => {
    const was = get().steamLogin
    set({ steamLogin })
    // Another account owns other things: back to a library to be listed afresh.
    if (was?.status === 'logged-in' && steamLogin.status !== 'logged-in') {
      set({
        library: { status: 'idle' },
        view: { name: 'library' },
        workshop: { appId: null, sort: 'popular', search: '' },
        workshopList: null,
        workshopGames: null
      })
    }
  },

  loadLibrary: async (refresh = false) => {
    const { library } = get()
    if (!refresh && library.status !== 'idle' && library.status !== 'error') return
    set({ library: { status: 'loading' } })
    try {
      const apps = await window.netfuse.steamOwnedApps(refresh)
      set({ library: { status: 'ready', apps } })
    } catch (error) {
      set({ library: { status: 'error', message: describeError(error) } })
    }
  },

  setWorkshopAnonymous: (workshopAnonymous) => {
    set({ workshopAnonymous })
    workshopAnonymousSaved = window.netfuse.updateSettings({ workshopAnonymous }).catch(() => {})
  },

  loadWorkshopGames: async (search, more = false) => {
    const of = search.trim()
    const listed = get().workshopGames?.of === of ? get().workshopGames : null
    if (more) {
      if (listed?.nextStart === undefined || listed.status === 'loading') return
    } else if (listed && listed.status !== 'error') return
    const before = more && listed ? listed.games : []
    const loading: WorkshopGamesList = {
      of,
      status: 'loading',
      games: before,
      nextStart: listed?.nextStart
    }
    set({ workshopGames: loading })
    let page: WorkshopGamesPage
    try {
      await workshopAnonymousSaved
      page = await window.netfuse.steamWorkshopGames({
        search: of || undefined,
        start: more ? listed?.nextStart : undefined
      })
    } catch (error) {
      if (get().workshopGames === loading) {
        set({ workshopGames: { ...loading, status: 'error', error: describeError(error) } })
      }
      return
    }
    if (get().workshopGames !== loading) return
    const seen = new Set(before.map((game) => game.appId))
    set({
      workshopGames: {
        of,
        status: 'ready',
        games: [...before, ...page.games.filter((game) => !seen.has(game.appId))],
        nextStart: page.nextStart
      }
    })
  },

  setLibraryQuery: (libraryQuery) => set({ libraryQuery }),
  setLibraryFilter: (libraryFilter) => set({ libraryFilter }),
  setLibraryKind: (libraryKind) => set({ libraryKind }),

  loadClientApps: async () => {
    const clientApps = await window.netfuse.steamClientApps().catch(() => [])
    set({ clientApps })
  },

  setDownloadsAtOnce: (downloadsAtOnce) => {
    set({ downloadsAtOnce })
    persist({ downloadsAtOnce })
  },

  setSpeedLimit: (speedLimit) => {
    set({ speedLimit })
    persist({ speedLimit })
  },

  setSlowMode: (slowMode) => {
    set({ slowMode })
    persist({ slowMode })
  },

  setSlowModeSpeed: (slowModeSpeed) => {
    set({ slowModeSpeed })
    persist({ slowModeSpeed })
  },

  setSpeedUnit: (speedUnit) => {
    set({ speedUnit })
    persist({ speedUnit })
  },

  setDestinationDir: (destinationDir) => {
    set({ destinationDir })
    persist({ destinationDir })
  }
}))
