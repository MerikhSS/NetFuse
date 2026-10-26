import { readFileSync } from 'node:fs'
import { availableParallelism } from 'node:os'
import { Worker } from 'node:worker_threads'
import workerPath from './chunkWorker?modulePath'
import { ChunkError, decodeChunk } from './chunkCodec'
import type { ChunkJob, ChunkJobResult } from './chunkWorker'

// Decodes Steam chunks on worker threads, a few at a time. The worker's code is read by the main
// process and handed to the thread as source rather than as a path: in the packaged app it sits
// inside app.asar, which the main process's fs reads but a worker thread's loader may not. If no
// worker can start at all, chunks are decoded on the main thread instead: slower, never wrong.

/** Workers kept: the rest of the cores are left for the main process and the system. */
const MAX_WORKERS = 4

interface Pending {
  resolve: (data: Buffer) => void
  reject: (error: Error) => void
}

interface Entry {
  worker: Worker
  /** The jobs it holds, by id. */
  jobs: Map<number, Pending>
}

let source: string | null | undefined

function workerSource(): string | null {
  if (source === undefined) {
    try {
      source = readFileSync(workerPath, 'utf8')
    } catch (error) {
      console.warn('Steam chunk worker unavailable, decoding on the main thread:', error)
      source = null
    }
  }
  return source
}

export class ChunkWorkerPool {
  private readonly workers: Entry[] = []
  private nextId = 0
  private broken = false

  constructor(
    private readonly size = Math.max(1, Math.min(MAX_WORKERS, availableParallelism() - 1))
  ) {}

  private spawn(): Entry | null {
    const code = workerSource()
    if (!code || this.broken) return null
    let worker: Worker
    try {
      worker = new Worker(code, { eval: true })
    } catch (error) {
      console.warn('Steam chunk worker failed to start, decoding on the main thread:', error)
      this.broken = true
      return null
    }
    const entry: Entry = { worker, jobs: new Map() }
    worker.on('message', (result: ChunkJobResult) => {
      const job = entry.jobs.get(result.id)
      entry.jobs.delete(result.id)
      if (entry.jobs.size === 0) worker.unref()
      if (!job) return
      if (result.ok) {
        job.resolve(Buffer.from(result.data.buffer, result.data.byteOffset, result.data.byteLength))
      } else {
        job.reject(result.corrupt ? new ChunkError(result.message) : new Error(result.message))
      }
    })
    worker.on('error', (error) => {
      // Whatever it held fails, to be fetched again; the next job gets a new worker.
      console.warn('Steam chunk worker stopped:', error)
      this.retire(entry, error)
    })
    worker.on('exit', () => this.retire(entry, new Error('The chunk worker stopped')))
    // An idle worker doesn't keep the process alive.
    worker.unref()
    this.workers.push(entry)
    return entry
  }

  private retire(entry: Entry, error: Error): void {
    const index = this.workers.indexOf(entry)
    if (index >= 0) this.workers.splice(index, 1)
    for (const job of entry.jobs.values()) job.reject(error)
    entry.jobs.clear()
  }

  /** An idle worker, a new one while there is room for it, else the least busy. */
  private worker(): Entry | null {
    const idle = this.workers.find((entry) => entry.jobs.size === 0)
    if (idle) return idle
    if (this.workers.length < this.size) {
      const spawned = this.spawn()
      if (spawned) return spawned
    }
    return this.workers.reduce<Entry | null>(
      (best, entry) => (!best || entry.jobs.size < best.jobs.size ? entry : best),
      null
    )
  }

  /** `body` decrypted with `key`, decompressed and checked against `sha` and `size`. Rejects with
   * a ChunkError when the chunk isn't what the manifest says. */
  decode(body: Buffer, key: Buffer, sha: Buffer, size: number): Promise<Buffer> {
    const entry = this.worker()
    if (!entry) return Promise.resolve().then(() => decodeChunk(body, key, { sha, size }))
    const id = this.nextId++
    const job: ChunkJob = { id, body, key, sha, size }
    return new Promise<Buffer>((resolve, reject) => {
      entry.jobs.set(id, { resolve, reject })
      entry.worker.ref()
      entry.worker.postMessage(job)
    })
  }

  /** Stops every worker; jobs still out fail. */
  async close(): Promise<void> {
    const workers = this.workers.splice(0)
    for (const entry of workers) this.retire(entry, new Error('Stopped'))
    await Promise.all(workers.map(({ worker }) => worker.terminate()))
  }
}
