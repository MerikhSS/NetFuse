import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import { IpcChannels } from '../shared/ipc-channels'
import type { IpcContract } from '../shared/ipc-contract'
import type {
  SteamLoginRequest,
  SteamLoginState,
  SteamPrepareProgress,
  SteamPrepareRequest
} from '../shared/steam'
import type {
  AppSettings,
  DownloadUpdate,
  InitialState,
  NetworkInterfaceInfo,
  UpdateState
} from '../shared/types'

/** Typed wrapper around ipcRenderer.invoke — the channel name picks its args/result shape out of
 * IpcContract, so a call here that doesn't match what registerIpcHandlers (main) actually handles
 * is a compile error instead of a silent runtime mismatch. */
function invoke<K extends keyof IpcContract>(
  channel: K,
  ...args: IpcContract[K]['args']
): Promise<IpcContract[K]['result']> {
  return ipcRenderer.invoke(IpcChannels[channel], ...args)
}

const netfuseApi = {
  platform: process.platform,
  // Sync on purpose — see InitialState. One small read, once, before the renderer's first paint.
  initialState: ipcRenderer.sendSync(IpcChannels.getInitialState) as InitialState,

  listInterfaces: () => invoke('listInterfaces'),
  deviceBindingSupported: () => invoke('deviceBindingSupported'),
  openNetworkSettings: () => invoke('openNetworkSettings'),
  updateSettings: (patch: AppSettings) => invoke('updateSettings', patch),
  chooseDestinationFolder: (defaultPath: string) => invoke('chooseDestinationFolder', defaultPath),
  revealDownload: (id: string) => invoke('revealDownload', id),
  openDownload: (id: string) => invoke('openDownload', id),
  startDownload: (request: IpcContract['startDownload']['args'][0]) =>
    invoke('startDownload', request),
  listDownloads: () => invoke('listDownloads'),
  listHistory: () => invoke('listHistory'),
  clearHistory: () => invoke('clearHistory'),
  networkUsage: () => invoke('networkUsage'),
  resetNetworkUsage: (id) => invoke('resetNetworkUsage', id),
  freeSpace: (dir: string) => invoke('freeSpace', dir),
  pauseDownload: (downloadId: string) => invoke('pauseDownload', downloadId),
  resumeDownload: (downloadId: string) => invoke('resumeDownload', downloadId),
  setDownloadNetwork: (downloadId: string, networkId: string, enabled: boolean) =>
    invoke('setDownloadNetwork', downloadId, networkId, enabled),
  cancelDownload: (downloadId: string) => invoke('cancelDownload', downloadId),
  removeDownload: (downloadId: string, options?: { trashFile?: boolean }) =>
    invoke('removeDownload', downloadId, options),
  updateState: () => invoke('updateState'),
  showUpdateMenu: () => invoke('showUpdateMenu'),
  steamLoginState: () => invoke('steamLoginState'),
  steamLogin: (request: SteamLoginRequest) => invoke('steamLogin', request),
  steamSubmitCode: (code: string) => invoke('steamSubmitCode', code),
  steamCancelLogin: () => invoke('steamCancelLogin'),
  steamLogout: () => invoke('steamLogout'),
  steamOwnedApps: (refresh?: boolean) => invoke('steamOwnedApps', refresh),
  steamAppDetails: (appId: number) => invoke('steamAppDetails', appId),
  steamPrepare: (request: SteamPrepareRequest) => invoke('steamPrepare', request),
  steamLibraryFolders: (installDir?: string) => invoke('steamLibraryFolders', installDir),
  steamClientApps: () => invoke('steamClientApps'),

  onSteamLoginState: (callback: (state: SteamLoginState) => void): (() => void) => {
    const listener = (_event: IpcRendererEvent, state: SteamLoginState): void => callback(state)
    ipcRenderer.on(IpcChannels.steamLoginStateChanged, listener)
    return () => ipcRenderer.removeListener(IpcChannels.steamLoginStateChanged, listener)
  },

  /** How far steamPrepare has got: manifests fetched, or an existing folder checked. */
  onSteamPrepareProgress: (callback: (progress: SteamPrepareProgress) => void): (() => void) => {
    const listener = (_event: IpcRendererEvent, progress: SteamPrepareProgress): void =>
      callback(progress)
    ipcRenderer.on(IpcChannels.steamPrepareProgress, listener)
    return () => ipcRenderer.removeListener(IpcChannels.steamPrepareProgress, listener)
  },

  onDownloadUpdated: (callback: (update: DownloadUpdate) => void): (() => void) => {
    const listener = (_event: IpcRendererEvent, update: DownloadUpdate): void => callback(update)
    ipcRenderer.on(IpcChannels.downloadUpdated, listener)
    return () => ipcRenderer.removeListener(IpcChannels.downloadUpdated, listener)
  },

  /** A download was added to the finished ones or forgotten: listHistory() has them. */
  onHistoryChanged: (callback: () => void): (() => void) => {
    const listener = (): void => callback()
    ipcRenderer.on(IpcChannels.historyChanged, listener)
    return () => ipcRenderer.removeListener(IpcChannels.historyChanged, listener)
  },

  onUpdateState: (callback: (state: UpdateState) => void): (() => void) => {
    const listener = (_event: IpcRendererEvent, state: UpdateState): void => callback(state)
    ipcRenderer.on(IpcChannels.updateStateChanged, listener)
    return () => ipcRenderer.removeListener(IpcChannels.updateStateChanged, listener)
  },

  onNetworksChanged: (callback: (networks: NetworkInterfaceInfo[]) => void): (() => void) => {
    const listener = (_event: IpcRendererEvent, networks: NetworkInterfaceInfo[]): void =>
      callback(networks)
    ipcRenderer.on(IpcChannels.networksChanged, listener)
    return () => ipcRenderer.removeListener(IpcChannels.networksChanged, listener)
  }
}

export type NetFuseApi = typeof netfuseApi

// Nothing in the renderer needs raw Electron/Node access — only the typed netfuseApi above is
// exposed. The @electron-toolkit/preload electronAPI (which hands the renderer an unrestricted
// ipcRenderer.invoke/send/on on any channel) is deliberately not bridged.
if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('netfuse', netfuseApi)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore (define in dts)
  window.netfuse = netfuseApi
}
