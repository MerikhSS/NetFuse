// Who fetches which Steam chunk. The rules are download/scheduler.ts's (pickWork), for the same
// reasons; only the bookkeeping differs. pickWork looks through every block on every pick, which
// is fine for a file's few hundred blocks and not for a game's hundred thousand chunks, picked
// hundreds of times a second. Here the chunks nobody has tried yet are handed out from a cursor,
// and the few handed back (a failed attempt) wait in a short queue in front of it, so a pick costs
// the same however big the game is.
//
//   primary  A chunk nobody is fetching: the next one handed back, else the next untried one. A
//            chunk whose last attempt on this network delivered nothing is left to another network
//            while one of that network's streams is free, and taken anyway otherwise, so it is
//            never stranded.
//   hedge    A second attempt at a chunk someone else is fetching too slowly, only once nothing
//            is left to hand out and the disk is keeping up. Chunks are small, so this only
//            matters at the very end, where one slow connection would otherwise hold up the
//            whole download.
//
// No I/O and no clock of its own: every decision is a function of what it is told.

export interface SteamAttemptView {
  kind: 'primary' | 'hedge'
  streamId: number
  networkId: string
  startedAt: number
  /** Body bytes it has received so far. */
  received: number
  /** Its body is in and it is being verified or written: the disk, not the network, sets its pace. */
  finishing?: boolean
}

export interface SteamRequester {
  streamId: number
  networkId: string
  /** How fast it fetched its last chunk, if it has finished one. */
  speedBytesPerSec?: number
}

export interface SteamSchedulerPolicy {
  hedgeAfterMs: number
  maxHedgesPerChunk: number
  /** What a new request costs before its first byte. */
  startupMs: number
}

export interface SteamPickContext {
  /** Each stream's network, current speed, and whether it is free (waiting for work). */
  streams: readonly { id: number; networkId: string; speedBytesPerSec: number; free: boolean }[]
  /** The disk is behind (see DiskWatch): a hedge would only add writes. */
  diskBehind?: boolean
}

export interface SteamWork {
  kind: 'primary' | 'hedge'
  chunk: number
}

const PENDING = 0
const IN_FLIGHT = 1
const DONE = 2

export class SteamScheduler {
  private readonly state: Uint8Array
  /** The first chunk the cursor hasn't handed out yet. */
  private cursor = 0
  /** Chunks handed back, in the order they came back. */
  private returned: number[] = []
  /** For a chunk whose last attempt on some network delivered nothing, that network. */
  private readonly avoid = new Map<number, string>()
  /** Attempts in flight, by chunk. */
  readonly attempts = new Map<number, SteamAttemptView[]>()
  private readonly hedges = new Map<number, number>()
  private pending: number

  constructor(
    count: number,
    isDone: (chunk: number) => boolean,
    /** Per chunk: its download size, for how long it has left. */
    private readonly sizes: ArrayLike<number>,
    private readonly policy: SteamSchedulerPolicy
  ) {
    this.state = new Uint8Array(count)
    let pending = 0
    for (let chunk = 0; chunk < count; chunk++) {
      if (isDone(chunk)) this.state[chunk] = DONE
      else pending++
    }
    this.pending = pending
  }

  /** Chunks no attempt holds and that aren't done. */
  get waiting(): number {
    return this.pending
  }

  /** Chunks at least one attempt holds. */
  get inFlight(): number {
    return this.attempts.size
  }

  /** Nothing waiting and nothing in flight: every chunk is done. */
  get finished(): boolean {
    return this.pending === 0 && this.attempts.size === 0
  }

  private nextPrimary(networkId: string, context: SteamPickContext): number | undefined {
    const otherNetworkFree = context.streams.some(
      (stream) => stream.free && stream.networkId !== networkId
    )
    for (let i = 0; i < this.returned.length; i++) {
      const chunk = this.returned[i]
      if (this.state[chunk] !== PENDING) {
        // Finished by a hedge meanwhile.
        this.returned.splice(i--, 1)
        continue
      }
      if (otherNetworkFree && this.avoid.get(chunk) === networkId) continue
      this.returned.splice(i, 1)
      return chunk
    }
    while (this.cursor < this.state.length && this.state[this.cursor] !== PENDING) this.cursor++
    if (this.cursor < this.state.length) return this.cursor++
    // Every pending chunk left is one to leave to another network, and one is free to take it.
    return undefined
  }

  private nextHedge(
    who: SteamRequester,
    now: number,
    context: SteamPickContext
  ): number | undefined {
    if (this.pending > 0 || context.diskBehind) return undefined
    const speedOf = (streamId: number): number =>
      context.streams.find((stream) => stream.id === streamId)?.speedBytesPerSec ?? 0
    let target: number | undefined
    let latest = 0
    for (const [chunk, attempts] of this.attempts) {
      if (!attempts.some((attempt) => attempt.kind === 'primary')) continue
      if (attempts.some((attempt) => attempt.streamId === who.streamId)) continue
      if ((this.hedges.get(chunk) ?? 0) >= this.policy.maxHedgesPerChunk) continue
      if (this.avoid.get(chunk) === who.networkId) continue
      if (attempts.some((attempt) => now - attempt.startedAt < this.policy.hedgeAfterMs)) continue
      if (attempts.some((attempt) => attempt.finishing)) continue
      // A chunk is as slow as its fastest attempt; one gone quiet has no finish time at all.
      const eta = Math.min(
        ...attempts.map((attempt) => {
          const speed = speedOf(attempt.streamId)
          const left = Math.max(0, this.sizes[chunk] - attempt.received)
          return speed ? (left / speed) * 1000 : Infinity
        })
      )
      const size = this.sizes[chunk]
      const worthIt = who.speedBytesPerSec
        ? eta >= 2 * (this.policy.startupMs + (size / who.speedBytesPerSec) * 1000)
        : eta >= this.policy.hedgeAfterMs
      if (!worthIt) continue
      // The holders' network may be what is slow: another network gets the first go.
      const holders = new Set(attempts.map((attempt) => attempt.networkId))
      const otherNetworkFree = context.streams.some(
        (stream) =>
          stream.free &&
          !holders.has(stream.networkId) &&
          this.avoid.get(chunk) !== stream.networkId
      )
      if (holders.has(who.networkId) && otherNetworkFree) continue
      if (eta > latest) {
        target = chunk
        latest = eta
      }
    }
    return target
  }

  /** Work for `who`, registered as begun, or undefined when there is none for it now. */
  take(who: SteamRequester, now: number, context: SteamPickContext): SteamWork | undefined {
    const primary = this.nextPrimary(who.networkId, context)
    const kind = primary !== undefined ? 'primary' : 'hedge'
    const chunk = primary ?? this.nextHedge(who, now, context)
    if (chunk === undefined) return undefined
    if (kind === 'primary') {
      this.state[chunk] = IN_FLIGHT
      this.pending--
      this.avoid.delete(chunk)
    } else {
      this.hedges.set(chunk, (this.hedges.get(chunk) ?? 0) + 1)
    }
    const attempt: SteamAttemptView = {
      kind,
      streamId: who.streamId,
      networkId: who.networkId,
      startedAt: now,
      received: 0
    }
    const list = this.attempts.get(chunk)
    if (list) list.push(attempt)
    else this.attempts.set(chunk, [attempt])
    return { kind, chunk }
  }

  /** The attempt `streamId` holds on `chunk`. */
  attemptOf(chunk: number, streamId: number): SteamAttemptView | undefined {
    return this.attempts.get(chunk)?.find((attempt) => attempt.streamId === streamId)
  }

  private drop(chunk: number, streamId: number): SteamAttemptView | undefined {
    const list = this.attempts.get(chunk)
    const index = list?.findIndex((attempt) => attempt.streamId === streamId) ?? -1
    if (!list || index < 0) return undefined
    const [attempt] = list.splice(index, 1)
    if (list.length === 0) this.attempts.delete(chunk)
    return attempt
  }

  /** `streamId` finished `chunk`: it is done, and every other attempt at it has lost. Returns
   * the streams still racing for it, for the caller to call off. */
  complete(chunk: number, streamId: number): number[] {
    this.drop(chunk, streamId)
    const rivals = (this.attempts.get(chunk) ?? []).map((attempt) => attempt.streamId)
    this.attempts.delete(chunk)
    if (this.state[chunk] === PENDING) this.pending--
    this.state[chunk] = DONE
    return rivals
  }

  /** `streamId` let go of `chunk` without finishing it. A primary hands it back, unless a hedge
   * still holds it; a hedge just drops out. `deliveredNothing`: the attempt received no byte,
   * so its network is left out of the chunk's next hand-out while another can take it. */
  release(chunk: number, streamId: number, deliveredNothing: boolean): void {
    const attempt = this.drop(chunk, streamId)
    if (!attempt || this.state[chunk] === DONE) return
    if (deliveredNothing) this.avoid.set(chunk, attempt.networkId)
    if (attempt.kind !== 'primary') return
    const others = this.attempts.get(chunk)
    if (others?.length) {
      // A hedge is still on it: it takes over as the chunk's primary attempt.
      for (const other of others) other.kind = 'primary'
      return
    }
    this.state[chunk] = PENDING
    this.pending++
    this.returned.push(chunk)
  }

  /** A chunk found not to be done after all (its file went missing): fetched again. */
  reopen(chunk: number): void {
    if (this.state[chunk] !== DONE) return
    this.state[chunk] = PENDING
    this.pending++
    this.returned.push(chunk)
  }

  /** Forgets what only steered the current run: avoided networks and hedge counts. Attempts
   * must all have ended. */
  reset(): void {
    this.avoid.clear()
    this.hedges.clear()
  }
}
