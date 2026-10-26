// How many streams a network starts on a download, and in what order they start. Pure, so every
// rule here can be checked against exact situations. How many streams a network ends up with is
// decided while the download runs (see concurrency.ts).

/** Streams each network starts with, as download managers do (IDM, XDM: 8). From there it
 * doubles once they are all receiving (see concurrency.ts). */
export const START_STREAMS_PER_NETWORK = 8
/** The most streams a network can grow to (IDM's limit). Enough for a far server, where TCP holds
 * each connection to a megabyte or so a second; a server that wants fewer says so by refusing. */
export const MAX_STREAMS_PER_NETWORK = 32

/** Lays `items` out one from each group in turn (a, b, a, b, …), keeping each group's own
 * order. Groups are visited in order of first appearance. */
export function interleave<T>(items: readonly T[], groupOf: (item: T) => unknown): T[] {
  const lanes = new Map<unknown, T[]>()
  for (const item of items) {
    const lane = lanes.get(groupOf(item))
    if (lane) lane.push(item)
    else lanes.set(groupOf(item), [item])
  }

  const out: T[] = []
  for (let round = 0; out.length < items.length; round++) {
    for (const lane of lanes.values()) {
      if (round < lane.length) out.push(lane[round])
    }
  }
  return out
}

const clamp = (value: number, min: number, max: number): number =>
  Math.min(Math.max(value, min), max)

/** Streams to start on each of `networkCount` networks joining a download with `waiting` chunks
 * nobody has taken: START_STREAMS_PER_NETWORK, unless a test pins `requested`. A stream with no
 * chunk to claim would only sit idle, so near the end, or on a small game, fewer — but never
 * none, so a network that joins can still race a slow chunk (see steam/scheduler.ts). */
export function startingStreams(
  waiting: number,
  networkCount: number,
  requested = START_STREAMS_PER_NETWORK
): number {
  const perNetwork = Math.ceil(waiting / Math.max(1, networkCount))
  return Math.max(1, Math.min(clamp(Math.floor(requested), 1, MAX_STREAMS_PER_NETWORK), perNetwork))
}
