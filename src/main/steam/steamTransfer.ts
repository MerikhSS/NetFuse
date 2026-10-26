import type {
  DownloadNetwork,
  DownloadStatus,
  NetworkStatus,
  SteamStreamState
} from '../../shared/types'
import { HttpStatusError } from '../download/httpStatus'
import {
  ConcurrencyController,
  DISK_PATIENCE_MS,
  DISK_RECOVER_MS,
  DiskWatch,
  type Action,
  type Snapshot
} from '../download/concurrency'
import { interleave, MAX_STREAMS_PER_NETWORK, startingStreams } from '../download/plan'
import {
  delay,
  recomputeAggregates,
  type SteamTransferTarget,
  type Transfer,
  type TransferHost
} from '../download/transfer'
import { ConnectionError, NoCompatibleRouteError, StreamConnection } from '../network/routes'
import { testKnobs, testStreamsPerNetwork } from '../testKnobs'
import { SteamLoginRequiredError, type SteamAccount } from './account'
import { SteamRefusedError, type SteamSession } from './backend'
import type { ChunkBook } from './cells'
import { ChunkError } from './chunkCodec'
import { BodySizeError, fetchBody } from './chunkFetch'
import { EResult, eresultOf, loginExpired } from './eresult'
import type { SteamLayout } from './layout'
import { redactedMessage } from './redact'
import { SteamScheduler, type SteamPickContext, type SteamSchedulerPolicy } from './scheduler'
import { chunkUrl, rankServers, ServerPool, TokenCache, type ContentServer } from './servers'
import type { SteamDestination } from './steamDestination'
import type { ChunkWorkerPool } from './workerPool'

// Fetches a Steam download: streams, each one connection to a content server through one network,
// taking chunks from the scheduler (scheduler.ts), checking each in a worker thread (decrypted,
// decompressed, its SHA-1 against the manifest) and only then writing it to every place it goes.
// How many streams a network runs is concurrency.ts's. A network that can't get through is found
// out by its silence, a busy server is waited out as long as it asks, and a failure is told from a
// network's from a server's. A chunk is all or nothing: it is encrypted as a whole, so nothing of
// it is kept until all of it has come in and checked out.
//
// A run starts by making sure of what it needs from Steam itself (a login, the depot keys, the
// content server list) and of the install's files and folders; its streams start once that is done.

export interface SteamTransferServices {
  account: SteamAccount
  workers: ChunkWorkerPool
}

export interface SteamTransferParts {
  file: SteamDestination
  layout: SteamLayout
  book: ChunkBook
  /** For each of the book's chunks, its unit in the layout. */
  units: Uint32Array
}

type AbortReason = 'refresh' | 'lost'

interface Attempt {
  chunk: number
  kind: 'primary' | 'hedge'
  server: ContentServer
  abort: AbortController
  reason: AbortReason | null
  received: number
  startedAt: number
}

type Outcome =
  | { type: 'completed' }
  | { type: 'stopped' }
  | { type: 'aborted'; reason: AbortReason }
  | { type: 'failed'; error: unknown }

interface Stream {
  controller: AbortController
  wait: AbortSignal
  nudge: AbortController
  connection: StreamConnection
  attempt: Attempt | null
  /** Speed of its last finished chunk; 0 until it has one. */
  lastSpeed: number
  receivedBytes: number
  failures: number
  /** Answers from servers that were wrong (not a connection failing): enough in a row and the
   * stream gives up, and once every stream of its network has, so does the network. */
  strikes: number
  busySince: number | null
  refused: boolean
  served: boolean
  retiring: boolean
}

interface RunContext {
  session: SteamSession
  keys: Map<number, Buffer>
  servers: ServerPool
  tokens: TokenCache
}

const debug: (...args: unknown[]) => void = process.env['NETFUSE_DEBUG']
  ? (...args) => console.debug('[netfuse steam]', ...args)
  : () => {}

/** How long a run waits for the Steam login (the stored one, after a restart) before giving up. */
const LOGIN_WAIT_MS = 30_000
const MAX_STRIKES = 8
const RETRY_BASE_DELAY_MS = testKnobs.retryBaseDelayMs
const RETRY_MAX_DELAY_MS = 15_000
const UNREACHABLE_RETRY_MS = 5_000
const SERVER_BUSY_FOR_MS = testKnobs.serverBusyForMs
const RETRY_AFTER_MAX_MS = 120_000
const SILENT_AFTER_MS = testKnobs.silentAfterMs
const IDLE_POLL_MS = 250
/** A chunk every server sends damaged copies of can't be had: the download stops rather than
 * fetching it forever. */
const DAMAGED_SERVERS_TO_FAIL = 3
/** Twice the largest chunk: no chunk's body is bigger. */
const MAX_CHUNK_BODY = 32 * 1024 * 1024
const SCHEDULER_POLICY: SteamSchedulerPolicy = {
  hedgeAfterMs: testKnobs.hedgeAfterMs,
  maxHedgesPerChunk: 1,
  startupMs: 1000
}

function retryDelayMs(attempt: number): number {
  const exact = Math.min(RETRY_BASE_DELAY_MS * 2 ** (attempt - 1), RETRY_MAX_DELAY_MS)
  return exact * (0.8 + 0.4 * Math.random())
}

const isDiskError = (error: unknown): boolean =>
  ['ENOSPC', 'EDQUOT', 'EACCES', 'EPERM', 'EROFS', 'EIO', 'ENOENT', 'EISDIR', 'EMFILE'].includes(
    (error as NodeJS.ErrnoException)?.code ?? ''
  )

export class SteamTransfer implements Transfer {
  readonly scheduler: SteamScheduler
  private readonly streams = new Map<number, Stream>()
  private readonly workers = new Map<number, Promise<void>>()
  private setup: Promise<void> | null = null
  /** This run's files are checked (see checkFiles): its setup, and so its streams, wait for it. */
  private filesChecked = false
  private ready: RunContext | null = null
  private readonly reconciled = new Map<string, NetworkStatus>()
  private readonly traffic = new Map<string, { received: number; aliveAt: number }>()
  /** By network and server host: until when the server asked not to be sent requests. */
  private readonly holdUntil = new Map<string, number>()
  /** By chunk: the servers that sent a copy of it that didn't check out. */
  private readonly damagedBy = new Map<number, Set<string>>()
  /** By chunk: a server to ask it of last, having not had it or sent it damaged. */
  private readonly avoidServer = new Map<number, string>()
  /** Servers that turned a request down without a CDN token: they get one from then on. */
  private readonly needsToken = new Set<string>()
  private readonly concurrency: ConcurrencyController | null
  private readonly disk = new DiskWatch()

  constructor(
    private readonly runtime: SteamTransferTarget,
    private readonly host: TransferHost,
    private readonly parts: SteamTransferParts,
    private readonly services: SteamTransferServices
  ) {
    const { book } = parts
    this.scheduler = new SteamScheduler(
      book.count,
      (chunk) => book.isDone(chunk),
      book.sizes,
      SCHEDULER_POLICY
    )
    const picked = this.pickedStreams()
    this.concurrency =
      testStreamsPerNetwork() !== null
        ? null
        : picked === undefined
          ? new ConcurrencyController(MAX_STREAMS_PER_NETWORK, true, (networkId) =>
              Math.floor(MAX_STREAMS_PER_NETWORK / Math.max(1, host.downloadsOn(networkId)))
            )
          : new ConcurrencyController(picked, false)
  }

  private pickedStreams(): number | undefined {
    const picked = this.runtime.requestPayload.streamsPerNetwork
    return Number.isInteger(picked) && picked! >= 1 && picked! <= MAX_STREAMS_PER_NETWORK
      ? picked
      : undefined
  }

  // --- the run's setup ---------------------------------------------------------------------------

  /**
   * Makes sure of the install's files and folders before a run decides what is left to fetch:
   * chunks written to a file that has gone missing since (or changed size) count for nothing,
   * and are fetched again. Needs no Steam login, so a download that has every chunk can finish
   * without one. A failure fails the download, resumably.
   */
  async checkFiles(): Promise<void> {
    const { state } = this.runtime
    state.phase = 'preparing'
    this.host.scheduleUpdate()
    try {
      const remade = await this.parts.file.prepare()
      if (remade.size > 0) this.forgetChunksIn(remade)
      this.filesChecked = true
    } catch (error) {
      if (this.runtime.stop.signal.aborted) return
      this.host.failDownload(redactedMessage(error))
    } finally {
      state.phase = undefined
      this.host.scheduleUpdate()
    }
    this.host.reconcile()
  }

  /** What a run needs from Steam before its streams start: a login, the depot keys and content
   * servers. A failure fails the download, resumably. */
  private async prepareRun(): Promise<void> {
    const stop = this.runtime.stop.signal
    const { state, requestPayload } = this.runtime
    state.phase = 'preparing'
    this.host.scheduleUpdate()
    try {
      const session = await this.services.account.current(LOGIN_WAIT_MS)
      if (stop.aborted) return
      const keys = new Map<number, Buffer>()
      for (const depot of requestPayload.depots) {
        keys.set(depot.depotId, await session.depotKey(requestPayload.appId, depot.depotId))
        if (stop.aborted) return
      }
      const servers = new ServerPool(
        rankServers(await session.contentServers(requestPayload.appId), requestPayload.appId)
      )
      if (stop.aborted) return
      this.ready = {
        session,
        keys,
        servers,
        tokens: new TokenCache((depotId, host) =>
          session.cdnAuthToken(requestPayload.appId, depotId, host)
        )
      }
      state.phase = undefined
      this.host.scheduleUpdate()
      this.host.reconcile()
    } catch (error) {
      if (stop.aborted) return
      state.phase = undefined
      this.host.failDownload(redactedMessage(error))
    }
  }

  /** Chunks written to `files` count for nothing any more: they are fetched again. */
  private forgetChunksIn(files: ReadonlySet<number>): void {
    const { book, layout, units } = this.parts
    for (let chunk = 0; chunk < book.count; chunk++) {
      if (!book.isDone(chunk)) continue
      if (!layout.units[units[chunk]].targets.some((target) => files.has(target.file))) continue
      book.markNotDone(chunk)
      this.scheduler.reopen(chunk)
    }
    this.runtime.state.chunksDone = book.chunksDone
    recomputeAggregates(this.runtime.state, this.runtime.cells)
    this.host.scheduleUpdate()
  }

  // --- Transfer ----------------------------------------------------------------------------------

  reconcile(): void {
    if (!this.ready) {
      if (!this.setup && this.filesChecked) {
        this.setup = this.prepareRun().finally(() => {
          this.setup = null
        })
      }
      return
    }
    const { state } = this.runtime
    const usable = state.networks.filter(
      (network) => network.status === 'on' || network.status === 'unreachable'
    )
    const joining = usable.filter(
      (network) =>
        network.status === 'on' &&
        (this.reconciled.get(network.id) !== 'on' || this.liveStreams(network.id).length === 0)
    )
    const starting = startingStreams(
      this.scheduler.waiting,
      joining.length,
      testStreamsPerNetwork() ?? this.pickedStreams()
    )
    const now = Date.now()
    const toStart: SteamStreamState[] = []
    for (const network of state.networks) {
      const live = this.liveStreams(network.id)
      const target = !usable.includes(network)
        ? 0
        : network.status === 'unreachable'
          ? 1
          : joining.includes(network)
            ? Math.max(
                live.length,
                Math.min(starting, this.concurrency?.limit(network.id) ?? starting)
              )
            : live.length
      if (joining.includes(network)) this.trafficOf(network.id).aliveAt = now
      if (live.length > target) this.retireStreams(network.id, live.length - target)
      for (const stream of live.slice(0, target)) {
        if (!this.workers.has(stream.id)) toStart.push(stream)
      }
      if (target > live.length) toStart.push(...this.addStreams(network.id, target - live.length))
      this.reconciled.set(network.id, network.status)
    }
    this.startStreams(interleave(toStart, (stream) => stream.interfaceId))
  }

  tick(now: number): void {
    this.host.reconcile()
    const snapshot = this.concurrencySnapshot(now)
    this.adjustStreams(this.concurrency?.tick(snapshot))
    for (const stream of this.streams.values()) {
      stream.refused = false
      stream.served = false
    }
  }

  running(): Iterable<Promise<void>> {
    return this.setup ? [...this.workers.values(), this.setup] : this.workers.values()
  }

  abort(): void {
    for (const stream of this.streams.values()) stream.controller.abort()
  }

  reset(): void {
    this.ready = null
    this.filesChecked = false
    this.scheduler.reset()
    this.reconciled.clear()
    this.disk.reset()
    this.avoidServer.clear()
    this.runtime.state.phase = undefined
  }

  wake(pick: (networkId: string) => boolean, reconnect: (networkId: string) => boolean): void {
    for (const state of this.runtime.state.streams) {
      const stream = this.streams.get(state.id)
      if (!stream || stream.retiring || !pick(state.interfaceId)) continue
      stream.failures = 0
      if (reconnect(state.interfaceId)) {
        this.abortAttempt(stream.attempt, 'refresh')
        stream.connection.reconnect()
      }
      stream.nudge.abort()
    }
  }

  systemResumed(now: number): void {
    for (const traffic of this.traffic.values()) traffic.aliveAt = now
    this.ready?.servers.forgive()
    this.wake(
      () => true,
      () => true
    )
  }

  // --- streams -----------------------------------------------------------------------------------

  private network(id: string): DownloadNetwork {
    const network = this.runtime.state.networks.find((entry) => entry.id === id)
    if (!network) throw new Error(`Unknown network ${id}`)
    return network
  }

  private liveStreams(networkId: string): SteamStreamState[] {
    return this.runtime.state.streams.filter(
      (stream) => stream.interfaceId === networkId && !this.streams.get(stream.id)?.retiring
    )
  }

  private trafficOf(networkId: string): { received: number; aliveAt: number } {
    let traffic = this.traffic.get(networkId)
    if (!traffic) this.traffic.set(networkId, (traffic = { received: 0, aliveAt: 0 }))
    return traffic
  }

  private addStreams(networkId: string, count: number): SteamStreamState[] {
    const { state } = this.runtime
    let id = Math.max(-1, ...state.streams.map((stream) => stream.id))
    const added: SteamStreamState[] = Array.from({ length: count }, () => ({
      id: ++id,
      interfaceId: networkId,
      host: '',
      status: 'pending',
      bytesDownloaded: 0,
      speedBytesPerSec: 0
    }))
    state.streams.push(...added)
    state.peakStreams = Math.max(state.peakStreams, state.streams.length)
    this.host.scheduleUpdate()
    return added
  }

  private retireStreams(networkId: string, count: number): void {
    if (count < 1) return
    const rank = (state: SteamStreamState): number => {
      const stream = this.streams.get(state.id)
      return stream?.refused ? 2 : (stream?.failures ?? 0) > 0 ? 1 : 0
    }
    const order = this.liveStreams(networkId).sort((a, b) => rank(b) - rank(a) || b.id - a.id)
    for (const state of order.slice(0, count)) {
      const stream = this.streams.get(state.id)
      if (stream && this.workers.has(state.id)) {
        stream.retiring = true
        stream.controller.abort()
      } else {
        this.removeStream(state)
      }
    }
  }

  private removeStream(state: SteamStreamState): void {
    this.streams.delete(state.id)
    this.runtime.meters.connections.delete(state.id)
    const index = this.runtime.state.streams.indexOf(state)
    if (index >= 0) this.runtime.state.streams.splice(index, 1)
    this.host.scheduleUpdate()
  }

  private adjustStreams(actions: Action[] | undefined): void {
    for (const action of actions ?? []) {
      if (action.kind === 'add') this.startStreams(this.addStreams(action.networkId, action.count))
      else this.retireStreams(action.networkId, action.count)
    }
  }

  private startStreams(states: SteamStreamState[]): void {
    for (const state of states) {
      this.workers.set(
        state.id,
        this.runStream(state).finally(() => {
          this.workers.delete(state.id)
          if (this.streams.get(state.id)?.retiring) this.removeStream(state)
        })
      )
    }
    if (states.length > 0) this.host.scheduleUpdate()
  }

  private concurrencySnapshot(now: number): Snapshot {
    const inUse = this.runtime.state.networks.filter((network) => network.status === 'on')
    let writing = 0
    let held = 0
    const networks = inUse.map(({ id }) => {
      let streams = 0
      let answered = 0
      let refused = 0
      let served = 0
      for (const state of this.liveStreams(id)) {
        const stream = this.streams.get(state.id)
        streams++
        if (stream && stream.receivedBytes > 0) answered++
        if (stream?.refused) refused++
        if (stream?.served) served++
        if (stream?.attempt) {
          writing++
          if (this.scheduler.attemptOf(stream.attempt.chunk, state.id)?.finishing) held++
        }
      }
      return { id, streams, answered, refused, served }
    })
    this.noteDisk(now, writing, held)
    const { reading, since } = this.disk
    return { now, networks, spareWork: this.scheduler.waiting, disk: { reading, since } }
  }

  /** Tells the user the disk is what holds the download back: most streams have waited on their
   * writes for a while (see DiskWatch), and it isn't over until they have kept up for a while. */
  private noteDisk(now: number, writing: number, held: number): void {
    this.disk.sample(now, writing, held)
    const { state } = this.runtime
    const limited =
      writing > 0 &&
      (this.disk.lasted('behind', now) >= DISK_PATIENCE_MS ||
        (!!state.diskLimited && this.disk.lasted('keeping-up', now) < DISK_RECOVER_MS))
    if (limited === !!state.diskLimited) return
    state.diskLimited = limited || undefined
    this.host.scheduleUpdate()
  }

  private pickContext(): SteamPickContext {
    return {
      streams: this.runtime.state.streams.map((state) => ({
        id: state.id,
        networkId: state.interfaceId,
        speedBytesPerSec: state.speedBytesPerSec,
        free: state.status === 'pending' && this.workers.has(state.id)
      })),
      diskBehind: this.disk.reading === 'behind'
    }
  }

  /** The stream holds no chunk, and says so. */
  private goIdle(state: SteamStreamState): void {
    state.status = 'pending'
    state.currentCellIndex = undefined
    state.chunkReceived = undefined
    state.chunkBytes = undefined
    state.hedge = undefined
    state.speedBytesPerSec = 0
  }

  private abortAttempt(attempt: Attempt | null, reason: AbortReason): void {
    if (!attempt || attempt.reason) return
    attempt.reason = reason
    attempt.abort.abort()
  }

  private async backOff(stream: Stream, ms: number): Promise<void> {
    await delay(ms, AbortSignal.any([stream.wait, stream.nudge.signal]))
    if (stream.nudge.signal.aborted) stream.nudge = new AbortController()
  }

  private async runStream(state: SteamStreamState): Promise<void> {
    const controller = new AbortController()
    const stream: Stream = {
      controller,
      wait: AbortSignal.any([controller.signal, this.runtime.stop.signal]),
      nudge: new AbortController(),
      connection: new StreamConnection(() => this.host.networks.find(state.interfaceId), {
        timeoutMs: testKnobs.stallTimeoutMs,
        connectTimeoutMs: testKnobs.connectTimeoutMs
      }),
      attempt: null,
      lastSpeed: 0,
      receivedBytes: 0,
      failures: 0,
      strikes: 0,
      busySince: null,
      refused: false,
      served: false,
      retiring: false
    }
    this.streams.set(state.id, stream)
    try {
      while ((this.runtime.state.status as DownloadStatus) === 'downloading') {
        if (controller.signal.aborted || stream.retiring) break
        const ready = this.ready
        if (!ready) {
          await delay(IDLE_POLL_MS, stream.wait)
          continue
        }
        const work = this.scheduler.take(
          {
            streamId: state.id,
            networkId: state.interfaceId,
            speedBytesPerSec: stream.lastSpeed || undefined
          },
          Date.now(),
          this.pickContext()
        )
        if (!work) {
          this.goIdle(state)
          if (!this.scheduler.finished) {
            this.host.scheduleUpdate()
            await delay(IDLE_POLL_MS, stream.wait)
            continue
          }
          state.status = 'completed'
          this.host.scheduleUpdate()
          break
        }
        const server = this.serverFor(ready, state, work.chunk)
        // The server asked this network to hold off: the chunk goes back, and the stream waits.
        const holdFor =
          (this.holdUntil.get(`${state.interfaceId} ${server.host}`) ?? 0) - Date.now()
        if (holdFor > 0) {
          this.scheduler.release(work.chunk, state.id, false)
          this.goIdle(state)
          state.status = 'retrying'
          this.host.scheduleUpdate()
          await this.backOff(stream, holdFor + Math.random() * Math.min(1000, holdFor / 10))
          continue
        }
        const attempt: Attempt = {
          chunk: work.chunk,
          kind: work.kind,
          server,
          abort: new AbortController(),
          reason: null,
          received: 0,
          startedAt: Date.now()
        }
        stream.attempt = attempt
        const unit = this.parts.layout.units[this.parts.units[work.chunk]]
        this.parts.book.inFlightChanged(work.chunk, 1)
        state.status = 'downloading'
        state.host = server.host
        state.currentCellIndex = this.parts.book.cellOf[work.chunk]
        state.chunkReceived = 0
        state.chunkBytes = unit.compressedSize
        state.hedge = work.kind === 'hedge' ? true : undefined
        this.host.scheduleUpdate()
        let next: 'continue' | 'stop'
        try {
          const outcome = await this.execute(ready, state, stream, attempt)
          next = await this.finish(ready, state, stream, attempt, outcome)
        } finally {
          stream.attempt = null
          this.parts.book.inFlightChanged(work.chunk, -1)
          this.host.scheduleUpdate()
        }
        if (next === 'stop') break
      }
    } finally {
      stream.connection.close()
      if (
        state.status === 'downloading' ||
        state.status === 'retrying' ||
        state.status === 'pending'
      ) {
        const status = this.runtime.state.status as DownloadStatus
        this.goIdle(state)
        if (status === 'paused') state.status = 'paused'
        else if (status !== 'downloading') state.status = 'cancelled'
      }
    }
    this.host.scheduleUpdate()
  }

  /** The content server for `chunk`: the stream's own share of the list, past any server that
   * didn't have it or sent it damaged. */
  private serverFor(ready: RunContext, state: SteamStreamState, chunk: number): ContentServer {
    const networkIndex = Math.max(
      0,
      this.runtime.state.networks.findIndex((network) => network.id === state.interfaceId)
    )
    return ready.servers.pick(
      state.interfaceId,
      networkIndex,
      state.id,
      Date.now(),
      this.avoidServer.get(chunk)
    )
  }

  /** Fetches, checks and writes one chunk. Never throws. */
  private async execute(
    ready: RunContext,
    state: SteamStreamState,
    stream: Stream,
    attempt: Attempt
  ): Promise<Outcome> {
    const { layout, units, file } = this.parts
    const unit = layout.units[units[attempt.chunk]]
    const depotId = layout.depots[unit.depot].depotId
    const networkId = state.interfaceId
    try {
      const { server } = attempt
      const token = this.needsToken.has(server.vhost)
        ? await ready.tokens.get(depotId, server.vhost, Date.now())
        : undefined
      const body = await fetchBody({
        connection: stream.connection,
        url: chunkUrl(server, depotId, unit.sha, token),
        vhost: server.vhost,
        expectedBytes: unit.compressedSize,
        maxBytes: MAX_CHUNK_BODY,
        stallMs: testKnobs.stallTimeoutMs,
        signal: AbortSignal.any([stream.controller.signal, attempt.abort.signal]),
        throttle: (bytes) => this.host.limits.take(networkId, bytes),
        onBytes: (bytes) => {
          attempt.received += bytes
          const view = this.scheduler.attemptOf(attempt.chunk, state.id)
          if (view) view.received = attempt.received
          if (!attempt.reason) state.chunkReceived = attempt.received
          this.onNetworkBytes(state, stream, bytes)
        }
      })
      const view = this.scheduler.attemptOf(attempt.chunk, state.id)
      if (view) view.finishing = true
      const key = ready.keys.get(depotId)!
      const data = await this.services.workers.decode(
        body,
        key,
        Buffer.from(unit.sha, 'hex'),
        unit.size
      )
      // Another attempt finished it meanwhile: these bytes are the same, and not needed.
      if (attempt.reason === 'lost' || this.parts.book.isDone(attempt.chunk)) {
        return { type: 'aborted', reason: 'lost' }
      }
      await file.writeChunk(data, unit.targets)
      this.disk.landed(Date.now())
      return { type: 'completed' }
    } catch (error) {
      const status = this.runtime.state.status as DownloadStatus
      if (stream.controller.signal.aborted || status !== 'downloading') return { type: 'stopped' }
      if (attempt.reason) return { type: 'aborted', reason: attempt.reason }
      return { type: 'failed', error }
    }
  }

  private onNetworkBytes(state: SteamStreamState, stream: Stream, bytes: number): void {
    const now = Date.now()
    stream.receivedBytes += bytes
    stream.served = true
    const traffic = this.trafficOf(state.interfaceId)
    traffic.received += bytes
    traffic.aliveAt = now
    const network = this.network(state.interfaceId)
    if (network.status === 'unreachable') {
      network.status = 'on'
      stream.failures = 0
    }
    this.runtime.meters.add(state.id, state.interfaceId, bytes)
    this.host.scheduleUpdate()
  }

  private async finish(
    ready: RunContext,
    state: SteamStreamState,
    stream: Stream,
    attempt: Attempt,
    outcome: Outcome
  ): Promise<'continue' | 'stop'> {
    debug('chunk', {
      chunk: attempt.chunk,
      stream: state.id,
      network: state.interfaceId,
      server: attempt.server.host,
      kind: attempt.kind,
      outcome: outcome.type === 'aborted' ? `aborted:${outcome.reason}` : outcome.type,
      bytes: attempt.received,
      ms: Date.now() - attempt.startedAt
    })
    switch (outcome.type) {
      case 'completed':
        this.completed(ready, state, stream, attempt)
        return 'continue'
      case 'stopped':
        this.scheduler.release(attempt.chunk, state.id, false)
        this.goIdle(state)
        return 'stop'
      case 'aborted':
        this.scheduler.release(
          attempt.chunk,
          state.id,
          outcome.reason === 'refresh' && attempt.received === 0
        )
        this.goIdle(state)
        return 'continue'
      case 'failed':
        return this.failed(ready, state, stream, attempt, outcome.error)
    }
  }

  private completed(
    ready: RunContext,
    state: SteamStreamState,
    stream: Stream,
    attempt: Attempt
  ): void {
    const { book } = this.parts
    const rivals = this.scheduler.complete(attempt.chunk, state.id)
    // Whoever is still racing for it has lost, and says so now rather than when it notices.
    for (const rivalId of rivals) {
      const rival = this.streams.get(rivalId)
      this.abortAttempt(rival?.attempt ?? null, 'lost')
      const rivalState = this.runtime.state.streams.find((entry) => entry.id === rivalId)
      if (rivalState) this.goIdle(rivalState)
    }
    const gained = book.markDone(attempt.chunk, state.interfaceId)
    const { state: download } = this.runtime
    download.bytesDownloaded += gained
    download.chunksDone = book.chunksDone
    this.network(state.interfaceId).bytesDownloaded += gained
    state.bytesDownloaded += gained
    stream.lastSpeed = (attempt.received / Math.max(1, Date.now() - attempt.startedAt)) * 1000
    stream.failures = 0
    stream.strikes = 0
    stream.busySince = null
    ready.servers.served(state.interfaceId, attempt.server.host)
    this.damagedBy.delete(attempt.chunk)
    this.avoidServer.delete(attempt.chunk)
    this.goIdle(state)
  }

  /** Whether a network that has received nothing for SILENT_AFTER_MS can't reach the servers. */
  private markUnreachable(network: DownloadNetwork, now: number): boolean {
    if (network.status !== 'on') return false
    if (now - this.trafficOf(network.id).aliveAt < SILENT_AFTER_MS) return false
    network.status = 'unreachable'
    return true
  }

  private async failed(
    ready: RunContext,
    state: SteamStreamState,
    stream: Stream,
    attempt: Attempt,
    error: unknown
  ): Promise<'continue' | 'stop'> {
    const network = this.network(state.interfaceId)
    const { server, chunk } = attempt
    const now = Date.now()
    const message = redactedMessage(error)
    const deliveredNothing = attempt.received === 0
    const unit = this.parts.layout.units[this.parts.units[chunk]]

    if (isDiskError(error)) {
      // Every stream would hit the same full or read-only disk.
      this.scheduler.release(chunk, state.id, false)
      this.goIdle(state)
      this.host.failDownload(message)
      return 'stop'
    }
    if (error instanceof SteamLoginRequiredError || error instanceof SteamRefusedError) {
      // Steam itself said no (a CDN token, after the login lapsed): no server or network fixes it.
      this.scheduler.release(chunk, state.id, false)
      this.goIdle(state)
      // Turned down because the login is gone (not because of a license): said as such, since
      // logging in again is what resumes it.
      const eresult = eresultOf(error)
      const loginGone =
        this.services.account.loginState.status !== 'logged-in' ||
        eresult === EResult.NotLoggedOn ||
        (eresult !== EResult.AccessDenied && loginExpired(eresult))
      this.host.failDownload(loginGone ? new SteamLoginRequiredError().message : message)
      return 'stop'
    }
    if (error instanceof NoCompatibleRouteError) {
      this.scheduler.release(chunk, state.id, deliveredNothing)
      this.goIdle(state)
      this.host.failNetwork(network, message)
      return 'stop'
    }

    if (error instanceof ChunkError || error instanceof BodySizeError) {
      // What came isn't this chunk: nothing of it was written. Asked of another server next.
      const damaged = this.damagedBy.get(chunk) ?? new Set<string>()
      damaged.add(server.host)
      this.damagedBy.set(chunk, damaged)
      if (damaged.size >= Math.min(DAMAGED_SERVERS_TO_FAIL, ready.servers.servers.length)) {
        this.scheduler.release(chunk, state.id, false)
        this.goIdle(state)
        this.host.failDownload(
          'Steam’s content servers keep sending a damaged copy of part of this game. Try again later.'
        )
        return 'stop'
      }
      this.avoidServer.set(chunk, server.host)
      ready.servers.failed(state.interfaceId, server.host, now)
    } else if (error instanceof HttpStatusError && [401, 403].includes(error.status)) {
      ready.tokens.invalidate(this.parts.layout.depots[unit.depot].depotId, server.vhost)
      if (!this.needsToken.has(server.vhost)) {
        // The first refusal of a server is taken to mean it wants a CDN token: asked again with
        // one at once, not counted against anything.
        this.needsToken.add(server.vhost)
        this.scheduler.release(chunk, state.id, false)
        this.goIdle(state)
        return 'continue'
      }
      stream.refused = true
      ready.servers.failed(state.interfaceId, server.host, now)
    } else if (error instanceof HttpStatusError && [404, 410].includes(error.status)) {
      // This server doesn't have it; another may.
      this.avoidServer.set(chunk, server.host)
    } else if (error instanceof ConnectionError) {
      if (this.markUnreachable(network, now)) this.host.reconcile()
      ready.servers.failed(state.interfaceId, server.host, now)
    }

    // A hedge is optional work: its failure isn't retried.
    if (attempt.kind === 'hedge') {
      this.scheduler.release(chunk, state.id, deliveredNothing)
      this.goIdle(state)
      return 'continue'
    }

    if (network.status === 'on') network.retries += 1
    if (attempt.received > 0) stream.failures = 0
    stream.failures += 1
    this.scheduler.release(chunk, state.id, deliveredNothing)
    this.goIdle(state)

    if (error instanceof HttpStatusError && [403, 429, 503].includes(error.status)) {
      stream.refused = true
    }
    const busy = error instanceof HttpStatusError && error.transient
    if (busy) stream.busySince ??= now
    const waitingOut = busy && now - (stream.busySince ?? now) < SERVER_BUSY_FOR_MS
    if (!(error instanceof ConnectionError) && ++stream.strikes > MAX_STRIKES && !waitingOut) {
      stream.retiring = true
      if (this.liveStreams(network.id).length === 0) this.host.failNetwork(network, message)
      return 'stop'
    }

    let wait = retryDelayMs(stream.failures)
    if (network.status === 'unreachable') wait = Math.min(wait, UNREACHABLE_RETRY_MS)
    if (error instanceof HttpStatusError && error.transient && error.retryAfterMs !== null) {
      // Asked of whoever sent it — this network's address, to this server — not of one request.
      const asked = Math.min(error.retryAfterMs, RETRY_AFTER_MAX_MS)
      wait = Math.max(wait, asked)
      const key = `${state.interfaceId} ${server.host}`
      this.holdUntil.set(key, Math.max(this.holdUntil.get(key) ?? 0, now + asked))
    }
    state.status = 'retrying'
    this.host.scheduleUpdate()
    await this.backOff(stream, wait)
    const after = this.runtime.state.status as DownloadStatus
    if (stream.controller.signal.aborted || after !== 'downloading') return 'stop'
    this.goIdle(state)
    return 'continue'
  }
}
