import { parentPort } from 'node:worker_threads'
import { ChunkError, decodeChunk } from './chunkCodec'

// Runs in a worker thread (see workerPool.ts): decrypting, decompressing and checking a chunk
// takes milliseconds of CPU each — tens for an LZMA one — and at a hundred megabytes a second
// that would leave the main process, which runs every download and answers the window, no time
// for anything else. It only ever imports the pure chunk modules.

export interface ChunkJob {
  id: number
  body: Uint8Array
  key: Uint8Array
  sha: Uint8Array
  size: number
}

export type ChunkJobResult =
  | { id: number; ok: true; data: Uint8Array }
  | { id: number; ok: false; message: string; corrupt: boolean }

parentPort?.on('message', (job: ChunkJob) => {
  try {
    const out = decodeChunk(job.body, job.key, { sha: job.sha, size: job.size })
    // Its own buffer, so it can be handed over rather than copied: a small Buffer can be a slice
    // of a shared pool.
    const data =
      out.byteOffset === 0 && out.byteLength === out.buffer.byteLength ? out : Uint8Array.from(out)
    const result: ChunkJobResult = { id: job.id, ok: true, data }
    parentPort!.postMessage(result, [data.buffer as ArrayBuffer])
  } catch (error) {
    const result: ChunkJobResult = {
      id: job.id,
      ok: false,
      message: error instanceof Error ? error.message : String(error),
      corrupt: error instanceof ChunkError
    }
    parentPort!.postMessage(result)
  }
})
