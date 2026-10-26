import type {
  SteamAppDetails,
  SteamLibraryFolder,
  SteamLoginRequest,
  SteamLoginState,
  SteamOwnedApp,
  SteamPlan,
  SteamPrepareRequest
} from './steam'
import type {
  AppSettings,
  DownloadUpdate,
  FinishedDownload,
  IphoneTetherState,
  NetworkInterfaceInfo,
  StartDownloadRequest,
  UpdateState
} from './types'

/** The request/response half of the IPC surface (every IpcChannels entry except the
 * main->renderer push events, downloadUpdated, networksChanged, iphoneTetherChanged,
 * historyChanged, updateStateChanged, steamLoginStateChanged and steamPrepareProgress) — one source of truth for
 * both netfuseApi (preload) and registerIpcHandlers (main), so a signature drift between the two
 * is a compile error instead of a runtime one. */
export interface IpcContract {
  listInterfaces: { args: []; result: NetworkInterfaceInfo[] }
  deviceBindingSupported: { args: []; result: boolean }
  openNetworkSettings: { args: []; result: void }
  /** On Windows, whether an iPhone is plugged in without being a network (see
   * main/network/iphone.ts). */
  iphoneTether: { args: []; result: IphoneTetherState }
  /** Opens Apple Devices in the Microsoft Store: the app that brings Windows Apple's driver. */
  openAppleDevices: { args: []; result: void }
  updateSettings: { args: [patch: AppSettings]; result: void }
  chooseDestinationFolder: { args: [defaultPath: string]; result: string | null }
  /** Shows a download's folder, by the download's own path. False when nothing is there any
   * more: history is re-sent, with it marked missing. */
  revealDownload: { args: [id: string]; result: boolean }
  /** Opens a download's folder in the file manager. False when it's gone or nothing could open
   * it. */
  openDownload: { args: [id: string]; result: boolean }
  /** Starts the download a plan from steamPrepare describes. */
  startDownload: { args: [request: StartDownloadRequest]; result: string }
  /** Every download, oldest first, each as a snapshot. */
  listDownloads: { args: []; result: DownloadUpdate[] }
  /** Finished downloads, newest first. One is forgotten with removeDownload. */
  listHistory: { args: []; result: FinishedDownload[] }
  /** Forgets every finished download; their files stay. */
  clearHistory: { args: []; result: void }
  /** Bytes each network has received in its selected calendar period, by id (see NetworkPreference.dataLimit). */
  networkUsage: { args: []; result: Record<string, number> }
  resetNetworkUsage: { args: [id: string]; result: void }
  /** Bytes free on the drive holding `dir`; null when it can't be told. */
  freeSpace: { args: [dir: string]; result: number | null }
  pauseDownload: { args: [id: string]; result: void }
  resumeDownload: { args: [id: string]; result: void }
  setDownloadNetwork: { args: [id: string, networkId: string, enabled: boolean]; result: void }
  cancelDownload: { args: [id: string]; result: void }
  /** Removes a download, cancelling one under way. A finished one's folder stays, unless
   * `trashFile`: then it goes to the Trash. */
  removeDownload: { args: [id: string, options?: { trashFile?: boolean }]; result: void }
  updateState: { args: []; result: UpdateState }
  /** The update menu, as a native menu at the pointer. */
  showUpdateMenu: { args: []; result: void }
  /** The Steam login, as the window may know it: never a password, code or token. Asking for it
   * is what first logs in with a remembered login. */
  steamLoginState: { args: []; result: SteamLoginState }
  /** Starts logging in; steamLoginStateChanged says what comes next. */
  steamLogin: { args: [request: SteamLoginRequest]; result: void }
  /** The Steam Guard code the user typed, for the login waiting for one. */
  steamSubmitCode: { args: [code: string]; result: void }
  steamCancelLogin: { args: []; result: void }
  /** Logs out, and forgets a remembered login. */
  steamLogout: { args: []; result: void }
  /** The apps the account owns that can be downloaded. `refresh` asks Steam again. */
  steamOwnedApps: { args: [refresh?: boolean]; result: SteamOwnedApp[] }
  steamAppDetails: { args: [appId: number]; result: SteamAppDetails }
  /** Works out a download (its manifests fetched, an existing folder checked): startDownload
   * takes the plan's id. */
  steamPrepare: { args: [request: SteamPrepareRequest]; result: SteamPlan }
  /** The Steam client's libraries on this computer, with whether `installDir` is in each. Reads
   * local files only. */
  steamLibraryFolders: { args: [installDir?: string]; result: SteamLibraryFolder[] }
  /** The apps the Steam client has installed on this computer. Reads local files only. */
  steamClientApps: { args: []; result: number[] }
}
