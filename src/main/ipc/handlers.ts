import { stat, statfs } from 'node:fs/promises'
import {
  dialog,
  ipcMain,
  nativeTheme,
  powerMonitor,
  shell,
  type BrowserWindow,
  type IpcMainInvokeEvent
} from 'electron'
import { IpcChannels } from '../../shared/ipc-channels'
import type { IpcContract } from '../../shared/ipc-contract'
import {
  DEFAULT_SLOW_MODE_SPEED,
  DOWNLOADS_AT_ONCE,
  type InitialState,
  type ThemeSource
} from '../../shared/types'
import type { SteamLoginRequest, SteamPrepareRequest } from '../../shared/steam'
import type { StartSteamDownloadRequest } from '../../shared/types'
import { DownloadManager } from '../download/downloadManager'
import { MAX_STREAMS_PER_NETWORK } from '../download/plan'
import { canRemember } from '../steam/account'
import { redactedMessage } from '../steam/redact'
import { clientInstalledApps, findLibraryFolders } from '../steam/steamFolders'
import { getDefaultDownloadsDir, getHomeDir } from '../download/paths'
import { listHistory } from '../download/history'
import { deviceBindingSupported } from '../network/deviceBinding'
import { NetworkMonitor } from '../network/interfaces'
import { IphoneWatch } from '../network/iphoneWatch'
import { loadSettings, saveSettings } from '../settings'
import { showUpdateMenu, updateState } from '../updater'

async function openNetworkSettings(): Promise<void> {
  if (process.platform === 'win32') {
    await shell.openExternal('ms-settings:network-status')
  } else if (process.platform === 'darwin') {
    await shell.openExternal('x-apple.systempreferences:com.apple.preference.network')
  } else if (process.platform === 'linux') {
    try {
      const { exec } = await import('node:child_process')
      exec('gnome-control-center network || nm-connection-editor || true')
    } catch {
      // Best-effort
    }
  }
}

/** Apple Devices in the Microsoft Store, Apple's app that brings Windows the driver an iPhone's
 * tethering needs. The store link opens the Store app; the web page is for a Windows without one. */
const APPLE_DEVICES_STORE = 'ms-windows-store://pdp/?ProductId=9NP83LWLPZ9K'
const APPLE_DEVICES_WEB = 'https://apps.microsoft.com/detail/9NP83LWLPZ9K'

async function openAppleDevices(): Promise<void> {
  try {
    await shell.openExternal(APPLE_DEVICES_STORE)
  } catch {
    await shell.openExternal(APPLE_DEVICES_WEB)
  }
}

/** Typed wrapper around ipcMain.handle — the channel name picks its args/result shape out of
 * IpcContract, so a handler here that doesn't match what netfuseApi (preload) actually calls is a
 * compile error instead of a silent runtime mismatch. */
function handle<K extends keyof IpcContract>(
  channel: K,
  listener: (
    event: IpcMainInvokeEvent,
    ...args: IpcContract[K]['args']
  ) => IpcContract[K]['result'] | Promise<IpcContract[K]['result']>
): void {
  ipcMain.handle(
    IpcChannels[channel],
    listener as (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown
  )
}

const DESTINATION_CHECK_MS = 300

// The window's Steam requests, checked here as they arrive: the types say what the window means
// to send, not what reaches this process.

const isText = (value: unknown, max: number): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= max

const isId = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) > 0

function checkLoginRequest(value: unknown): SteamLoginRequest {
  const request = value as Partial<
    Record<keyof SteamLoginRequest | 'accountName' | 'password', unknown>
  > | null
  if (typeof request?.remember === 'boolean') {
    if (request.method === 'qr') return { method: 'qr', remember: request.remember }
    if (
      request.method === 'credentials' &&
      isText(request.accountName, 64) &&
      isText(request.password, 256)
    ) {
      return {
        method: 'credentials',
        accountName: request.accountName,
        password: request.password,
        remember: request.remember
      }
    }
  }
  throw new Error('Enter your Steam account name and password.')
}

function checkPrepareRequest(value: unknown): SteamPrepareRequest {
  const request = value as Partial<Record<keyof SteamPrepareRequest, unknown>> | null
  if (
    isId(request?.appId) &&
    isText(request.branch, 128) &&
    Array.isArray(request.depotIds) &&
    request.depotIds.every(isId) &&
    isText(request.destinationDir, 4096) &&
    typeof request.adopt === 'boolean'
  ) {
    return {
      appId: request.appId,
      branch: request.branch,
      depotIds: request.depotIds,
      destinationDir: request.destinationDir,
      adopt: request.adopt
    }
  }
  throw new Error('Choose what to download again.')
}

function checkSteamStart(value: unknown): StartSteamDownloadRequest {
  const { kind, planId, interfaceIds, streamsPerNetwork } = (value ?? {}) as Partial<
    Record<keyof StartSteamDownloadRequest, unknown>
  >
  if (
    kind === 'steam' &&
    isText(planId, 64) &&
    Array.isArray(interfaceIds) &&
    interfaceIds.length <= 64 &&
    interfaceIds.every((id) => isText(id, 256)) &&
    (streamsPerNetwork === undefined ||
      (Number.isInteger(streamsPerNetwork) &&
        (streamsPerNetwork as number) >= 1 &&
        (streamsPerNetwork as number) <= MAX_STREAMS_PER_NETWORK))
  ) {
    return {
      kind: 'steam',
      planId,
      interfaceIds,
      streamsPerNetwork: streamsPerNetwork as number | undefined
    }
  }
  throw new Error('Choose what to download again.')
}

/** Steam's errors and the libraries' can carry a token or a request code: never passed on as
 * they are. */
async function redacting<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work()
  } catch (error) {
    throw new Error(redactedMessage(error))
  }
}

async function freeSpace(dir: string): Promise<number | null> {
  try {
    const stats = await statfs(dir)
    return stats.bavail * stats.bsize
  } catch {
    return null
  }
}

export function registerIpcHandlers(getWindow: () => BrowserWindow | null): DownloadManager {
  // The main process keeps the network list, for downloads and the window alike.
  const networks = new NetworkMonitor((list) => {
    manager.networksChanged()
    const window = getWindow()
    if (window && !window.isDestroyed()) window.webContents.send(IpcChannels.networksChanged, list)
  })
  const manager = new DownloadManager(getWindow, networks)
  // Waking from sleep, the networks may have changed without a poll in between to see it.
  powerMonitor.on('resume', () => {
    manager.systemResumed()
    void networks.refresh()
  })

  handle('listInterfaces', () => networks.refresh())

  const iphone = new IphoneWatch(networks, (state) => {
    const window = getWindow()
    if (window && !window.isDestroyed()) {
      window.webContents.send(IpcChannels.iphoneTetherChanged, state)
    }
  })
  handle('iphoneTether', () => iphone.current)
  handle('openAppleDevices', () => openAppleDevices())

  // Started now so it has settled before the first download needs it.
  const bindingSupport = deviceBindingSupported()
  handle('deviceBindingSupported', async () => bindingSupport)

  // The app only ever assigns 'light'/'dark' to nativeTheme.themeSource (main/index.ts's startup
  // call to loadThemeSource() never resolves to 'system') — narrow Electron's wider type here
  // rather than widening our own ThemeSource just to match it.
  const currentThemeSource = (): ThemeSource =>
    nativeTheme.themeSource === 'dark' ? 'dark' : 'light'

  handle('updateSettings', async (_event, patch) => {
    // The one setting main also applies — before saving, so a failed write still switches the
    // window to the theme the toggle now shows.
    if (patch?.themeSource === 'light' || patch?.themeSource === 'dark') {
      nativeTheme.themeSource = patch.themeSource
    }
    await saveSettings(patch)
    // Read back rather than taken from the patch: what was saved is what passed the checks.
    await manager.applySettings(await loadSettings())
  })

  // Answered via sendSync from the preload, which blocks the page until returnValue is set — so a
  // throw here must still reply (with no saved values) rather than leave the window never showing.
  ipcMain.on(IpcChannels.getInitialState, async (event) => {
    try {
      const settings = await loadSettings()
      const { destinationDir } = settings
      // Capped: a folder on a dropped network share can take many seconds to answer, and launch
      // waits on this reply — past the cap it's treated as gone and Downloads is used instead.
      const destinationExists =
        destinationDir !== undefined &&
        (await Promise.race([
          stat(destinationDir).then(
            (stats) => stats.isDirectory(),
            () => false
          ),
          new Promise<boolean>((resolve) => setTimeout(resolve, DESTINATION_CHECK_MS, false))
        ]))
      event.returnValue = {
        downloadSchedule: settings.downloadSchedule,
        homeDir: getHomeDir(),
        downloadsDir: getDefaultDownloadsDir(),
        themeSource: currentThemeSource(),
        networkPreferences: settings.networkPreferences ?? {},
        downloadsAtOnce: settings.downloadsAtOnce ?? DOWNLOADS_AT_ONCE.default,
        speedLimit: settings.speedLimit,
        slowMode: settings.slowMode ?? false,
        slowModeSpeed: settings.slowModeSpeed ?? DEFAULT_SLOW_MODE_SPEED,
        speedUnit: settings.speedUnit ?? 'bytes',
        destinationDir: destinationExists ? destinationDir : undefined
      } satisfies InitialState
    } catch (error) {
      console.error('[netfuse] failed to read initial state', error)
      // No getPath() here — it may be what threw. An empty destination just keeps Start disabled.
      event.returnValue = {
        homeDir: '',
        downloadsDir: '',
        themeSource: currentThemeSource(),
        networkPreferences: {},
        downloadsAtOnce: DOWNLOADS_AT_ONCE.default,
        slowMode: false,
        slowModeSpeed: DEFAULT_SLOW_MODE_SPEED,
        speedUnit: 'bytes'
      } satisfies InitialState
    }
  })

  handle('openNetworkSettings', async () => {
    await openNetworkSettings()
  })

  handle('chooseDestinationFolder', async (_event, defaultPath) => {
    const window = getWindow()
    if (!window) return null
    const result = await dialog.showOpenDialog(window, {
      defaultPath,
      properties: ['openDirectory', 'createDirectory']
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  })

  handle('revealDownload', async (_event, id) => manager.reveal(id))

  handle('openDownload', async (_event, id) => manager.open(id))

  handle('startDownload', async (_event, request) =>
    redacting(() => manager.start(checkSteamStart(request)))
  )

  handle('listDownloads', async () => manager.listDownloads())

  handle('listHistory', async () => listHistory())

  handle('clearHistory', async () => manager.clearHistory())

  handle('networkUsage', async () => manager.limits.usedByPeriod())
  handle('resetNetworkUsage', async (_event, id) => manager.resetNetworkUsage(id))

  handle('freeSpace', async (_event, dir) => freeSpace(dir))

  handle('pauseDownload', async (_event, id) => {
    await manager.pause(id)
  })

  handle('resumeDownload', async (_event, id) => {
    manager.resume(id)
  })

  handle('setDownloadNetwork', async (_event, id, networkId, enabled) => {
    await manager.setNetworkEnabled(id, networkId, enabled)
  })

  handle('cancelDownload', async (_event, id) => manager.cancel(id))

  handle('removeDownload', async (_event, id, options) =>
    manager.remove(id, options?.trashFile === true)
  )

  handle('updateState', () => updateState())
  handle('showUpdateMenu', () => showUpdateMenu())

  const { account, library, planner } = manager.steam
  handle('steamLoginState', async () => {
    // The first time the window asks, a remembered login is used; the state changes are sent.
    void account.start()
    await account.lookedForStoredLogin()
    const state = account.loginState
    return state.status === 'logged-out' ? { ...state, canRemember: canRemember() } : state
  })
  handle('steamLogin', async (_event, request) => account.login(checkLoginRequest(request)))
  handle('steamSubmitCode', async (_event, code) => {
    if (!isText(code, 16) || !/^[A-Za-z0-9]+$/.test(code.trim())) {
      throw new Error('Enter the code as Steam shows it.')
    }
    await account.submitCode(code.trim().toUpperCase())
  })
  handle('steamCancelLogin', async () => account.cancel())
  handle('steamLogout', async () => account.logout())
  handle('steamOwnedApps', async (_event, refresh) =>
    redacting(() => library.ownedApps(refresh === true))
  )
  handle('steamAppDetails', async (_event, appId) => {
    if (!isId(appId)) throw new Error('Choose a game from your library.')
    return redacting(() => library.appDetails(appId))
  })
  handle('steamPrepare', async (_event, request) =>
    redacting(() => planner.prepare(checkPrepareRequest(request)))
  )
  handle('steamLibraryFolders', async (_event, installDir) => {
    if (installDir !== undefined && !isText(installDir, 255)) {
      throw new Error('Choose a game from your library.')
    }
    return findLibraryFolders(installDir)
  })
  handle('steamClientApps', async () => clientInstalledApps())

  return manager
}
