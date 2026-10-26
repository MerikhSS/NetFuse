import type { SteamCellState } from '../../shared/types'

// A Steam download's progress, chunk by chunk, and the grid squares (cells) the window draws it
// as. A game can have a hundred thousand chunks, so per-chunk state is typed arrays, never an
// object per chunk, and the window sees at most MAX_CELLS cells: runs of chunks in fetch order of
// about equal download bytes. Every count here moves by deltas, so finishing a chunk costs the
// same however big the game is.

export const MAX_CELLS = 2048

/** Not done: no network delivered it yet. Otherwise the network that did, as 1 + its index. */
const NOT_DONE = 0
/** The most networks a download records (one byte per chunk). */
const MAX_NETWORKS = 255

export interface SavedChunks {
  /** The networks chunks were credited to; `done` refers to them by position. */
  networks: string[]
  /** Base64 of one byte per chunk: 0 not done, else 1 + the index into `networks`. */
  done: string
}

/** Where each cell starts, as an index into the chunks, plus one end entry: cells cover runs of
 * chunks of about equal download bytes, never more than MAX_CELLS of them. */
export function planCells(sizes: ArrayLike<number>, maxCells = MAX_CELLS): Uint32Array {
  const count = sizes.length
  let total = 0
  for (let i = 0; i < count; i++) total += sizes[i]
  const cellCount = Math.max(1, Math.min(count, maxCells))
  const starts: number[] = [0]
  let seen = 0
  for (let i = 0; i < count; i++) {
    seen += sizes[i]
    // A cell ends once its share of the total is reached, and every remaining cell can still
    // have a chunk.
    const ended = starts.length
    if (
      ended < cellCount &&
      i + 1 < count &&
      (seen >= (total * ended) / cellCount || count - (i + 1) <= cellCount - ended)
    ) {
      starts.push(i + 1)
    }
  }
  starts.push(count)
  return Uint32Array.from(starts)
}

export class ChunkBook {
  readonly cells: SteamCellState[]
  /** Per chunk: NOT_DONE, or 1 + the delivering network's index into `networks`. */
  readonly done: Uint8Array
  /** Per chunk: its cell. */
  readonly cellOf: Uint32Array
  readonly networks: string[] = []
  chunksDone = 0
  bytesDone = 0
  private readonly chunksInCell: Uint32Array
  private readonly doneInCell: Uint32Array
  private readonly inFlight: Uint16Array

  constructor(
    /** Per chunk: its download (compressed) size. */
    readonly sizes: Uint32Array,
    starts: Uint32Array = planCells(sizes)
  ) {
    const count = sizes.length
    this.done = new Uint8Array(count)
    this.cellOf = new Uint32Array(count)
    const cellCount = starts.length - 1
    this.chunksInCell = new Uint32Array(cellCount)
    this.doneInCell = new Uint32Array(cellCount)
    this.inFlight = new Uint16Array(cellCount)
    this.cells = []
    let offset = 0
    for (let cell = 0; cell < cellCount; cell++) {
      const rangeStart = offset
      this.chunksInCell[cell] = starts[cell + 1] - starts[cell]
      for (let chunk = starts[cell]; chunk < starts[cell + 1]; chunk++) {
        this.cellOf[chunk] = cell
        offset += sizes[chunk]
      }
      this.cells.push({
        kind: 'steam',
        index: cell,
        rangeStart,
        rangeEnd: Math.max(rangeStart, offset - 1),
        // Only an install with no chunks at all (every file empty) has an empty cell: nothing
        // is left to fetch for it.
        status: this.chunksInCell[cell] === 0 ? 'completed' : 'pending',
        bytesDownloaded: 0,
        bytesByInterface: {}
      })
    }
  }

  get count(): number {
    return this.sizes.length
  }

  isDone(chunk: number): boolean {
    return this.done[chunk] !== NOT_DONE
  }

  private networkIndex(networkId: string): number {
    let index = this.networks.indexOf(networkId)
    if (index < 0) {
      if (this.networks.length >= MAX_NETWORKS) throw new Error('Too many networks')
      index = this.networks.push(networkId) - 1
    }
    return index
  }

  /** Re-derives a cell's status from its counts. */
  private settle(cell: number): void {
    const state = this.cells[cell]
    state.status =
      this.doneInCell[cell] === this.chunksInCell[cell]
        ? 'completed'
        : this.inFlight[cell] > 0
          ? 'downloading'
          : 'pending'
    // The network that moved the most of it is the one it is drawn as.
    let best: string | undefined
    let most = -1
    for (const [id, bytes] of Object.entries(state.bytesByInterface)) {
      if (bytes > most) {
        best = id
        most = bytes
      }
    }
    state.interfaceId = best
  }

  /** An attempt at `chunk` started (+1) or ended (-1). */
  inFlightChanged(chunk: number, delta: 1 | -1): void {
    const cell = this.cellOf[chunk]
    this.inFlight[cell] = Math.max(0, this.inFlight[cell] + delta)
    this.settle(cell)
  }

  /** `chunk` is written, delivered over `networkId`. Returns the bytes newly done. */
  markDone(chunk: number, networkId: string): number {
    if (this.isDone(chunk)) return 0
    const size = this.sizes[chunk]
    const cell = this.cellOf[chunk]
    this.done[chunk] = this.networkIndex(networkId) + 1
    this.chunksDone += 1
    this.bytesDone += size
    this.doneInCell[cell] += 1
    const state = this.cells[cell]
    state.bytesDownloaded += size
    state.bytesByInterface[networkId] = (state.bytesByInterface[networkId] ?? 0) + size
    this.settle(cell)
    return size
  }

  /** `chunk` is no longer on disk as it should be (its file went missing): fetched again. */
  markNotDone(chunk: number): void {
    if (!this.isDone(chunk)) return
    const size = this.sizes[chunk]
    const cell = this.cellOf[chunk]
    const networkId = this.networks[this.done[chunk] - 1]
    this.done[chunk] = NOT_DONE
    this.chunksDone -= 1
    this.bytesDone -= size
    this.doneInCell[cell] -= 1
    const state = this.cells[cell]
    state.bytesDownloaded -= size
    const credited = (state.bytesByInterface[networkId] ?? 0) - size
    if (credited > 0) state.bytesByInterface[networkId] = credited
    else delete state.bytesByInterface[networkId]
    this.settle(cell)
  }

  /** What a checkpoint saves. */
  save(): SavedChunks {
    return { networks: [...this.networks], done: Buffer.from(this.done).toString('base64') }
  }

  /** Takes up `saved`, if it describes this download's chunks; otherwise starts from nothing.
   * Says whether it did. */
  restore(saved: unknown): boolean {
    const record = saved as Partial<SavedChunks> | null | undefined
    if (
      !record ||
      !Array.isArray(record.networks) ||
      record.networks.length > MAX_NETWORKS ||
      !record.networks.every((id) => typeof id === 'string' && id.length > 0) ||
      typeof record.done !== 'string'
    ) {
      return false
    }
    const done = Buffer.from(record.done, 'base64')
    if (done.length !== this.count) return false
    for (const value of done) if (value > record.networks.length) return false
    for (let chunk = 0; chunk < this.count; chunk++) {
      if (done[chunk] !== NOT_DONE) this.markDone(chunk, record.networks[done[chunk] - 1])
    }
    return true
  }
}
