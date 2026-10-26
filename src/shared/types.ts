export type NetworkInterfaceKind = 'wifi' | 'usb' | 'ethernet' | 'bridge' | 'other'
export type IpFamily = 4 | 6

export interface NetworkAddress {
  address: string
  family: IpFamily
  netmask?: string
  /** Used by the existing IPv4 same-subnet warning. */
  subnet?: string
}

export type ThemeSource = 'light' | 'dark'

export interface NetworkInterfaceInfo {
  /** Stable identifier for this interface (currently the OS device name, e.g. "en0"). */
  id: string
  device: string
  displayName: string
  addresses: NetworkAddress[]
  kind: NetworkInterfaceKind
  mac?: string
}

/** On Windows, an iPhone plugged in that isn't one of the networks: `driverInstalled` says
 * whether Apple's driver is there already, leaving only the phone's settings. */
export type IphoneTetherState =
  { status: 'none' } | { status: 'not-tethered'; driverInstalled: boolean }

/** `queued`: waiting for one of the downloads running at once to end (see
 * AppSettings.downloadsAtOnce). */
export type DownloadStatus =
  'queued' | 'downloading' | 'paused' | 'completed' | 'error' | 'cancelled'

/** A stream's state. `pending` means it is waiting for work: it holds no chunk, either because
 * none is free for it right now or because it hasn't started. `downloading` always means it is
 * fetching one. A stream that fails for good leaves the list; what went wrong is its network's to
 * report (see DownloadNetwork). */
export type StreamStatus =
  'pending' | 'downloading' | 'retrying' | 'paused' | 'completed' | 'cancelled'

export type CellStatus = 'pending' | 'downloading' | 'completed'

interface WorkUnitState {
  index: number
  rangeStart: number
  rangeEnd: number | null
  /** The network that delivered most of it, drawn as its color. */
  interfaceId?: string
  bytesDownloaded: number
  /** Bytes of it delivered by each network, keyed by interface id, summing to `bytesDownloaded`. */
  bytesByInterface: Record<string, number>
}

/** A Steam download's grid square: a run of its depot chunks, about equal in download bytes. A
 * game has tens of thousands of chunks, too many to draw (or send) one by one. Its range is in
 * download bytes, the chunks' compressed sizes laid end to end, not in any one file. */
export interface SteamCellState extends WorkUnitState {
  kind: 'steam'
  status: CellStatus
}

/** A download's grid square, whichever launcher it is from. */
export type DownloadUnitState = SteamCellState

/**
 * - on: in use.
 * - off: the user switched it off. A network that turns up mid-download starts off.
 * - offline: not connected to this computer. It's used again as soon as it is.
 * - unreachable: connected, but the servers can't be reached through it. One connection keeps
 *   trying, and the rest follow once it gets through.
 * - failed: the servers kept refusing requests over it (`error` says how). Switching it off and
 *   on, reconnecting it, or resuming tries again.
 * - limit: it has used up its data for the chosen period (NetworkPreference.dataLimit). It's used again
 *   once the period ends or the limit is raised.
 */
export type NetworkStatus = 'on' | 'off' | 'offline' | 'unreachable' | 'failed' | 'limit'

/** A network as one download sees it: whether the user has it on, and how it is doing. */
interface DownloadNetworkBase {
  /** A NetworkInterfaceInfo id. */
  id: string
  /** Its name and kind as the OS last reported them. */
  label: string
  kind: NetworkInterfaceKind
  /** The user's choice; `status` is what came of it. */
  enabled: boolean
  status: NetworkStatus
  error?: string
  /** Bytes it delivered. */
  bytesDownloaded: number
  speedBytesPerSec: number
  /** Requests over it that failed and were tried again. */
  retries: number
}

export interface SteamDownloadNetwork extends DownloadNetworkBase {
  transfer: 'steam'
}

export type DownloadNetwork = SteamDownloadNetwork

interface DownloadStateBase {
  id: string
  /** Where it comes from, as a link (steam://app/<id>): what tells two downloads of one game. */
  url: string
  fileName: string
  destinationPath: string
  totalBytes: number
  bytesDownloaded: number
  speedBytesPerSec: number
  /** Seconds left at this speed, smoothed (see updateTimeLeft); unset when there's no telling:
   * the size unknown, or nothing moving. */
  timeLeftSeconds?: number
  status: DownloadStatus
  error?: string
  /** For an error: whether resuming can pick up where it stopped. False when the progress was
   * thrown away. */
  resumable?: boolean
  startedAt: number
  /** Enrolled in the scheduled queue; survives relaunches until manually paused. */
  scheduled?: boolean
  /** While queued: its place in the queue, lowest first. */
  queuedAt?: number
  pausedAt?: number
  totalPausedMs?: number
  completedAt?: number
  /** Each network's speed, by network id, sampled once a second over the last minute it ran.
   * Every series is as long as the others, so they line up in time. */
  speedHistory?: Record<string, number[]>
  /** The best combined speed held for a few seconds, so it only ever rises; unset until it has
   * run that long. A download done sooner gets the best speed it showed. */
  peakSpeedBytesPerSec?: number
  /** The update this state is as of (see DownloadUpdate). */
  seq?: number
}

/** One connection to a Steam content server, through one network, fetching whole depot chunks.
 * Streams come and go as the download runs; what a network has done is kept on its network. */
export interface SteamStreamState {
  id: number
  interfaceId: string
  /** The content server it asks. */
  host: string
  status: StreamStatus
  /** Chunk bytes it delivered that were new: a lost race isn't counted. */
  bytesDownloaded: number
  speedBytesPerSec: number
  /** The grid cell of the chunk it is fetching; unset whenever it holds none. */
  currentCellIndex?: number
  /** How far it has got with that chunk, and the chunk's size. */
  chunkReceived?: number
  chunkBytes?: number
  /** Racing another stream for the chunk near the end, because that one is slow (see
   * steam/scheduler.ts). Whichever finishes first wins. */
  hedge?: boolean
}

/** A game (or any app) installed from Steam: its chosen depots' files, in a folder of its own.
 * Sizes count download bytes (what content servers send, compressed and encrypted); the install
 * is `installBytes` on disk. */
export interface SteamDownloadState extends DownloadStateBase {
  kind: 'steam'
  networks: SteamDownloadNetwork[]
  streams: SteamStreamState[]
  peakStreams: number
  cells: SteamCellState[]
  totalCells: number
  totalChunks: number
  chunksDone: number
  app: { appId: number; name: string; branch: string; buildId?: string }
  depots: { depotId: number; manifestId: string; name: string }[]
  fileCount: number
  installBytes: number
  /** Installed into a folder that already existed: removing it never trashes the folder, and
   * cancelling only removes what this download created. */
  adopted?: boolean
  /** What a run is doing before its chunks come in: making the install's files and folders. */
  phase?: 'preparing'
  /** The disk can't keep up: most streams are waiting for their writes (see concurrency.ts). */
  diskLimited?: boolean
}

/** A download, whichever launcher it is from: only Steam so far. */
export type DownloadState = SteamDownloadState

/** A finished download as history keeps it: its state without the work units and connections,
 * which only a running download needs. */
export type FinishedDownload = Omit<SteamDownloadState, 'cells' | 'streams'> & {
  /** The chunks it was written in. */
  unitsWritten: number
  /** Set when listed: its folder is no longer where it was saved. */
  missing?: boolean
}

/** What the main process sends as a download changes: everything but its cells, and only the
 * cells that changed since it last sent, at most every 200 ms. A snapshot is the same with every
 * cell in it. */
export interface SteamDownloadUpdate {
  seq: number
  state: Omit<SteamDownloadState, 'cells'>
  cells: SteamCellState[]
}

export type DownloadUpdate = SteamDownloadUpdate

/** User customization for one physical network, keyed by NetworkInterfaceInfo.id — lets a
 * cryptic OS device name (e.g. "feth0") get a real label, and a color distinct from its
 * kind's default. Persisted in the main process, independent of any single download. */
export type DataLimitPeriod = 'day' | 'week' | 'month'

export interface NetworkPreference {
  customName?: string
  /** One of the app's curated swatch ids (see NETWORK_COLOR_SWATCHES) — not a raw hex, so every
   * swatch is guaranteed to have a legible on-solid text color already picked out for it. */
  colorId?: string
  /** Left out of the last download started, so the next one starts without it too (the last
   * pick is remembered, like the folder). A click puts it back. */
  off?: boolean
  /** Bytes a second all downloads together may take over it. */
  speedLimit?: number
  /** Bytes NetFuse may receive in the chosen calendar period. */
  dataLimit?: number
  /** Defaults to month for existing settings. Weeks start Monday in local time. */
  dataLimitPeriod?: DataLimitPeriod
}

export type NetworkPreferences = Record<string, NetworkPreference>

/** Where the app's own update is (see main/updater.ts). `version` is the update's, once one is
 * found; `percent` only means something while downloading. */
export interface UpdateState {
  status: 'idle' | 'checking' | 'available' | 'downloading' | 'ready' | 'error'
  autoUpdate: boolean
  version?: string
  percent?: number
}

/** A repeating window for all transfers, interpreted in the computer's local timezone. */
export interface DownloadSchedule {
  enabled: boolean
  /** Minutes since local midnight. Equal start/stop times are invalid. */
  startMinute: number
  endMinute: number
  /** Days on which a window starts, Sunday = 0. */
  days: number[]
  /** Last local date on which a window may start (YYYY-MM-DD). */
  endDate?: string
}

/** What app-settings.json holds, and what the renderer sends to change it (merged over the saved
 * values, `undefined` clearing one). A missing field was never set. */
export interface AppSettings {
  downloadSchedule?: DownloadSchedule
  themeSource?: ThemeSource
  /** Only ever saved as false: updates download on their own unless turned off. */
  autoUpdate?: boolean
  /** The folder games were last saved to: a Steam library's steamapps/common, often. */
  destinationDir?: string
  /** User customizations (name/color) per network interface id. */
  networkPreferences?: NetworkPreferences
  /** How many downloads run at once; the rest wait in the queue. */
  downloadsAtOnce?: number
  /** Bytes a second every download together may take, over every network; unset: no limit. */
  speedLimit?: number
  /** While on, slowModeSpeed stands in for speedLimit: a one-click lower limit for calls. */
  slowMode?: boolean
  slowModeSpeed?: number
  /** How speeds are shown everywhere; sizes stay in bytes either way. */
  speedUnit?: SpeedUnit
  /** Only ever saved as false, by "Never show again": the popup about an iPhone plugged into
   * Windows that isn't a network (see main/network/iphone.ts) shows unless turned off. */
  iphoneTetherPopup?: boolean
}

/** bytes: MB/s. bits: Mbps, as internet plans and speed tests count them. */
export type SpeedUnit = 'bytes' | 'bits'

export const DOWNLOADS_AT_ONCE = { default: 2, min: 1, max: 4 }
/** Seconds of speed history a download keeps (a sample a second), and so the span the throughput
 * chart always shows. */
export const SPEED_HISTORY_SECONDS = 60
export const DEFAULT_SLOW_MODE_SPEED = 2 * 1024 ** 2

/** Everything the renderer needs for its first paint, read synchronously by the preload so no
 * saved value flashes in over a default a moment after launch. */
export interface InitialState {
  downloadSchedule?: DownloadSchedule
  homeDir: string
  downloadsDir: string
  themeSource: ThemeSource
  networkPreferences: NetworkPreferences
  downloadsAtOnce: number
  speedLimit?: number
  slowMode: boolean
  slowModeSpeed: number
  speedUnit: SpeedUnit
  /** The last folder picked, if it still exists — otherwise the renderer uses downloadsDir. */
  destinationDir?: string
}

/** A Steam download worked out by steamPrepare (see SteamPlan). */
export interface StartSteamDownloadRequest {
  kind: 'steam'
  planId: string
  /** The networks to start on. Every other one starts switched off. */
  interfaceIds: string[]
  /** Streams per network the user picked; left out, the count is decided automatically. */
  streamsPerNetwork?: number
}

/** What a Steam download saves to be resumed: what it installs, from what, and where. Never a
 * key or token; those are asked of Steam again each run. */
export interface SteamRequestPayload {
  kind: 'steam'
  appId: number
  branch: string
  /** In the order they are installed: a later depot's copy of a file wins. */
  depots: { depotId: number; manifestId: string }[]
  /** The folder the install folder is in. */
  destinationDir: string
  interfaceIds: string[]
  streamsPerNetwork?: number
}

export type StartDownloadRequest = StartSteamDownloadRequest
