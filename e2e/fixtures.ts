import type {} from '../src/preload/globals'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import {
  _electron as electron,
  expect,
  test as base,
  type ElectronApplication,
  type Page
} from '@playwright/test'
import type { IpcContract } from '../src/shared/ipc-contract'
import { applyDownloadUpdate } from '../src/shared/downloadUpdate'
import type {
  DownloadState,
  DownloadStatus,
  DownloadUpdate,
  SteamDownloadState
} from '../src/shared/types'
import { sha256 } from './steamContent'
import {
  ACCOUNT,
  GUARD_CODE,
  OWNED_DEPOTS,
  SteamOrigin,
  type SteamAppFixture,
  type SteamOriginOptions
} from './steamOrigin'

export { expect }

export function expectSteam(state: DownloadState): SteamDownloadState {
  expect(state.kind).toBe('steam')
  if (state.kind !== 'steam') throw new Error('Expected a Steam download')
  return state
}

export const PROJECT_ROOT = resolve(__dirname, '..')

/** Every raw Electron launch needs the same CI sandbox policy. */
export function electronArgs(entry: string, args: string[] = []): string[] {
  return [entry, ...args, ...(process.platform === 'linux' ? ['--no-sandbox'] : [])]
}

/**
 * The second test "network": this machine's LAN address. A request bound to it still reaches
 * the loopback fake Steam, but arrives from a different source address — which is how the
 * content servers tell the two networks apart. Found (and checked to work) by global-setup.ts; null
 * where there's no usable one, and the multi-network tests skip.
 */
export const LAN_ADDRESS = process.env.NETFUSE_E2E_LAN || null

export const NETWORKS = LAN_ADDRESS
  ? { a: '127.0.0.1', b: LAN_ADDRESS }
  : ({ a: '127.0.0.1' } as Record<string, string>)

export function interfacesEnv(networks: Record<string, string>): string {
  return Object.entries(networks)
    .map(([id, address]) => `${id}=${address}`)
    .join(',')
}

type Api = {
  [K in keyof IpcContract]: (...args: IpcContract[K]['args']) => Promise<IpcContract[K]['result']>
}

interface SteamStartOptions {
  depots?: number[]
  networks?: string[]
  /** Streams per network, fixed so a test can count requests; 'auto' lets the app decide. */
  connections?: number | 'auto'
  destinationDir?: string
  /** Install into the existing folder named after the game. */
  adopt?: boolean
}

interface Tracked {
  expectedSha: string
  /** Files already in the destination folder before this download started. */
  destBefore: string[]
  destinationDir: string
}

/**
 * Drives one NetFuse instance through the same `window.netfuse` API the renderer uses — nothing
 * below this reaches into the main process's internals, so refactoring them can't break a test
 * that still describes correct behavior.
 */
export class NetFuseApp {
  electronApp!: ElectronApplication
  page!: Page
  /** Every downloadUpdated state, one array per app launch (a relaunch starts a new one). */
  readonly sessions: DownloadState[][] = []
  /** The same, as the window was sent them: only the cells that changed. */
  readonly updates: DownloadUpdate[][] = []
  readonly tracked = new Map<string, Tracked>()
  readonly output: string[] = []
  alive = false

  constructor(
    readonly dirs: { userData: string; dest: string },
    private extraEnv: Record<string, string> = {}
  ) {}

  /** `args` follow the app on its command line. */
  async launch(extraEnv: Record<string, string> = {}, args: string[] = []): Promise<this> {
    Object.assign(this.extraEnv, extraEnv)
    let retries = 5
    while (true) {
      try {
        this.electronApp = await electron.launch({
          args: electronArgs(PROJECT_ROOT, args),
          env: {
            ...(process.env as Record<string, string>),
            NETFUSE_USER_DATA: this.dirs.userData,
            NETFUSE_E2E_HIDE_WINDOW: '1',
            NETFUSE_E2E_RETRY_BASE_MS: '20',
            NETFUSE_E2E_STALL_MS: '1500',
            // A busy server gives up after its retries alone, as any other wrong answer does,
            // unless a test waits it out on purpose.
            NETFUSE_E2E_SERVER_BUSY_MS: '1',
            // Off unless a test asks for it: a hedge is an extra request, and most tests count them.
            NETFUSE_E2E_HEDGE_MS: '600000',
            // Fixed for the same reason, and for downloads started through the UI.
            NETFUSE_E2E_STREAMS: '2',
            NETFUSE_E2E_INTERFACES: interfacesEnv(NETWORKS),
            ...this.extraEnv
          }
        })
        break
      } catch (e: unknown) {
        if (retries-- > 0 && e instanceof Error && e.message?.includes('ETXTBSY')) {
          await new Promise((resolve) => setTimeout(resolve, 100))
          continue
        }
        throw e
      }
    }
    const child = this.electronApp.process()
    child.stdout?.on('data', (data) => this.output.push(String(data)))
    child.stderr?.on('data', (data) => this.output.push(String(data)))
    this.alive = true

    this.page = await this.electronApp.firstWindow()
    await this.page.waitForLoadState('domcontentloaded')
    const session: DownloadState[] = []
    const updates: DownloadUpdate[] = []
    this.sessions.push(session)
    this.updates.push(updates)
    // Kept whole, the way the window puts them together: each download from its own last state.
    const latest = new Map<string, DownloadState>()
    await this.page.exposeFunction('__netfuseRecord', (update: DownloadUpdate) => {
      updates.push(update)
      const previous = latest.get(update.state.id) ?? null
      const state = applyDownloadUpdate(previous, update)
      if (state && state !== previous) {
        latest.set(state.id, state)
        session.push(state)
      }
    })
    await this.page.evaluate(() => {
      const w = window as unknown as { __netfuseRecord: (s: unknown) => void }
      window.netfuse.onDownloadUpdated((update) => w.__netfuseRecord(update))
    })
    return this
  }

  /** Kills the main process outright — no before-quit, no suspend: a crash or power cut. */
  async kill(): Promise<void> {
    const child = this.electronApp.process()
    if (child.exitCode !== null || child.signalCode !== null) {
      this.alive = false
      return
    }
    // Windows does not propagate killing the main process to Chromium's children. They retain
    // the profile lock and open databases, preventing both relaunch and fixture disposal.
    const closed = new Promise<void>((resolve) => child.once('close', () => resolve()))
    if (process.platform === 'win32') {
      await promisify(execFile)('taskkill', ['/pid', String(child.pid), '/T', '/F'])
    } else {
      child.kill('SIGKILL')
    }
    await closed
    this.alive = false
  }

  /** Normal quit — runs before-quit, which suspends (pauses and persists) the download. */
  async quit(): Promise<void> {
    await this.electronApp.close()
    this.alive = false
  }

  async relaunch(extraEnv: Record<string, string> = {}): Promise<this> {
    if (this.alive) await this.quit()
    return this.launch(extraEnv)
  }

  api: Api = new Proxy({} as Api, {
    get:
      (_target, name: string) =>
      (...args: unknown[]) =>
        this.page.evaluate(
          ([method, params]) =>
            (window.netfuse as unknown as Record<string, (...a: unknown[]) => unknown>)[method](
              ...params
            ),
          [name, args] as const
        )
  })

  /** Main-process code, e.g. to replace a dialog or make a network disappear. */
  evaluateMain<R, A>(fn: (electron: typeof import('electron'), arg: A) => R, arg: A): Promise<R> {
    return this.electronApp.evaluate(fn as never, arg) as Promise<R>
  }

  /** Sets how many streams the next download runs per network (see StartOptions). */
  private async pinStreams(connections: number | 'auto' = 2): Promise<void> {
    await this.evaluateMain(
      (_electron, value) => {
        if (value === null) delete process.env.NETFUSE_E2E_STREAMS
        else process.env.NETFUSE_E2E_STREAMS = value
      },
      connections === 'auto' ? null : String(connections)
    )
  }

  /** Points the app at `steam` for Steam itself, for this launch and the next. */
  async useSteam(steam: SteamOrigin): Promise<void> {
    this.extraEnv.NETFUSE_E2E_STEAM = steam.url
    await this.evaluateMain((_electron, url) => {
      process.env.NETFUSE_E2E_STEAM = url
    }, steam.url)
  }

  /** Logs in to the fake Steam with the test account, typing the Steam Guard code if asked. */
  async loginSteam(): Promise<void> {
    await this.api.steamLogin({
      method: 'credentials',
      accountName: ACCOUNT.name,
      password: ACCOUNT.password,
      remember: false
    })
    const deadline = Date.now() + 10_000
    while (Date.now() < deadline) {
      const state = await this.api.steamLoginState()
      if (state.status === 'logged-in') return
      if (state.status === 'awaiting-code') await this.api.steamSubmitCode(GUARD_CODE)
      if (state.status === 'logged-out') {
        throw new Error(`Steam login failed: ${state.error ?? 'logged out'}`)
      }
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    throw new Error('Steam login timed out')
  }

  /** Plans and starts a Steam download of `steam`'s app as the Steam dialog does, logging in
   * first if need be. */
  async startSteam(steam: SteamOrigin, options: SteamStartOptions = {}): Promise<string> {
    await this.pinStreams(options.connections)
    if ((await this.api.steamLoginState()).status !== 'logged-in') await this.loginSteam()
    await this.api.listInterfaces()
    const depots = options.depots ?? OWNED_DEPOTS
    const destinationDir = options.destinationDir ?? this.dirs.dest
    const destBefore = existsSync(destinationDir) ? await readdir(destinationDir) : []
    const plan = await this.api.steamPrepare({
      appId: steam.app.appId,
      branch: 'public',
      depotIds: depots,
      destinationDir,
      adopt: options.adopt ?? false
    })
    const id = await this.api.startDownload({
      kind: 'steam',
      planId: plan.planId,
      interfaceIds: options.networks ?? ['a']
    })
    this.tracked.set(id, { expectedSha: steam.expectedSha(depots), destBefore, destinationDir })
    return id
  }

  async waitForSteamStatus(
    status: DownloadStatus | DownloadStatus[],
    timeout = 20_000
  ): Promise<SteamDownloadState> {
    return expectSteam(await this.waitForStatus(status, timeout))
  }

  /** For downloads started through the UI rather than startSteam(): declares what the next one
   * should produce, so the automatic checks can verify it. Call before clicking Download. */
  async expectNextDownload(expectedSha: string): Promise<void> {
    this.nextDownload = {
      expectedSha,
      destBefore: await readdir(this.dirs.dest),
      destinationDir: this.dirs.dest
    }
  }

  nextDownload: Tracked | null = null

  /** Every download, running or finished, oldest first. A finished one comes from history, so it
   * has no cells left. */
  async all(): Promise<DownloadState[]> {
    const running = (await this.api.listDownloads()).map((snapshot) =>
      applyDownloadUpdate(null, snapshot)!
    )
    // As the window was last sent it, when this launch saw it finish: cells and all.
    const seen = this.sessions.at(-1) ?? []
    const finished = (await this.api.listHistory()).map((entry): DownloadState => {
      const last = seen.findLast((state) => state.id === entry.id)
      if (last?.status === 'completed') return last
      return { ...entry, cells: [], streams: [] }
    })
    // One that finished between the two calls is in both: history has its final state.
    const done = new Set(finished.map((state) => state.id))
    return [...running.filter((state) => !done.has(state.id)), ...finished].sort(
      (a, b) => a.startedAt - b.startedAt
    )
  }

  /** The download started last. */
  async current(): Promise<DownloadState | null> {
    return (await this.all()).at(-1) ?? null
  }

  /** One download by id, wherever it is. */
  async byId(id: string): Promise<DownloadState | null> {
    return (await this.all()).find((state) => state.id === id) ?? null
  }

  async waitForStatus(
    status: DownloadStatus | DownloadStatus[],
    timeout = 20_000
  ): Promise<DownloadState> {
    const wanted = Array.isArray(status) ? status : [status]
    return this.waitUntil((state) => wanted.includes(state.status), timeout)
  }

  /** Waits until the download state matches `predicate`. A timeout says what the state was
   * instead, so a hang shows the last progress and state. */
  async waitUntil(
    predicate: (state: DownloadState) => boolean,
    timeout = 20_000
  ): Promise<DownloadState> {
    const deadline = Date.now() + timeout
    let state: DownloadState | null = null
    while (Date.now() < deadline) {
      state = await this.current()
      if (state && predicate(state)) return state
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    const networks = state?.networks.map(
      (network) => `${network.id}:${network.status}${network.error ? ` (${network.error})` : ''}`
    )
    const connections = state?.streams.map(
      (connection) => `${connection.interfaceId}:${connection.status}`
    )
    throw new Error(
      `Timed out after ${timeout} ms waiting on the download. Last seen: ${
        state
          ? `status=${state.status}${state.error ? `, error="${state.error}"` : ''}, bytes=${state.bytesDownloaded}/${state.totalBytes}, networks=[${networks?.join(', ')}], connections=[${connections?.join(', ')}]`
          : 'no current download'
      }`
    )
  }
}

// --- invariants --------------------------------------------------------------------------------

const ALLOWED_NEXT: Record<DownloadStatus, DownloadStatus[]> = {
  queued: ['queued', 'downloading', 'paused', 'cancelled'],
  downloading: ['downloading', 'queued', 'paused', 'completed', 'error', 'cancelled'],
  // Resumed: at once, or into the queue when it's full.
  paused: ['paused', 'downloading', 'queued', 'error', 'cancelled'],
  completed: ['completed'],
  // Resumed, or removed by the user.
  error: ['error', 'downloading', 'queued', 'cancelled'],
  cancelled: ['cancelled']
}

/** Rules every download event must satisfy, whatever the scenario. Node assertions keep this
 * exhaustive scan synchronous without creating a report step for every cell of every event.
 * Failures still carry the download, status and cell context. */
export function checkEvents(sessions: DownloadState[][]): void {
  for (const events of sessions) {
    const lastStatus = new Map<string, DownloadStatus>()
    for (const state of events) {
      const label = `${state.id} @ ${state.status}`
      if (state.totalBytes > 0) {
        assert.ok(
          state.bytesDownloaded <= state.totalBytes,
          `${label}: bytesDownloaded ≤ totalBytes`
        )
      }
      const cells = state.cells
      assert.equal(
        cells.every((cell, index) => cell.index === index),
        true,
        `${label}: every cell is there, in order`
      )
      assert.equal(cells.length, state.totalCells, `${label}: as many cells as planned`)
      for (const cell of cells) {
        const attributed = Object.values(cell.bytesByInterface).reduce((a, b) => a + b, 0)
        assert.equal(
          attributed,
          cell.bytesDownloaded,
          `${label}: cell ${cell.index} attribution sums to its bytes`
        )
        if (cell.rangeEnd !== null) {
          const size = cell.rangeEnd - cell.rangeStart + 1
          assert.ok(cell.bytesDownloaded <= size, `${label}: cell ${cell.index} within its size`)
          if (cell.status === 'completed') {
            assert.equal(
              cell.bytesDownloaded,
              size,
              `${label}: completed cell ${cell.index} is full`
            )
          }
        }
      }
      checkSteamEvent(state, label)
      const previous = lastStatus.get(state.id)
      if (previous) {
        assert.ok(
          ALLOWED_NEXT[previous].includes(state.status),
          `${state.id}: ${previous} → ${state.status}`
        )
      }
      lastStatus.set(state.id, state.status)
    }
  }
}

/** A download's streams are on its networks and hold a grid cell exactly while fetching, and its
 * byte counts agree everywhere they are shown. */
function checkSteamEvent(state: SteamDownloadState, label: string): void {
  const networks = new Set(state.networks.map((network) => network.id))
  assert.equal(
    new Set(state.streams.map((stream) => stream.id)).size,
    state.streams.length,
    `${label}: stream IDs are unique across networks`
  )
  for (const stream of state.streams) {
    assert.ok(networks.has(stream.interfaceId), `${label}: stream ${stream.id} is on a network`)
    assert.equal(
      stream.currentCellIndex !== undefined,
      stream.status === 'downloading',
      `${label}: stream ${stream.id} (${stream.status}) holds a cell`
    )
    if (stream.currentCellIndex !== undefined && !stream.hedge) {
      assert.equal(
        state.cells[stream.currentCellIndex]?.status,
        'downloading',
        `${label}: held cell ${stream.currentCellIndex} is in flight`
      )
    }
  }
  const inCells = state.cells.reduce((sum, cell) => sum + cell.bytesDownloaded, 0)
  const byNetworks = state.networks.reduce((sum, network) => sum + network.bytesDownloaded, 0)
  assert.equal(inCells, state.bytesDownloaded, `${label}: the cells add up to the download`)
  assert.equal(byNetworks, state.bytesDownloaded, `${label}: the networks add up to the download`)
  assert.ok(state.chunksDone <= state.totalChunks, `${label}: chunksDone ≤ totalChunks`)
  if (state.status === 'completed') {
    assert.ok(
      state.cells.every((cell) => cell.status === 'completed'),
      `${label}: a completed download has every cell done`
    )
    assert.equal(state.chunksDone, state.totalChunks, `${label}: every chunk is done`)
  }
  if (state.phase === 'preparing') {
    assert.ok(
      state.streams.every((stream) => stream.status !== 'downloading'),
      `${label}: nothing is fetched while preparing`
    )
  }
}

/** A folder's files as one hash: each file's path (relative, with `/`) and the SHA-256 of its
 * bytes, in path order. What an install is checked against. */
export function treeSha(files: { path: string; data: Buffer }[]): string {
  const lines = files
    .map((file) => `${file.path}\0${sha256(file.data)}\n`)
    .sort()
    .join('')
  return sha256(Buffer.from(lines))
}

/** sha256 of a file, or treeSha of a folder. */
export async function shaOfPath(path: string): Promise<string> {
  if (!(await stat(path)).isDirectory()) return sha256(await readFile(path))
  const entries = await readdir(path, { recursive: true, withFileTypes: true })
  const files = await Promise.all(
    entries
      .filter((entry) => entry.isFile())
      .map(async (entry) => {
        const full = join(entry.parentPath, entry.name)
        return { path: relative(path, full).split(sep).join('/'), data: await readFile(full) }
      })
  )
  return treeSha(files)
}

async function openFilesUnder(pid: number, roots: string[]): Promise<string[]> {
  try {
    const { stdout } = await promisify(execFile)('lsof', ['-Fn', '-p', String(pid)])
    return stdout
      .split('\n')
      .filter((line) => line.startsWith('n'))
      .map((line) => line.slice(1))
      .filter((path) => roots.some((root) => path.startsWith(root)))
  } catch {
    return [] // lsof missing — skip this check rather than fail on it
  }
}

/**
 * The end-of-test rules: once a download has finished (either way), what's on disk must be
 * exactly right. The one that matters most: `completed` never means wrong bytes.
 */
export async function checkFinalState(app: NetFuseApp): Promise<void> {
  const states = await app.all()
  const latest = states.at(-1)
  const checked = states.flatMap((state) => {
    const tracked = app.tracked.get(state.id) ?? (state === latest ? app.nextDownload : null)
    return tracked ? [{ state, tracked }] : []
  })
  // Any still under way: there's no final state to check yet.
  const terminal = (status: DownloadStatus): boolean =>
    ['completed', 'error', 'cancelled'].includes(status)
  if (checked.length === 0 || !checked.every(({ state }) => terminal(state.status))) return

  for (const { state, tracked } of checked) {
    // A failed download keeps its progress to be resumed until the user moves on: after that,
    // nothing of it may be left.
    if (state.status === 'error') await app.api.removeDownload(state.id)

    if (state.status === 'completed') {
      expect(await shaOfPath(state.destinationPath), 'completed download matches its source').toBe(
        tracked.expectedSha
      )
    } else if (state.adopted) {
      // Installed into a folder that was there before: it stays, whatever happens to the download.
      expect(existsSync(state.destinationPath), 'the existing folder is left').toBe(true)
    } else {
      expect(existsSync(state.destinationPath), 'no install left at the destination').toBe(false)
    }
  }

  // Each folder gains exactly the downloads that completed into it, and nothing else.
  for (const destinationDir of new Set(checked.map(({ tracked }) => tracked.destinationDir))) {
    const into = checked.filter(({ tracked }) => tracked.destinationDir === destinationDir)
    // As the folder was before the first of them started (later ones saw the earlier ones' files).
    const before = new Set(into[0].tracked.destBefore)
    const destAfter = existsSync(destinationDir) ? await readdir(destinationDir) : []
    const added = destAfter.filter((name) => !before.has(name)).sort()
    // A Steam install into an existing folder adds no name of its own (nor does a second
    // install into the folder an earlier one made).
    const expectedAdded = [
      ...new Set(
        into
          .filter(({ state }) => state.status === 'completed')
          .map(({ state }) => state.destinationPath.split(/[\\/]/).pop()!)
          .filter((name) => !before.has(name))
      )
    ].sort()
    expect(added, 'no stray files or folders in the destination folder').toEqual(expectedAdded)
  }

  const pid = app.electronApp.process().pid
  if (pid) {
    await expect
      .poll(() => openFilesUnder(pid, [app.dirs.dest, join(app.dirs.userData, 'downloads')]), {
        message: 'no file handles left open on download files',
        timeout: 5000
      })
      .toEqual([])
  }
}

// --- fixtures ----------------------------------------------------------------------------------

/** A fresh userData + destination folder pair under the OS temp directory. */
export async function makeDirs(): Promise<{
  dirs: { userData: string; dest: string }
  dispose: () => Promise<void>
}> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'netfuse-e2e-')))
  const dirs = { userData: join(root, 'userData'), dest: join(root, 'dest') }
  await Promise.all([mkdir(dirs.userData), mkdir(dirs.dest)])
  return { dirs, dispose: () => rm(root, { recursive: true, force: true, maxRetries: 5 }) }
}

interface Fixtures {
  /** Extra environment for the app, e.g. `test.use({ appEnv: { NETFUSE_E2E_RETRY_BASE_MS: '2000' } })`. */
  appEnv: Record<string, string>
  dirs: { userData: string; dest: string }
  /** Starts a fake Steam and points the app at it; stopped after the test. */
  serveSteam: (app?: SteamAppFixture, options?: SteamOriginOptions) => Promise<SteamOrigin>
  netfuse: NetFuseApp
  checks: void
}

export const test = base.extend<Fixtures>({
  appEnv: [{}, { option: true }],

  // eslint-disable-next-line no-empty-pattern
  dirs: async ({}, use) => {
    const { dirs, dispose } = await makeDirs()
    await use(dirs)
    await dispose()
  },

  serveSteam: async ({ netfuse }, use, testInfo) => {
    const origins: SteamOrigin[] = []
    await use(async (app, options) => {
      const steam = await new SteamOrigin(app, options).start()
      origins.push(steam)
      await netfuse.useSteam(steam)
      return steam
    })
    if (testInfo.status !== testInfo.expectedStatus) {
      const log = origins.map((origin) => origin.log)
      await testInfo.attach('steam-requests.json', { body: JSON.stringify(log, null, 2) })
    }
    await Promise.all(origins.map((origin) => origin.stop()))
  },

  netfuse: async ({ dirs, appEnv }, use, testInfo) => {
    const app = new NetFuseApp(dirs, { ...appEnv })
    await app.launch()
    await use(app)
    if (testInfo.status !== testInfo.expectedStatus) {
      await testInfo.attach('download-events.json', {
        body: JSON.stringify(app.sessions, null, 2)
      })
      await testInfo.attach('app-output.txt', { body: app.output.join('') })
    }
    if (app.alive) await app.electronApp.close().catch(() => {})
  },

  checks: [
    async ({ netfuse }, use, testInfo) => {
      await use()
      // A test already failing (or expected to fail) has said what it needed to.
      if (testInfo.status !== 'passed' || testInfo.expectedStatus !== 'passed') return
      checkEvents(netfuse.sessions)
      // Listeners piling up on one stream or emitter: harmless today, a leak tomorrow.
      expect(netfuse.output.join(''), 'the app warned of a listener leak').not.toContain(
        'MaxListenersExceededWarning'
      )
      if (netfuse.alive) await checkFinalState(netfuse)
    },
    { auto: true }
  ]
})
