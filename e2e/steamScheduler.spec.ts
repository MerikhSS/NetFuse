import { expect, test } from '@playwright/test'
import fc from 'fast-check'
import { ChunkBook, MAX_CELLS, planCells } from '../src/main/steam/cells'
import {
  SteamScheduler,
  type SteamPickContext,
  type SteamSchedulerPolicy
} from '../src/main/steam/scheduler'

// Who fetches which Steam chunk, and how a download's progress is kept and drawn. Pure, so the
// rules are checked against exact situations, as scheduler.spec.ts does for HTTP blocks.

const POLICY: SteamSchedulerPolicy = { hedgeAfterMs: 5000, maxHedgesPerChunk: 1, startupMs: 1000 }
const NOW = 100_000

const scheduler = (count: number, done: number[] = [], size = 1000): SteamScheduler =>
  new SteamScheduler(
    count,
    (chunk) => done.includes(chunk),
    new Uint32Array(count).fill(size),
    POLICY
  )

const free = (...streams: [number, string, number?][]): SteamPickContext => ({
  streams: streams.map(([id, networkId, speed]) => ({
    id,
    networkId,
    speedBytesPerSec: speed ?? 0,
    free: true
  }))
})

test.describe('steam scheduler', () => {
  test('hands out chunks in order, skipping the done ones, and each once', () => {
    const s = scheduler(5, [1, 3])
    const context = free([1, 'a'])
    const taken = [0, 1, 2, 3].map(
      () => s.take({ streamId: 1, networkId: 'a' }, NOW, context)?.chunk
    )
    expect(taken).toEqual([0, 2, 4, undefined])
    expect(s.waiting).toBe(0)
    expect(s.inFlight).toBe(3)
  })

  test('a chunk handed back goes before the untried ones', () => {
    const s = scheduler(4)
    const context = free([1, 'a'], [2, 'b'])
    s.take({ streamId: 1, networkId: 'a' }, NOW, context)
    s.take({ streamId: 2, networkId: 'b' }, NOW, context)
    s.release(0, 1, false)
    expect(s.take({ streamId: 2, networkId: 'b' }, NOW, context)?.chunk).toBe(0)
  })

  test('a chunk a network got nothing for goes to another network while one is free, and is never stranded', () => {
    const s = scheduler(1)
    s.take({ streamId: 1, networkId: 'a' }, NOW, free([1, 'a']))
    s.release(0, 1, true)
    // b is free: a leaves the chunk to it.
    expect(s.take({ streamId: 1, networkId: 'a' }, NOW, free([1, 'a'], [2, 'b']))).toBeUndefined()
    // No other network is free: a takes it anyway.
    expect(s.take({ streamId: 1, networkId: 'a' }, NOW, free([1, 'a']))?.chunk).toBe(0)
  })

  test('only once nothing is waiting does a slow chunk get raced, by a faster stream, on another network first', () => {
    const s = scheduler(2, [], 1_000_000)
    s.take({ streamId: 1, networkId: 'a' }, NOW - 10_000, free([1, 'a']))
    // Something still waits: no hedge, the waiting chunk instead.
    expect(s.take({ streamId: 2, networkId: 'b' }, NOW, free([2, 'b']))?.kind).toBe('primary')
    const context: SteamPickContext = {
      streams: [
        { id: 1, networkId: 'a', speedBytesPerSec: 10_000, free: false },
        { id: 2, networkId: 'b', speedBytesPerSec: 500_000, free: false },
        { id: 3, networkId: 'a', speedBytesPerSec: 0, free: true },
        { id: 4, networkId: 'b', speedBytesPerSec: 0, free: true }
      ]
    }
    // A stream on the slow chunk's own network waits for the other network's to take it.
    expect(
      s.take({ streamId: 3, networkId: 'a', speedBytesPerSec: 500_000 }, NOW, context)
    ).toBeUndefined()
    const hedge = s.take({ streamId: 4, networkId: 'b', speedBytesPerSec: 500_000 }, NOW, context)
    expect(hedge).toEqual({ kind: 'hedge', chunk: 0 })
    // At most maxHedgesPerChunk.
    expect(
      s.take({ streamId: 3, networkId: 'a', speedBytesPerSec: 500_000 }, NOW, {
        ...context,
        streams: context.streams.slice(0, 3)
      })
    ).toBeUndefined()
    // The hedge wins: the primary is the one to call off.
    expect(s.complete(0, 4)).toEqual([1])
    expect(s.attempts.has(0)).toBe(false)
  })

  test('no hedge while the disk is behind, or before an attempt has run long enough to judge', () => {
    const s = scheduler(1, [], 1_000_000)
    s.take({ streamId: 1, networkId: 'a' }, NOW - 1000, free([1, 'a']))
    const context: SteamPickContext = {
      streams: [
        { id: 1, networkId: 'a', speedBytesPerSec: 1, free: false },
        { id: 2, networkId: 'b', speedBytesPerSec: 0, free: true }
      ]
    }
    expect(s.take({ streamId: 2, networkId: 'b' }, NOW, context)).toBeUndefined()
    expect(
      s.take({ streamId: 2, networkId: 'b' }, NOW + 10_000, { ...context, diskBehind: true })
    ).toBeUndefined()
    expect(s.take({ streamId: 2, networkId: 'b' }, NOW + 10_000, context)?.kind).toBe('hedge')
  })

  test('when the primary lets go while its hedge runs, the hedge carries on as the chunk’s attempt', () => {
    const s = scheduler(1, [], 1_000_000)
    s.take({ streamId: 1, networkId: 'a' }, NOW - 10_000, free([1, 'a']))
    s.take({ streamId: 2, networkId: 'b' }, NOW, {
      streams: [
        { id: 1, networkId: 'a', speedBytesPerSec: 1, free: false },
        { id: 2, networkId: 'b', speedBytesPerSec: 0, free: true }
      ]
    })
    s.release(0, 1, false)
    expect(s.waiting).toBe(0)
    expect(s.attempts.get(0)?.map((attempt) => [attempt.streamId, attempt.kind])).toEqual([
      [2, 'primary']
    ])
  })

  test('whatever streams do, every chunk ends up done exactly once and none is ever lost', () => {
    const action = fc.record({
      stream: fc.integer({ min: 0, max: 3 }),
      outcome: fc.constantFrom('complete', 'fail', 'failSilent'),
      advance: fc.integer({ min: 0, max: 8000 })
    })
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 20 }),
        fc.array(action, { maxLength: 200 }),
        (count, actions) => {
          const s = scheduler(count, [], 100)
          const networks = ['a', 'a', 'b', 'b']
          const holding = new Map<number, number>()
          const completed = new Set<number>()
          let now = NOW
          const context = (): SteamPickContext => ({
            streams: networks.map((networkId, id) => ({
              id,
              networkId,
              speedBytesPerSec: 10,
              free: !holding.has(id)
            }))
          })
          const step = (stream: number, outcome: string): void => {
            const chunk = holding.get(stream)
            if (chunk === undefined) {
              const work = s.take(
                { streamId: stream, networkId: networks[stream], speedBytesPerSec: 1000 },
                now,
                context()
              )
              if (work) {
                expect(completed.has(work.chunk)).toBe(false)
                holding.set(stream, work.chunk)
              }
              return
            }
            holding.delete(stream)
            if (outcome === 'complete') {
              if (!completed.has(chunk)) {
                completed.add(chunk)
                for (const rival of s.complete(chunk, stream)) holding.delete(rival)
              }
            } else {
              s.release(chunk, stream, outcome === 'failSilent')
            }
          }
          for (const { stream, outcome, advance } of actions) {
            now += advance
            step(stream, outcome)
          }
          // Then every stream finishes whatever it is given, until nothing is left.
          for (let round = 0; round < count * 10 && !s.finished; round++) {
            for (let stream = 0; stream < networks.length; stream++) step(stream, 'complete')
          }
          expect(s.finished).toBe(true)
          expect(completed.size).toBe(count)
        }
      ),
      { numRuns: 300 }
    )
  })
})

test.describe('steam cells', () => {
  test('cells are contiguous runs of chunks, at most MAX_CELLS, of about equal bytes', () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 1, max: 2_000_000 }), { minLength: 1, maxLength: 5000 }),
        fc.integer({ min: 1, max: 300 }),
        (sizes, maxCells) => {
          const starts = planCells(sizes, maxCells)
          const cells = starts.length - 1
          expect(cells).toBe(Math.min(sizes.length, maxCells))
          expect(starts[0]).toBe(0)
          expect(starts[cells]).toBe(sizes.length)
          for (let i = 0; i < cells; i++) expect(starts[i + 1]).toBeGreaterThan(starts[i])
          // No cell holds much more than its share: a share, plus the chunk that crossed it.
          const total = sizes.reduce((sum, size) => sum + size, 0)
          const largest = Math.max(...sizes)
          for (let i = 0; i < cells; i++) {
            const bytes = sizes.slice(starts[i], starts[i + 1]).reduce((sum, size) => sum + size, 0)
            expect(bytes).toBeLessThanOrEqual(total / cells + largest)
          }
        }
      )
    )
    expect(planCells(new Uint32Array(100_000).fill(1000)).length - 1).toBe(MAX_CELLS)
  })

  test('a chunk done moves its cell’s bytes, the network’s credit and the totals, and back again', () => {
    const book = new ChunkBook(Uint32Array.from([10, 20, 30, 40]), Uint32Array.from([0, 2, 4]))
    expect(book.cells.map((cell) => [cell.rangeStart, cell.rangeEnd])).toEqual([
      [0, 29],
      [30, 99]
    ])
    book.inFlightChanged(0, 1)
    expect(book.cells[0].status).toBe('downloading')
    book.markDone(0, 'wifi')
    book.inFlightChanged(0, -1)
    expect(book.cells[0]).toMatchObject({
      status: 'pending',
      bytesDownloaded: 10,
      bytesByInterface: { wifi: 10 }
    })
    book.markDone(1, 'usb')
    expect(book.cells[0]).toMatchObject({
      status: 'completed',
      bytesDownloaded: 30,
      interfaceId: 'usb'
    })
    expect(book.markDone(1, 'usb')).toBe(0)
    expect([book.chunksDone, book.bytesDone]).toEqual([2, 30])
    book.markNotDone(1)
    expect(book.cells[0]).toMatchObject({
      status: 'pending',
      bytesDownloaded: 10,
      bytesByInterface: { wifi: 10 }
    })
    expect([book.chunksDone, book.bytesDone]).toEqual([1, 10])
  })

  test('progress saved and taken up again is the same progress; anything malformed starts over', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.tuple(fc.integer({ min: 1, max: 1000 }), fc.option(fc.constantFrom('a', 'b', 'c'))),
          { minLength: 1, maxLength: 300 }
        ),
        (chunks) => {
          const sizes = Uint32Array.from(chunks.map(([size]) => size))
          const book = new ChunkBook(sizes)
          chunks.forEach(([, network], i) => network && book.markDone(i, network))
          const restored = new ChunkBook(sizes)
          expect(restored.restore(JSON.parse(JSON.stringify(book.save())))).toBe(true)
          expect(restored.cells).toEqual(book.cells)
          expect([restored.chunksDone, restored.bytesDone]).toEqual([
            book.chunksDone,
            book.bytesDone
          ])
        }
      )
    )
    const sizes = Uint32Array.from([1, 2, 3])
    const fresh = (): ChunkBook => new ChunkBook(sizes)
    for (const saved of [
      null,
      'x',
      { networks: ['a'], done: Buffer.from([1, 0]).toString('base64') },
      { networks: ['a'], done: Buffer.from([1, 2, 0]).toString('base64') },
      { networks: [''], done: Buffer.from([1, 1, 1]).toString('base64') },
      { networks: 'a', done: '' }
    ]) {
      const book = fresh()
      expect(book.restore(saved)).toBe(false)
      expect(book.chunksDone).toBe(0)
    }
  })
})
