import { trashDownload } from './trashDownload'
import { describeError } from '../../shared/errors'
import { randomUUID } from 'node:crypto'
import { lstat, readFile, readdir, rename, rm, stat, statfs, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import type { BrowserWindow } from 'electron'
import { app, Notification, powerSaveBlocker, shell } from 'electron'
import { scheduleWindow } from '../../shared/downloadSchedule'
import { IpcChannels } from '../../shared/ipc-channels'
import { STEAM_LOGIN_REQUIRED } from '../../shared/steam'
import {
  DOWNLOADS_AT_ONCE,
  SPEED_HISTORY_SECONDS,
  type AppSettings,
  type DownloadSchedule,
  type DownloadNetwork,
  type DownloadStatus,
  type DownloadUnitState,
  type DownloadUpdate,
  type FinishedDownload,
  type NetworkInterfaceInfo,
  type NetworkStatus,
  type StartDownloadRequest,
  type SteamDownloadNetwork,
  type SteamDownloadState,
  type SteamRequestPayload
} from '../../shared/types'
import { Limits } from '../network/limits'
import { loadSettings } from '../settings'
import { addToHistory, findInHistory, removeFromHistory } from './history'
import { testKnobs } from '../testKnobs'
import { claimDestinationPath, ensureDirectory, pathExists } from './paths'
import {
  clearSpeeds,
  delay,
  Meters,
  recomputeAggregates,
  updateSpeeds,
  updateTimeLeft,
  type TransferHost,
  type SteamTransferTarget
} from './transfer'
import type { NetworkMonitor } from '../network/interfaces'
import { buildLayout, type SteamLayout } from '../steam/layout'
import type { ChunkBook } from '../steam/cells'
import {
  chunkBook,
  decodeUnits,
  encodeUnits,
  readManifests,
  writeManifests,
  type SavedSteamProgress
} from '../steam/runtime'
import { createSteamServices, type SteamServices } from '../steam/service'
import { SteamDestination } from '../steam/steamDestination'
import { SteamTransfer } from '../steam/steamTransfer'

// Every download, from start to history: the queue and how many run at once, the schedule, pause
// and resume, each download's networks, saving its progress, and telling the window. Fetching is
// its transfer's (see transfer.ts); a game's files are its destination's (SteamDestination).

interface DownloadRuntime extends SteamTransferTarget {
  kind: 'steam'
  file: SteamDestination
  transfer: SteamTransfer
  layout: SteamLayout
  book: ChunkBook
  /** For each of the book's chunks, its unit in the layout. */
  units: Uint32Array
  publicationPath?: string
  publicationIdentity?: { dev: number; ino: number }
  runPromise?: Promise<void>
  cancelPromise?: Promise<void>
  scheduleStopping?: boolean
  publishing: boolean
  pushScheduled: boolean
  persistenceTimer?: NodeJS.Timeout
  /** A routine checkpoint waits its turn: it will save whatever has changed by then. */
  checkpointQueued?: boolean
  persistenceChain: Promise<void>
  removed: boolean
  /** Updates sent to the window so far (see DownloadUpdate). */
  sentUpdates: number
  /** Each cell as the window was last sent it, by index — what tells a changed cell apart. */
  sentUnits: Pick<DownloadUnitState, 'status' | 'interfaceId' | 'bytesDownloaded'>[]
  /** The network most recently switched off: what a resume switches back on if it finds none on.
   * Not persisted: after a restart, the first network present is used instead. */
  lastSwitchedOff?: string
  /** Paused by switching off its last network, rather than by Pause: switching one back on
   * resumes it. */
  pausedForNoNetwork?: boolean
  /** When the speeds last went into the history (see sampleSpeeds). */
  speedSampledAt: number
  /** The byte count, read once a second while downloading and carried over pauses: back to the
   * newest reading PEAK_SECONDS old (see samplePeak). */
  peakReadings: { time: number; bytes: number }[]
}

/** What manifest.json keeps of a download: its state without the cells and streams, which are
 * worked out again, and what is needed to resume it. Never a key or token. */
interface PersistedDownload {
  version: 1
  savedAt: number
  state: Omit<SteamDownloadState, 'cells' | 'streams'>
  /** The install folder. */
  partialPath: string
  publicationPath?: string
  publicationIdentity?: { dev: number; ino: number }
  requestPayload: SteamRequestPayload
  /** Its chunks' progress (see SavedSteamProgress). */
  steam?: SavedSteamProgress
}

const UI_UPDATE_MS = 200
/** How often a running download takes stock (see run). */
const TICK_MS = 500
// Syncing can briefly monopolize a slow destination drive. Keep recovery checkpoints independent
// of UI updates; pause and publication still force an immediate sync.
const CHECKPOINT_INTERVAL_MS = 15_000

// The peak is the best speed held this many seconds: longer than a start's burst (an ISP's burst
// allowance, every connection ramping up at once), which isn't the line's speed.
const PEAK_SECONDS = 5

/** Adds each network's speed to the download's history, and 0 for one no longer listed. A
 * network seen for the first time starts at 0 too, so every series is as long as the others and
 * lines up with them. */
function sampleSpeeds(state: SteamDownloadState): void {
  const history = (state.speedHistory ??= {})
  const length = Object.values(history)[0]?.length ?? 0
  for (const network of state.networks) {
    history[network.id] ??= new Array<number>(length).fill(0)
  }
  for (const [id, series] of Object.entries(history)) {
    series.push(state.networks.find((network) => network.id === id)?.speedBytesPerSec ?? 0)
    if (series.length > SPEED_HISTORY_SECONDS) series.shift()
  }
}

/** Raises the peak to the last PEAK_SECONDS of downloading, read from the bytes themselves: what
 * AVG is made of, so the peak can't read below it (an average is never above its best stretch).
 * Read off the speed meters instead, it missed the opening burst AVG counts, and early on read
 * lower. The first stretch starts with the download, so a burst is in it, spread over the seconds,
 * not a speed. Readings run on across a pause (see run), so short runs between pauses count too. */
function samplePeak(runtime: DownloadRuntime, now: number): void {
  const { state } = runtime
  const readings = runtime.peakReadings
  readings.push({ time: now, bytes: state.bytesDownloaded })
  // Back to the newest reading at least PEAK_SECONDS old, by time rather than by count: a run that
  // stops between ticks adds a reading, and counted, a short stretch passed for a full one.
  while (readings.length > 1 && readings[1].time <= now - PEAK_SECONDS * 1000) readings.shift()
  const first = readings[0]
  if (now - first.time < PEAK_SECONDS * 1000) return
  const held = (state.bytesDownloaded - first.bytes) / ((now - first.time) / 1000)
  // Stretches are only read where a reading falls, so the download's first or last few seconds
  // can go unread as one — and when those were its fastest, every stretch read is slower than the
  // average. Its best 5 seconds can't be, though: past PEAK_SECONDS of downloading, the average
  // (as AVG works it out) is a floor the peak truly clears.
  const downloading = (now - state.startedAt - (state.totalPausedMs ?? 0)) / 1000
  const average = downloading >= PEAK_SECONDS ? state.bytesDownloaded / downloading : 0
  state.peakSpeedBytesPerSec = Math.max(state.peakSpeedBytesPerSec ?? 0, held, average)
}

function newNetwork(iface: NetworkInterfaceInfo, enabled: boolean): SteamDownloadNetwork {
  return {
    transfer: 'steam',
    id: iface.id,
    label: iface.displayName,
    kind: iface.kind,
    enabled,
    status: enabled ? 'on' : 'off',
    bytesDownloaded: 0,
    speedBytesPerSec: 0,
    retries: 0
  }
}

const isDone = (unit: DownloadUnitState): boolean => unit.status === 'completed'

const isNotFound = (error: unknown): boolean =>
  (error as NodeJS.ErrnoException | null)?.code === 'ENOENT'

/** A manifest this version writes, for the download in folder `id`. */
function isCurrentManifest(value: unknown, id: string): value is PersistedDownload {
  const manifest = value as Partial<PersistedDownload> | null
  return (
    manifest?.version === 1 &&
    manifest.state?.id === id &&
    manifest.state.kind === 'steam' &&
    manifest.requestPayload?.kind === 'steam'
  )
}

function formatGigabytes(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`
}

async function ensureDiskSpace(destinationDir: string, requiredBytes: number): Promise<void> {
  if (requiredBytes <= 0) return
  const stats = await statfs(destinationDir)
  const availableBytes = stats.bavail * stats.bsize
  if (availableBytes < requiredBytes) {
    throw new Error(
      `Not enough disk space: this download needs ${formatGigabytes(requiredBytes)} but only ${formatGigabytes(availableBytes)} is free`
    )
  }
}

export class DownloadManager {
  private runtimes = new Map<string, DownloadRuntime>()
  private readonly initialization: Promise<void>
  private suspending = false
  private scheduleLoaded = false
  private downloadSchedule?: DownloadSchedule
  private scheduleTimer?: NodeJS.Timeout
  /** Each network's addresses as last seen, by id: what tells a network that has changed. */
  private seenAddresses = new Map<string, string[]>()
  /** The powerSaveBlocker keeping the computer awake while a download runs (see keepAwake). */
  private awakeBlocker: number | null = null
  /** How many downloads may run at once; the rest wait, queued (see pump). */
  private downloadsAtOnce = DOWNLOADS_AT_ONCE.default
  /** Speed and data limits, for every download together. */
  readonly limits = new Limits(() => this.limitsChanged())
  /** The Steam login, library and plans, and the workers that check chunks. */
  readonly steam: SteamServices

  constructor(
    private getWindow: () => BrowserWindow | null,
    private networks: NetworkMonitor
  ) {
    this.steam = createSteamServices({
      networks,
      limits: this.limits,
      loginChanged: (state) => {
        this.send(IpcChannels.steamLoginStateChanged, state)
        if (state.status === 'logged-in') this.loggedIn()
      },
      progress: (progress) => this.send(IpcChannels.steamPrepareProgress, progress)
    })
    this.initialization = Promise.all([this.restorePersistedDownloads(), this.limits.loaded]).then(
      async () => {
        // Read after recovery, including any settings saved while the manifests were loading.
        await this.configureSettings(await loadSettings())
      }
    )
  }

  /** Takes up what the user set: how many run at once, and the limits. One running past a
   * lowered count is left to finish; a raised one starts the next ones in the queue. */
  async applySettings(settings: AppSettings): Promise<void> {
    await this.initialization
    await this.configureSettings(settings)
  }

  private async configureSettings(settings: AppSettings): Promise<void> {
    this.downloadSchedule = settings.downloadSchedule
    this.scheduleLoaded = true
    const enrollmentChanged: DownloadRuntime[] = []
    const scheduled = this.downloadSchedule?.enabled || undefined
    for (const runtime of this.runtimes.values()) {
      if (
        (runtime.state.status === 'queued' || runtime.state.status === 'downloading') &&
        runtime.state.scheduled !== scheduled
      ) {
        runtime.state.scheduled = scheduled
        enrollmentChanged.push(runtime)
        this.pushUpdate(runtime)
      }
    }
    this.downloadsAtOnce = settings.downloadsAtOnce ?? DOWNLOADS_AT_ONCE.default
    this.limits.configure(settings)
    await this.refreshSchedule()
    this.limitsChanged()
    await Promise.all(enrollmentChanged.map((runtime) => this.persistNow(runtime)))
    this.armScheduleTimer()
  }

  /** A network ran out of data, or a limit changed: each download's networks are looked at
   * again, so one at its limit stops being used, and one no longer at it is used again. */
  async resetNetworkUsage(id: string): Promise<void> {
    await this.limits.resetUsage(id)
    this.limitsChanged()
  }

  private limitsChanged(): void {
    for (const runtime of this.runtimes.values()) {
      const { status } = runtime.state
      if (status !== 'downloading' && status !== 'paused' && status !== 'queued') continue
      this.reconcile(runtime)
      this.scheduleUpdate(runtime)
    }
  }

  private armScheduleTimer(): void {
    clearTimeout(this.scheduleTimer)
    if (this.suspending || !this.downloadSchedule?.enabled) return
    // Check the clock as well as exact boundaries, including timezone changes while running.
    const now = Date.now()
    const window = scheduleWindow(this.downloadSchedule, now)
    const boundary = window.allowed ? window.endsAt : window.nextStart
    this.scheduleTimer = setTimeout(
      () => {
        void this.refreshSchedule()
          .catch((error) => console.error('[netfuse] schedule', error))
          .finally(() => this.armScheduleTimer())
      },
      boundary ? Math.max(1, Math.min(1000, boundary - now)) : 1000
    )
    this.scheduleTimer.unref()
  }

  private scheduleAllowsDownloads(): boolean {
    return this.scheduleLoaded && scheduleWindow(this.downloadSchedule).allowed
  }

  /** Close transfers before the queue can start anything else. The queued intent is persisted,
   * so a scheduled download can continue next night after a relaunch. */
  private async refreshSchedule(): Promise<void> {
    if (this.suspending) return
    if (!this.scheduleAllowsDownloads()) {
      await Promise.all(
        [...this.runtimes.values()].map((runtime) =>
          runtime.state.status === 'downloading' || runtime.scheduleStopping
            ? this.pause(runtime.state.id, true)
            : undefined
        )
      )
    } else {
      this.pump()
    }
  }

  /** Running downloads on Auto with `networkId` on: how many share its streams (see
   * concurrency.ts). One with a picked count keeps it, so it takes no share. */
  private downloadsOn(networkId: string): number {
    let count = 0
    for (const runtime of this.runtimes.values()) {
      if (
        runtime.requestPayload.streamsPerNetwork === undefined &&
        runtime.state.status === 'downloading' &&
        runtime.state.networks.some(
          (network) => network.id === networkId && network.status === 'on'
        )
      )
        count++
    }
    return count
  }

  private runningCount(): number {
    let running = 0
    for (const runtime of this.runtimes.values()) {
      if (runtime.state.status === 'downloading') running++
    }
    return running
  }

  /** Starts queued downloads, first queued first, while fewer than downloadsAtOnce run. Called
   * whenever one might have room: a run ended, a queued one went, the count went up. */
  private pump(): void {
    if (this.suspending || !this.scheduleAllowsDownloads()) return
    const queued = [...this.runtimes.values()]
      .filter((runtime) => runtime.state.status === 'queued' && !runtime.scheduleStopping)
      .sort((a, b) => (a.state.queuedAt ?? 0) - (b.state.queuedAt ?? 0))
    for (const runtime of queued) {
      if (this.runningCount() >= this.downloadsAtOnce) return
      this.begin(runtime)
    }
  }

  /** Puts a download in the queue: at its end, or at its front when the user asked for it. */
  private enqueue(runtime: DownloadRuntime, front: boolean): void {
    const places = [...this.runtimes.values()]
      .filter((other) => other !== runtime && other.state.status === 'queued')
      .map((other) => other.state.queuedAt ?? 0)
    runtime.state.status = 'queued'
    runtime.state.scheduled = this.downloadSchedule?.enabled || undefined
    // Time spent waiting isn't time spent downloading (begin adds it to totalPausedMs).
    runtime.state.pausedAt ??= Date.now()
    runtime.state.queuedAt = front
      ? Math.min(Date.now(), ...places) - 1
      : Math.max(Date.now(), ...places.map((place) => place + 1))
  }

  private send(channel: string, payload: unknown): void {
    const window = this.getWindow()
    if (window && !window.isDestroyed()) window.webContents.send(channel, payload)
  }

  /** Where a download keeps the manifests it installs from, beside its manifest.json. */
  private steamManifestsPath(id: string): string {
    return join(this.downloadDir(id), 'steam-manifests.json.gz')
  }

  private downloadsRoot(): string {
    return join(app.getPath('userData'), 'downloads')
  }

  private downloadDir(id: string): string {
    return join(this.downloadsRoot(), id)
  }

  private manifestPath(id: string): string {
    return join(this.downloadDir(id), 'manifest.json')
  }

  private newRuntime(
    state: SteamDownloadState,
    requestPayload: SteamRequestPayload,
    file: SteamDestination,
    layout: SteamLayout,
    book: ChunkBook,
    units: Uint32Array
  ): DownloadRuntime {
    const target: SteamTransferTarget & { file: SteamDestination } = {
      state,
      requestPayload,
      stop: new AbortController(),
      file,
      cells: book.cells,
      meters: new Meters()
    }
    const host: TransferHost = {
      networks: this.networks,
      limits: this.limits,
      downloadsOn: (networkId) => this.downloadsOn(networkId),
      reconcile: () => this.reconcile(runtime),
      failDownload: (message, discard) => this.failDownload(runtime, message, discard),
      failNetwork: (network, message) => this.failNetwork(runtime, network, message),
      scheduleUpdate: () => this.scheduleUpdate(runtime)
    }
    const runtime: DownloadRuntime = Object.assign(target, {
      kind: 'steam' as const,
      layout,
      book,
      units,
      publishing: false,
      pushScheduled: false,
      persistenceChain: Promise.resolve(),
      removed: false,
      sentUpdates: 0,
      sentUnits: [],
      speedSampledAt: 0,
      peakReadings: [],
      transfer: new SteamTransfer(
        target,
        host,
        { file, layout, book, units },
        { account: this.steam.account, workers: this.steam.workers }
      )
    })
    return runtime
  }

  private async restorePersistedDownloads(): Promise<void> {
    let entries: string[]
    try {
      entries = await readdir(this.downloadsRoot())
    } catch {
      return
    }

    const restored: DownloadRuntime[] = []
    await Promise.all(
      entries.map(async (id) => {
        await rm(`${this.manifestPath(id)}.tmp`, { force: true }).catch(() => {})
        let persisted: unknown
        try {
          persisted = JSON.parse(await readFile(this.manifestPath(id), 'utf-8'))
        } catch (error) {
          // No manifest, or a garbled one: nothing can bring it back. Any other read error (a
          // drive not mounted, a permission) may pass, and is left for the next launch.
          if (error instanceof SyntaxError || isNotFound(error)) await this.discardUnrestorable(id)
          return
        }
        if (!isCurrentManifest(persisted, id)) return this.discardUnrestorable(id)
        try {
          const runtime = await this.restoreOne(id, persisted)
          if (runtime) restored.push(runtime)
          else await this.discardUnrestorable(id)
        } catch {
          // As above: left for a launch where it can be read.
        }
      })
    )

    // Two installing into one folder would scramble it: of any that share one, the newest is
    // kept and the others go, the folder left to it.
    restored.sort((a, b) => b.state.startedAt - a.state.startedAt)
    const claimed = new Set<string>()
    const kept = restored.filter((runtime) => {
      if (claimed.has(runtime.file.path)) return false
      claimed.add(runtime.file.path)
      return true
    })
    await Promise.all(
      restored
        .filter((runtime) => !kept.includes(runtime))
        .map((runtime) => this.removePersistedDownload(runtime, false))
    )

    await Promise.all(
      kept.map(async (runtime) => {
        this.runtimes.set(runtime.state.id, runtime)
        // Finished before the relaunch (or found to be): history keeps it from here.
        if (runtime.state.status === 'completed') await this.moveToHistory(runtime)
        else await this.persistNow(runtime)
      })
    )
  }

  /** A finished download leaves the list of running ones for history, without its cells: a
   * download that is done needs none of them. Its saved state goes only once history has it. */
  private async moveToHistory(runtime: DownloadRuntime): Promise<void> {
    const { cells: omittedCells, streams: omittedStreams, ...state } = runtime.state
    void omittedCells
    void omittedStreams
    const entry: FinishedDownload = { ...state, unitsWritten: state.totalChunks }
    try {
      await addToHistory(structuredClone(entry))
    } catch {
      // Kept as it is, to be moved on the next launch.
      return
    }
    this.runtimes.delete(runtime.state.id)
    await this.removePersistedDownload(runtime, false)
    this.historyChanged()
  }

  private historyChanged(): void {
    this.send(IpcChannels.historyChanged, undefined)
  }

  /** Forgets every finished download. Their files are the user's: they stay. */
  async clearHistory(): Promise<void> {
    await this.initialization
    await Promise.allSettled(
      [...this.runtimes.values()]
        .filter((runtime) => runtime.state.status === 'completed')
        .map((runtime) => runtime.runPromise)
    )
    await removeFromHistory()
    this.historyChanged()
  }

  /** A saved download as this version writes it, restored paused — or null when it never can be:
   * its manifests are gone, or its layout or progress doesn't fit them. */
  private async restoreOne(
    id: string,
    persisted: PersistedDownload
  ): Promise<DownloadRuntime | null> {
    // Its layout, worked out again from the manifests it saved, every path checked anew.
    const manifests = await readManifests(this.steamManifestsPath(id))
    if (!manifests) return null
    let layout: SteamLayout
    try {
      layout = buildLayout(manifests)
    } catch {
      return null
    }
    const units = decodeUnits(persisted.steam?.units, layout)
    if (!units) return null
    const book = chunkBook(layout, units)
    // Progress that doesn't fit is dropped: the chunks are fetched again, never trusted.
    book.restore(persisted.steam?.chunks)
    // Which files it made, for cancelling an install into an existing folder: a list that
    // doesn't fit counts as none, so that a cancel never removes what was there before.
    const saved = persisted.steam?.created
    const created =
      Array.isArray(saved) &&
      saved.every((index) => Number.isInteger(index) && index >= 0 && index < layout.files.length)
        ? saved
        : []
    const old = persisted.state
    const state: SteamDownloadState = {
      ...old,
      streams: [],
      cells: book.cells,
      totalCells: book.cells.length,
      totalChunks: book.count,
      chunksDone: book.chunksDone,
      bytesDownloaded: book.bytesDone,
      phase: undefined
    }
    const runtime = this.newRuntime(
      state,
      persisted.requestPayload,
      new SteamDestination(
        persisted.partialPath,
        layout,
        () => state.totalBytes,
        !!old.adopted,
        created
      ),
      layout,
      book,
      units
    )
    // Restore paused first so the install folder can be checked before scheduled work is queued.
    if (state.status === 'downloading' || state.status === 'queued') {
      state.status = 'paused'
      state.pausedAt = persisted.savedAt || Date.now()
      state.queuedAt = undefined
    }
    clearSpeeds(state)
    for (const cell of runtime.cells) {
      if (cell.status === 'downloading') cell.status = 'pending'
    }

    if (state.status === 'paused') {
      const there = (await runtime.file.size().catch(() => -1)) >= 0
      const publishedPath = persisted.publicationPath ?? state.destinationPath
      const published = await stat(publishedPath).catch(() => null)
      // An install is in place from the start, so its folder being there says nothing: only the
      // publication recorded after its final sync does.
      const recorded =
        !!published &&
        persisted.publicationIdentity?.dev === published.dev &&
        persisted.publicationIdentity?.ino === published.ino
      if (runtime.cells.every(isDone) && recorded) {
        state.status = 'completed'
        state.destinationPath = publishedPath
        state.fileName = basename(publishedPath)
        state.error = undefined
        state.completedAt ??= persisted.savedAt
      } else if (!there) {
        state.status = 'error'
        state.error = 'The install folder is missing. Remove this download and start again.'
        state.resumable = false
      }
    }

    if (state.status === 'paused' && state.scheduled === true) {
      state.status = 'queued'
      state.queuedAt = persisted.state.queuedAt ?? state.startedAt
    }

    runtime.publicationPath = persisted.publicationPath
    runtime.publicationIdentity = persisted.publicationIdentity
    // A resumed download's last minute starts when it does, not where it stopped before the
    // relaunch; a finished one keeps its chart.
    if (state.status !== 'completed') state.speedHistory = undefined
    recomputeAggregates(state, runtime.cells)
    return runtime
  }

  /** Clears a saved download that can't be restored, rather than keep it forever: its folder here.
   * Its install folder is the user's, and stays. */
  private async discardUnrestorable(id: string): Promise<void> {
    await rm(this.downloadDir(id), { recursive: true, force: true }).catch(() => {})
  }

  /** A snapshot of every download: updates with every cell in them, oldest first. */
  async listDownloads(): Promise<DownloadUpdate[]> {
    await this.initialization
    return [...this.runtimes.values()]
      .sort((a, b) => a.state.startedAt - b.state.startedAt)
      .map((runtime) => {
        const { cells, ...state } = runtime.state
        return structuredClone({ seq: runtime.sentUpdates, state, cells })
      })
  }

  /** Starts the download a plan from steamPrepare describes, or queues it when as many run as may
   * (see downloadsAtOnce) or the schedule says not now. */
  async start(request: StartDownloadRequest): Promise<string> {
    await this.initialization
    const available = await this.networks.refresh()
    const selected = available.filter((iface) => request.interfaceIds.includes(iface.id))
    if (selected.length === 0) {
      throw new Error('Select at least one network')
    }
    const id = randomUUID()
    const runtime = await this.newDownload(id, request, available, selected)
    // Decided only now: other starts may have taken the room while this one was set up.
    const room = this.runningCount() < this.downloadsAtOnce && this.scheduleAllowsDownloads()
    if (!room) this.enqueue(runtime, false)
    runtime.state.scheduled = this.downloadSchedule?.enabled || undefined
    this.runtimes.set(id, runtime)
    await this.persistNow(runtime)
    this.pushUpdate(runtime)
    if (room) this.begin(runtime)

    return id
  }

  /**
   * The download a plan from steamPrepare describes: its install folder claimed, or the existing
   * one it was checked against taken over, and its manifests saved beside its manifest.json so
   * that a restart can work its layout out again without Steam.
   */
  private async newDownload(
    id: string,
    request: StartDownloadRequest,
    available: NetworkInterfaceInfo[],
    selected: NetworkInterfaceInfo[]
  ): Promise<DownloadRuntime> {
    // Taken out of the planner at once, so that a second click can't start it twice.
    const prepared = this.steam.planner.take(request.planId)
    if (!prepared) throw new Error('This choice has expired. Choose what to download again.')
    const { plan, layout, units } = prepared
    const adopt = prepared.request.adopt === true
    const destinationDir = plan.destinationDir
    await ensureDirectory(destinationDir)
    await ensureDiskSpace(destinationDir, Math.max(0, layout.installBytes - plan.presentBytes))
    // What was checked as already there must still be as it was, or chunks counted present
    // might not be.
    for (const file of prepared.checked) {
      const info = await lstat(file.path).catch(() => null)
      if (!info?.isFile() || info.size !== file.size || info.mtimeMs !== file.mtimeMs) {
        throw new Error('Files in this folder changed after it was checked. Check it again.')
      }
    }

    await ensureDirectory(this.downloadDir(id))
    let folder: string
    try {
      await writeManifests(this.steamManifestsPath(id), prepared.manifests)
      if (adopt) {
        folder = join(destinationDir, prepared.folderName)
        if (!(await lstat(folder).catch(() => null))?.isDirectory()) {
          throw new Error(`There is no folder named ${prepared.folderName} to install into.`)
        }
      } else {
        folder = await claimDestinationPath(destinationDir, prepared.folderName, true)
      }
    } catch (error) {
      await rm(this.downloadDir(id), { recursive: true, force: true }).catch(() => {})
      throw error
    }

    const book = chunkBook(layout, units)
    const state: SteamDownloadState = {
      id,
      kind: 'steam',
      url: `steam://app/${plan.appId}`,
      fileName: basename(folder),
      destinationPath: folder,
      totalBytes: plan.downloadBytes,
      bytesDownloaded: 0,
      speedBytesPerSec: 0,
      status: 'downloading',
      networks: available.map((iface) => newNetwork(iface, selected.includes(iface))),
      streams: [],
      peakStreams: 0,
      cells: book.cells,
      totalCells: book.cells.length,
      totalChunks: book.count,
      chunksDone: 0,
      app: {
        appId: plan.appId,
        name: plan.appName,
        branch: prepared.branch,
        buildId: prepared.buildId
      },
      depots: prepared.depots,
      fileCount: plan.fileCount,
      installBytes: layout.installBytes,
      adopted: adopt || undefined,
      phase: 'preparing',
      startedAt: Date.now()
    }
    // What is saved to resume it: never the plan id, which means nothing after a restart.
    const payload: SteamRequestPayload = {
      kind: 'steam',
      appId: plan.appId,
      branch: prepared.branch,
      depots: prepared.depots.map(({ depotId, manifestId }) => ({ depotId, manifestId })),
      destinationDir,
      interfaceIds: request.interfaceIds,
      streamsPerNetwork: request.streamsPerNetwork
    }
    return this.newRuntime(
      state,
      payload,
      new SteamDestination(folder, layout, () => state.totalBytes, adopt),
      layout,
      book,
      units
    )
  }

  /** Runs the download, and once the run ends makes room for the next one queued. */
  private launch(runtime: DownloadRuntime): void {
    runtime.runPromise = this.run(runtime).finally(() => this.pump())
  }

  async pause(id: string, forSchedule = false): Promise<void> {
    const runtime = this.runtimes.get(id)
    if (runtime?.state.status === 'queued') {
      if (forSchedule) {
        await runtime.runPromise
        return
      }
      runtime.state.scheduled = undefined
      runtime.state.status = 'paused'
      runtime.state.queuedAt = undefined
      runtime.state.pausedAt ??= Date.now()
      this.pushUpdate(runtime)
      await runtime.runPromise
      await this.persistNow(runtime)
      return
    }
    if (!runtime || runtime.state.status !== 'downloading' || runtime.publishing) return

    if (forSchedule) {
      runtime.scheduleStopping = true
      this.enqueue(runtime, false)
    } else {
      runtime.state.status = 'paused'
      runtime.state.scheduled = undefined
    }
    runtime.state.pausedAt = Date.now()
    clearSpeeds(runtime.state)
    for (const stream of runtime.state.streams) {
      if (stream.status !== 'completed') stream.status = 'paused'
      stream.currentCellIndex = undefined
      stream.chunkReceived = undefined
      stream.chunkBytes = undefined
      stream.hedge = undefined
    }
    for (const cell of runtime.cells) {
      if (cell.status === 'downloading') cell.status = 'pending'
    }
    runtime.transfer.reset()
    this.stopRun(runtime)
    this.pushUpdate(runtime)
    try {
      await runtime.runPromise
      await this.persistNow(runtime)
    } finally {
      runtime.scheduleStopping = false
      this.pump()
    }
  }

  /** Downloads that stopped only for want of a login go on by themselves once there is one: one
   * restored at launch runs before the user has had a chance to log in. */
  private loggedIn(): void {
    for (const runtime of this.runtimes.values()) {
      const { status, error } = runtime.state
      if (status === 'error' && error === STEAM_LOGIN_REQUIRED) this.resume(runtime.state.id)
    }
  }

  resume(id: string): void {
    const runtime = this.runtimes.get(id)
    if (!runtime || runtime.cancelPromise) return
    const { status, resumable } = runtime.state
    if (status !== 'paused' && !(status === 'error' && resumable !== false)) return

    void this.resumeAfterVerifying(runtime, false)
  }

  // Whether a network is there to resume on is the run's business: with none, it waits for one.
  // `byNetwork`: resumed by switching a network back on, rather than by Resume.
  private async resumeAfterVerifying(runtime: DownloadRuntime, byNetwork: boolean): Promise<void> {
    // The paused run can still be winding down: a write finishing, a check in flight. A new one
    // must not start beside it — both would go on to publish, and act on each other's streams.
    await runtime.runPromise
    // Just after launch the networks may not have been looked at yet.
    await this.networks.refresh()

    if ((await runtime.file.size().catch(() => -1)) < 0) {
      runtime.state.error =
        'The install folder is unavailable. Reconnect the destination drive and try again.'
      this.pushUpdate(runtime)
      return
    }
    if (
      runtime.cancelPromise ||
      (runtime.state.status !== 'paused' && runtime.state.status !== 'error')
    )
      return
    const { networks } = runtime.state
    // Switched back on, then off again while the paused run wound down: it stays paused.
    if (byNetwork && !networks.some((network) => network.enabled)) return

    if (this.runningCount() >= this.downloadsAtOnce || !this.scheduleAllowsDownloads()) {
      // Asked for by name, so it goes next.
      this.enqueue(runtime, true)
      runtime.state.error = undefined
      runtime.state.resumable = undefined
      runtime.pausedForNoNetwork = undefined
      this.pushUpdate(runtime)
      await this.persistNow(runtime)
      return
    }
    this.begin(runtime)
  }

  /** Starts a run of a paused, failed or queued download, from where it stopped. */
  private begin(runtime: DownloadRuntime): void {
    if (this.suspending || !this.scheduleAllowsDownloads()) {
      this.enqueue(runtime, false)
      this.pushUpdate(runtime)
      void this.persistNow(runtime)
      return
    }
    runtime.state.scheduled = this.downloadSchedule?.enabled || undefined
    const { networks } = runtime.state
    runtime.state.status = 'downloading'
    runtime.state.queuedAt = undefined
    runtime.state.error = undefined
    runtime.state.resumable = undefined
    runtime.pausedForNoNetwork = undefined
    // Paused by switching off every network: resuming switches back on the one switched off
    // last if it is still there, or else the first one present.
    if (!networks.some((network) => network.enabled)) {
      const present = (network: { id: string }): boolean => !!this.networks.find(network.id)
      const again =
        networks.find((network) => network.id === runtime.lastSwitchedOff && present(network)) ??
        networks.find(present) ??
        networks.find((network) => network.id === runtime.lastSwitchedOff) ??
        networks[0]
      if (again) again.enabled = true
    }
    // A network that had failed, or couldn't get through, gets another go.
    for (const network of runtime.state.networks) {
      if (network.status === 'failed' || network.status === 'unreachable') {
        network.status = 'on'
        network.error = undefined
      }
    }
    if (runtime.state.pausedAt) {
      runtime.state.totalPausedMs =
        (runtime.state.totalPausedMs || 0) + (Date.now() - runtime.state.pausedAt)
      runtime.state.pausedAt = undefined
    }
    for (const cell of runtime.cells) {
      if (cell.status === 'downloading') cell.status = 'pending'
    }
    for (const stream of runtime.state.streams) {
      if (stream.status !== 'completed') stream.status = 'pending'
      stream.speedBytesPerSec = 0
    }
    runtime.transfer.reset()
    this.pushUpdate(runtime)

    this.launch(runtime)
  }

  /** Switches one of a download's networks on or off, running or paused. Switching off the last
   * network in use pauses the download; switching one back on then resumes it. */
  async setNetworkEnabled(id: string, networkId: string, enabled: boolean): Promise<void> {
    const runtime = this.runtimes.get(id)
    const status = runtime?.state.status
    if (
      !runtime ||
      runtime.cancelPromise ||
      (status !== 'downloading' && status !== 'paused' && status !== 'queued')
    ) {
      return
    }
    const { networks } = runtime.state
    const network = networks.find((entry) => entry.id === networkId)
    if (!network || network.enabled === enabled) return
    const wasLast = !enabled && !networks.some((other) => other !== network && other.enabled)
    network.enabled = enabled
    if (!enabled) runtime.lastSwitchedOff = network.id
    if (wasLast && status === 'downloading') {
      runtime.pausedForNoNetwork = true
      await this.pause(id)
      // Not paused after all (it was already publishing): nothing for a network to resume.
      if (runtime.state.status !== 'paused') runtime.pausedForNoNetwork = undefined
      return
    }
    this.reconcile(runtime)
    this.pushUpdate(runtime)
    // Switched back on while the pause is still winding down, it resumes once that is done.
    if (enabled && status === 'paused' && runtime.pausedForNoNetwork) {
      void this.resumeAfterVerifying(runtime, true)
    }
  }

  /** The computer's networks changed (see NetworkMonitor). A network whose addresses changed
   * gets its streams going again at once: what they were waiting out may be what changed. One
   * that lost an address also drops its sockets, which may be bound to it. Chrome does the same
   * when its IP address changes (ERR_NETWORK_CHANGED). */
  networksChanged(): void {
    const changed = new Set<string>()
    const moved = new Set<string>()
    const seen = new Map<string, string[]>()
    for (const iface of this.networks.current ?? []) {
      const addresses = iface.addresses.map((entry) => entry.address)
      const before = this.seenAddresses.get(iface.id)
      seen.set(iface.id, addresses)
      if (before?.length === addresses.length && before.every((a) => addresses.includes(a))) {
        continue
      }
      changed.add(iface.id)
      if (before?.some((address) => !addresses.includes(address))) moved.add(iface.id)
    }
    this.seenAddresses = seen

    for (const runtime of this.runtimes.values()) {
      const { status } = runtime.state
      if (status !== 'downloading' && status !== 'paused' && status !== 'queued') continue
      this.reconcile(runtime)
      runtime.transfer.wake(
        (id) => changed.has(id),
        (id) => moved.has(id)
      )
      this.scheduleUpdate(runtime)
    }
  }

  /** The computer woke from sleep. Its sockets are likely dead, though nothing will say so until
   * a stall watchdog runs out, and every judgement made by the clock (a silent network, a
   * crawling connection) spans the sleep. All of it starts over. */
  systemResumed(): void {
    void this.refreshSchedule().catch((error) =>
      console.error('[netfuse] schedule after wake', error)
    )
    const now = Date.now()
    for (const runtime of this.runtimes.values()) {
      if (runtime.state.status !== 'downloading') continue
      runtime.transfer.systemResumed(now)
    }
  }

  /** Keeps the computer from sleeping while a download runs, which would stop it — as
   * qBittorrent and Transmission offer to. The display can still sleep. */
  private keepAwake(): void {
    const running = [...this.runtimes.values()].some(
      (runtime) => runtime.state.status === 'downloading'
    )
    try {
      if (running && this.awakeBlocker === null) {
        this.awakeBlocker = powerSaveBlocker.start('prevent-app-suspension')
      } else if (!running && this.awakeBlocker !== null) {
        powerSaveBlocker.stop(this.awakeBlocker)
        this.awakeBlocker = null
      }
    } catch {
      // Not every desktop can be kept awake; the download runs regardless.
    }
  }

  async cancel(id: string): Promise<void> {
    const runtime = this.runtimes.get(id)
    if (runtime?.cancelPromise) return runtime.cancelPromise
    if (
      !runtime ||
      runtime.publishing ||
      (runtime.state.status !== 'downloading' &&
        runtime.state.status !== 'paused' &&
        runtime.state.status !== 'queued' &&
        runtime.state.status !== 'error')
    )
      return

    runtime.cancelPromise = this.cancelRuntime(runtime)
    try {
      await runtime.cancelPromise
    } finally {
      runtime.cancelPromise = undefined
    }
  }

  private async cancelRuntime(runtime: DownloadRuntime): Promise<void> {
    try {
      // Stop writing first, but keep the item visible until its files and manifest are gone.
      await this.pause(runtime.state.id)
      if (runtime.state.status !== 'error') {
        runtime.state.status = 'paused'
        runtime.state.queuedAt = undefined
        runtime.state.pausedAt ??= Date.now()
      }
      clearSpeeds(runtime.state)
      this.stopRun(runtime)
      this.pushUpdate(runtime, false)
      await runtime.runPromise?.catch(() => {})
      await runtime.file.discard()
      await this.removePersistedDownload(runtime, false)
      runtime.state.status = 'cancelled'
      for (const stream of runtime.state.streams) stream.status = 'cancelled'
      this.pushUpdate(runtime, false)
    } catch (error) {
      runtime.removed = false
      runtime.state.status = 'error'
      runtime.state.error = error instanceof Error ? error.message : String(error)
      // Cleanup may have removed only some files: retry cancellation rather than resuming them.
      runtime.state.resumable = false
      this.pushUpdate(runtime, false)
      await this.persistNow(runtime)
      throw error
    } finally {
      // A queued one never ran, so no run's end makes room after it.
      this.pump()
    }
  }

  /** Removes a download, cancelling one under way. A finished one's folder stays where it is,
   * unless `trashFile`: then it goes to the Trash, where the user can still get it back. The
   * path is the download's own, never one the window names. */
  async remove(id: string, trashFile = false): Promise<void> {
    await this.initialization
    let runtime = this.runtimes.get(id)
    if (runtime?.state.status === 'completed') {
      // Completion is shown before history is saved. Let that move finish before choosing
      // whether to remove a live runtime or a history entry.
      await runtime.runPromise?.catch(() => {})
      runtime = this.runtimes.get(id)
    }
    if (
      runtime &&
      (runtime.state.status === 'downloading' ||
        runtime.state.status === 'paused' ||
        runtime.state.status === 'queued' ||
        runtime.state.status === 'error')
    ) {
      await this.cancel(id)
    }
    if (runtime) {
      if (trashFile && runtime.state.status === 'completed') await trashDownload(runtime.state)
      this.runtimes.delete(id)
      await this.removePersistedDownload(runtime)
      if (runtime.state.status === 'completed') {
        await removeFromHistory([id])
        this.historyChanged()
      }
      return
    }
    // A finished one, from history.
    const entry = trashFile ? await findInHistory(id) : undefined
    if (entry && !entry.missing) await trashDownload(entry)
    await removeFromHistory([id])
    this.historyChanged()
  }

  /** Shows a download's folder: by the download's own path, never one the window names, and only
   * once it's checked to be there — the window's view of that can be old (moved or deleted
   * since). When it isn't, the window is told to look again, and the history it gets marks it
   * missing. */
  async reveal(id: string): Promise<boolean> {
    const download = this.runtimes.get(id)?.state ?? (await findInHistory(id))
    const path = download?.destinationPath
    if (path && (await pathExists(path).catch(() => false))) {
      shell.showItemInFolder(path)
      return true
    }
    this.historyChanged()
    return false
  }

  /** Opens a download's folder in the file manager. Like reveal, it checks the path first and
   * false means it's no longer there. */
  async open(id: string): Promise<boolean> {
    const download = this.runtimes.get(id)?.state ?? (await findInHistory(id))
    const path = download?.destinationPath
    if (path && (await pathExists(path).catch(() => false))) {
      return (await shell.openPath(path)) === ''
    }
    this.historyChanged()
    return false
  }

  async suspendAll(): Promise<void> {
    await this.initialization
    this.suspending = true
    clearTimeout(this.scheduleTimer)
    await Promise.all(
      [...this.runtimes.values()].map(async (runtime) => {
        if (runtime.state.status === 'downloading')
          await this.pause(runtime.state.id, runtime.state.scheduled === true)
        else {
          if (runtime.scheduleStopping) await runtime.runPromise
          await this.persistNow(runtime)
        }
      })
    )
    await this.limits.save()
  }

  /**
   * Runs the download until every chunk is in, or it is stopped. Each TICK_MS, and whenever a
   * stream ends, it takes stock: speeds, stuck connections, which networks run streams (see
   * reconcile) and how many (see concurrency.ts). With no network to use, it waits for one.
   */
  private async run(runtime: DownloadRuntime): Promise<void> {
    if (runtime.stop.signal.aborted) runtime.stop = new AbortController()
    runtime.transfer.reset()
    // Speeds are this run's: nothing carries over from the last one.
    runtime.meters.clear()
    const { signal } = runtime.stop
    this.reconcile(runtime)
    // One watcher per stream for its whole life. Racing every stream each tick would pile a
    // handler per tick onto each one still running, held until it ends.
    const watched = new WeakSet<Promise<void>>()
    let wake: { resolve: () => void; reject: (error: unknown) => void } | null = null
    let tickedAt = Date.now()
    // Readings carry over a pause, moved up to now: time paused isn't time downloading, so a
    // stretch can run across one, and runs too short for a stretch of their own still count — as
    // they do in AVG, which a reset here let read above PEAK.
    const lastReading = runtime.peakReadings.at(-1)
    const paused = lastReading ? tickedAt - lastReading.time : 0
    runtime.peakReadings = runtime.peakReadings.map((reading) => ({
      time: reading.time + paused,
      bytes: reading.bytes
    }))
    if (runtime.peakReadings.at(-1)?.bytes !== runtime.state.bytesDownloaded) {
      runtime.peakReadings.push({ time: tickedAt, bytes: runtime.state.bytesDownloaded })
    }
    // An install is written in place: what went missing from it since the last run is found
    // before the loop below decides whether anything is left to fetch.
    await runtime.transfer.checkFiles()

    while (runtime.state.status === 'downloading' && runtime.cells.some((cell) => !isDone(cell))) {
      await new Promise<void>((resolve, reject) => {
        wake = { resolve, reject }
        for (const worker of runtime.transfer.running()) {
          if (watched.has(worker)) continue
          watched.add(worker)
          worker.then(
            () => wake?.resolve(),
            (error) => wake?.reject(error)
          )
        }
        void delay(TICK_MS, signal).then(resolve)
      })
      if ((runtime.state.status as DownloadStatus) !== 'downloading') break
      const now = Date.now()
      // The only place speeds are read: on this clock, never as bytes arrive (see Meter).
      const speedsChanged = updateSpeeds(runtime, now)
      const timeLeftChanged = updateTimeLeft(runtime.state, (now - tickedAt) / 1000)
      tickedAt = now
      if (speedsChanged || timeLeftChanged) this.scheduleUpdate(runtime)
      if (now - runtime.speedSampledAt >= 1000) {
        runtime.speedSampledAt = now
        sampleSpeeds(runtime.state)
        samplePeak(runtime, now)
        this.scheduleUpdate(runtime)
      }
      runtime.transfer.tick(now)
    }
    // The last chunks are in, or the run was stopped: its streams wind down. Its last part reads
    // too, up to the moment it stopped (and where the next run picks up).
    samplePeak(runtime, Date.now())
    runtime.stop.abort()
    await Promise.all(runtime.transfer.running())
    // However it ended — paused, failed, cancelled, done — nothing is moving now.
    clearSpeeds(runtime.state)

    if (runtime.state.status !== 'downloading') {
      // Paused, errored, or cancelled — nothing left to do right now. An error keeps what it has
      // unless it can't be resumed (see failDownload); cancel() discards it.
      if (runtime.state.status === 'error') {
        this.pushUpdate(runtime)
        if (runtime.state.resumable === false) await runtime.file.discard()
      }
      return
    }

    runtime.publishing = true
    try {
      if (runtime.cells.some((cell) => !isDone(cell))) {
        throw new Error('Download is incomplete — refusing to publish it')
      }
      await this.persistNow(runtime)
      const publishedPath = await runtime.file.publish(
        runtime.state.destinationPath,
        runtime.state.totalBytes,
        async (candidate) => {
          runtime.publicationPath = candidate
          const folder = await stat(runtime.file.path)
          runtime.publicationIdentity = { dev: folder.dev, ino: folder.ino }
          await this.persistNow(runtime, true)
        }
      )
      runtime.state.destinationPath = publishedPath
      runtime.state.fileName = basename(publishedPath)
      runtime.state.status = 'completed'
      runtime.state.completedAt = Date.now()
      // Done before it downloaded for PEAK_SECONDS: its speed start to finish, pauses left out (the
      // readings close them up), is the best it held.
      const [start] = runtime.peakReadings
      const end = runtime.peakReadings.at(-1)
      const ranFor = start && end ? (end.time - start.time) / 1000 : 0
      if (ranFor > 0) {
        runtime.state.peakSpeedBytesPerSec ??= (end!.bytes - start.bytes) / ranFor
      }
      runtime.state.bytesDownloaded = runtime.state.totalBytes || runtime.state.bytesDownloaded
      await this.persistNow(runtime)
      this.notify('Download complete', `${runtime.state.app.name} is ready to play.`)
    } catch (error) {
      runtime.state.status = 'error'
      runtime.state.error = error instanceof Error ? error.message : String(error)
      this.notify(
        'Download failed',
        `${runtime.state.app.name}: ${describeError(runtime.state.error)}`
      )
    }
    runtime.publishing = false

    this.pushUpdate(runtime)
    if (runtime.state.status === 'completed') await this.moveToHistory(runtime)
  }

  /** Stops the current run: every stream, and the run's own wait. */
  private stopRun(runtime: DownloadRuntime): void {
    runtime.stop.abort()
    runtime.transfer.abort()
  }

  /** Ends the download in an error. What it has downloaded stays for a resume, unless
   * `discard`: bytes that are no use any more. */
  private failDownload(runtime: DownloadRuntime, message: string, discard = false): void {
    if (runtime.state.status !== 'downloading') return
    runtime.state.status = 'error'
    runtime.state.error = message
    runtime.state.resumable = !discard
    this.notify('Download failed', `${runtime.state.app.name}: ${describeError(message)}`)
    this.stopRun(runtime)
  }

  /** The servers keep refusing requests over this network: it stops being used until the user
   * switches it off and on, it reconnects, or the download is resumed. */
  private failNetwork(runtime: DownloadRuntime, network: DownloadNetwork, message: string): void {
    network.status = 'failed'
    network.error = message
    this.reconcile(runtime)
  }

  /**
   * Brings the download's networks up to date with the computer's, and each network's streams in
   * line with what it can do now. Runs every tick and whenever something changes — a network
   * came or went, the user switched one, one stopped getting through — and is safe to run any
   * time.
   *
   * Networks: every one on the computer is listed; one that turns up mid-download starts off,
   * for the user to switch on. A network the download never used is dropped once it goes.
   *
   * Streams, while the download runs, are the transfer's (see SteamTransfer.reconcile).
   */
  private reconcile(runtime: DownloadRuntime): void {
    const { state } = runtime
    const present = this.networks.current
    // Until the monitor has looked, nothing is known to be gone.
    const known = present !== null
    if (known) {
      state.networks = state.networks.filter(
        (network) =>
          network.enabled ||
          network.bytesDownloaded > 0 ||
          present.some((iface) => iface.id === network.id) ||
          state.streams.some((stream) => stream.interfaceId === network.id)
      )
      for (const iface of present) {
        if (!state.networks.some((network) => network.id === iface.id)) {
          state.networks.push(newNetwork(iface, false))
        }
      }
    }

    for (const network of state.networks) {
      const iface = this.networks.find(network.id)
      if (iface) {
        network.label = iface.displayName
        network.kind = iface.kind
      }
      const status: NetworkStatus = !network.enabled
        ? 'off'
        : !iface && known
          ? 'offline'
          : this.limits.limitReached(network.id)
            ? 'limit'
            : network.status === 'off' || network.status === 'offline' || network.status === 'limit'
              ? 'on'
              : network.status
      if (status !== network.status) {
        network.status = status
        network.error = undefined
      }
    }
    if (state.status !== 'downloading' || runtime.stop.signal.aborted) return
    if (!this.scheduleAllowsDownloads()) {
      void this.pause(state.id, true).catch((error) =>
        console.error('[netfuse] schedule cutoff', error)
      )
      return
    }

    const enabled = state.networks.filter((network) => network.enabled)
    if (enabled.length > 0 && enabled.every((network) => network.status === 'failed')) {
      this.failDownload(runtime, enabled[0].error ?? 'No network could reach Steam')
      return
    }

    runtime.transfer.reconcile()
  }

  private notify(title: string, body: string): void {
    if (testKnobs.userDataDir || !Notification.isSupported()) return
    try {
      const notification = new Notification({ title, body })
      notification.on('click', () => {
        const window = this.getWindow()
        if (window && !window.isDestroyed()) {
          if (window.isMinimized()) window.restore()
          window.show()
          window.focus()
        }
      })
      notification.show()
    } catch {
      // Best-effort notification
    }
  }

  private scheduleUpdate(runtime: DownloadRuntime): void {
    if (runtime.pushScheduled) return
    runtime.pushScheduled = true
    setTimeout(() => {
      runtime.pushScheduled = false
      this.pushUpdate(runtime)
    }, UI_UPDATE_MS)
  }

  private pushUpdate(runtime: DownloadRuntime, persist = true): void {
    this.keepAwake()
    // A removed download can still be winding down (workers finishing, cleanup). Its updates
    // would put it back on screen after the renderer has already moved on.
    if (this.runtimes.get(runtime.state.id) !== runtime) return
    if (persist) this.schedulePersistence(runtime)
    const window = this.getWindow()
    if (!window || window.isDestroyed()) return
    if (runtime.state.status === 'paused' || runtime.state.status === 'cancelled') {
      clearSpeeds(runtime.state)
    }
    window.webContents.send(IpcChannels.downloadUpdated, this.takeUpdate(runtime))
  }

  /** What the window hasn't been sent yet: the download's state, and the cells that moved. */
  private takeUpdate(runtime: DownloadRuntime): DownloadUpdate {
    const sent = runtime.sentUnits
    const changed: DownloadUnitState[] = []
    for (const cell of runtime.cells) {
      const last = sent[cell.index]
      if (
        last?.status === cell.status &&
        last.interfaceId === cell.interfaceId &&
        last.bytesDownloaded === cell.bytesDownloaded
      ) {
        continue
      }
      sent[cell.index] = {
        status: cell.status,
        interfaceId: cell.interfaceId,
        bytesDownloaded: cell.bytesDownloaded
      }
      changed.push(cell)
    }
    const { cells: omittedCells, ...state } = runtime.state
    void omittedCells
    return structuredClone({ seq: ++runtime.sentUpdates, state, cells: changed })
  }

  private schedulePersistence(runtime: DownloadRuntime): void {
    if (this.suspending || runtime.removed || runtime.persistenceTimer || runtime.checkpointQueued)
      return
    runtime.persistenceTimer = setTimeout(() => {
      runtime.persistenceTimer = undefined
      // One running and one waiting at most, however slow the disk: the waiting one takes the
      // state when its turn comes, so nothing scheduled meanwhile is lost.
      runtime.checkpointQueued = true
      void this.persistNow(runtime, false, true)
    }, CHECKPOINT_INTERVAL_MS)
  }

  private persistNow(
    runtime: DownloadRuntime,
    required = false,
    routineCheckpoint = false
  ): Promise<void> {
    if (runtime.removed) return runtime.persistenceChain
    if (runtime.persistenceTimer) {
      clearTimeout(runtime.persistenceTimer)
      runtime.persistenceTimer = undefined
    }

    const operation = runtime.persistenceChain
      .catch(() => {})
      .then(async () => {
        // An explicit save can run ahead of a queued routine checkpoint. Only that
        // checkpoint owns the flag; other saves must leave its place reserved.
        if (routineCheckpoint) runtime.checkpointQueued = false
        if (runtime.removed) return
        const dir = this.downloadDir(runtime.state.id)
        const path = this.manifestPath(runtime.state.id)
        const temporaryPath = `${path}.tmp`
        const { cells: omittedCells, streams: omittedStreams, ...state } = runtime.state
        void omittedCells
        void omittedStreams
        // Taken before the sync below: a chunk done meanwhile is saved at the next checkpoint,
        // never ahead of its data.
        const persisted: PersistedDownload = {
          version: 1,
          savedAt: Date.now(),
          state: structuredClone(state),
          partialPath: runtime.file.path,
          publicationPath: runtime.publicationPath,
          publicationIdentity: runtime.publicationIdentity,
          requestPayload: runtime.requestPayload,
          steam: {
            chunks: runtime.book.save(),
            created: [...runtime.file.created],
            units:
              runtime.units.length === runtime.layout.units.length
                ? undefined
                : encodeUnits(runtime.units)
          }
        }
        // A download saved with an error is resumed from what it saved, with no check of what is
        // on disk (see SteamTransfer): its chunks are synced too, unless it can't be resumed.
        const resumable =
          ['downloading', 'paused', 'queued'].includes(runtime.state.status) ||
          (runtime.state.status === 'error' && runtime.state.resumable !== false)
        if (resumable) await runtime.file.sync()
        await ensureDirectory(dir)
        await writeFile(temporaryPath, JSON.stringify(persisted), 'utf-8')
        await rename(temporaryPath, path)
      })
    runtime.persistenceChain = operation.catch(() => {
      // Routine progress checkpoints are best-effort. Publication intent is required.
    })
    return required ? operation : runtime.persistenceChain
  }

  private async removePersistedDownload(
    runtime: DownloadRuntime,
    discardPartial = true
  ): Promise<void> {
    runtime.removed = true
    if (runtime.persistenceTimer) clearTimeout(runtime.persistenceTimer)
    await runtime.persistenceChain.catch(() => {})
    // A finished download is the user's now: only an unfinished one's install goes.
    if (discardPartial && runtime.state.status !== 'completed') {
      await runtime.file.discard().catch(() => {})
    }
    await rm(this.downloadDir(runtime.state.id), { recursive: true, force: true })
  }
}
