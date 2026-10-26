import { expect, test } from '@playwright/test'
import fc from 'fast-check'
import {
  interleave,
  MAX_STREAMS_PER_NETWORK,
  START_STREAMS_PER_NETWORK,
  startingStreams
} from '../src/main/download/plan'

// How many streams a network starts on a download's waiting chunks, and in what order they
// start. Pure, so it's checked over the whole input space instead of hand-picked numbers.

test.describe('download plan', () => {
  test('a joining network gets a stream, and never one with no chunk to claim', () => {
    fc.assert(
      fc.property(
        fc.nat(10_000),
        fc.integer({ min: 1, max: 6 }),
        fc.option(fc.integer({ min: 1, max: 20 }), { nil: undefined }),
        (waiting, networkCount, requested) => {
          const count = startingStreams(waiting, networkCount, requested)
          expect(count).toBeGreaterThanOrEqual(1)
          expect(count).toBeLessThanOrEqual(requested ?? START_STREAMS_PER_NETWORK)
          expect(count).toBeLessThanOrEqual(MAX_STREAMS_PER_NETWORK)
          // Streams beyond the waiting chunks would idle — except the one each network keeps.
          expect(count).toBeLessThanOrEqual(Math.max(1, Math.ceil(waiting / networkCount)))
        }
      )
    )
  })

  test('one chunk left: each network still gets a stream', () => {
    expect(startingStreams(1, 2, 8)).toBe(1)
  })

  test('interleave serves every group before any twice, keeping each group in order', () => {
    expect(interleave(['a', 'a', 'a', 'b', 'b'], (id) => id)).toEqual(['a', 'b', 'a', 'b', 'a'])
    fc.assert(
      fc.property(fc.array(fc.tuple(fc.integer({ min: 0, max: 3 }), fc.nat())), (items) => {
        const out = interleave(items, ([group]) => group)
        expect(out).toHaveLength(items.length)
        for (const group of new Set(items.map(([g]) => g))) {
          expect(out.filter(([g]) => g === group)).toEqual(items.filter(([g]) => g === group))
        }
      })
    )
  })
})
