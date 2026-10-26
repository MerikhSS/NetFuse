import { applyDownloadUpdate } from '@shared/downloadUpdate'
import { describeError } from '@shared/errors'
import type { SteamLoginState, SteamOwnedApp } from '@shared/steam'
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

/** What the window shows: a launcher's library (Steam's, so far), one game, the list of
 * downloads, or one download. */
export type View =
  | { name: 'library' }
  | { name: 'game'; appId: number }
  | { name: 'downloads' }
  | { name: 'download'; id: string }

/** The games the account owns, as Steam last listed them. */
export type LibraryLoad =
  | { status: 'idle' | 'loading' }
  | { status: 'ready'; apps: SteamOwnedApp[] }
  | { status: 'error'; message: string }

export type LibraryFilter = 'all' | 'installed' | 'not-installed'

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

// Settings saved by the main process, read once before the first paint (see InitialState).
const initial = window.netfuse.initialState

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

  receiveSteamLogin: (steamLogin) => {
    const was = get().steamLogin
    set({ steamLogin })
    // Another account owns other things: back to a library to be listed afresh.
    if (was?.status === 'logged-in' && steamLogin.status !== 'logged-in') {
      set({ library: { status: 'idle' }, view: { name: 'library' } })
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
