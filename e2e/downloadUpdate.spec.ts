import { expect, test } from '@playwright/test'
import { applyDownloadUpdate } from '../src/shared/downloadUpdate'
import type { SteamCellState, SteamDownloadUpdate } from '../src/shared/types'

// How the window puts a download back together from the updates the main process sends: a
// snapshot, then only the cells that changed.

const cell = (index: number, bytesDownloaded = 0): SteamCellState => ({
  kind: 'steam',
  index,
  rangeStart: index * 100,
  rangeEnd: index * 100 + 99,
  status: bytesDownloaded === 100 ? 'completed' : bytesDownloaded ? 'downloading' : 'pending',
  bytesDownloaded,
  bytesByInterface: bytesDownloaded ? { a: bytesDownloaded } : {}
})

const update = (seq: number, cells: SteamCellState[], id = 'd1'): SteamDownloadUpdate => ({
  seq,
  state: {
    kind: 'steam',
    id,
    url: 'steam://app/480',
    fileName: 'Spacewar',
    destinationPath: '/tmp/Spacewar',
    totalBytes: 400,
    bytesDownloaded: cells.reduce((sum, entry) => sum + entry.bytesDownloaded, 0),
    speedBytesPerSec: 0,
    status: 'downloading',
    networks: [],
    streams: [],
    peakStreams: 0,
    totalCells: 4,
    totalChunks: 40,
    chunksDone: 0,
    app: { appId: 480, name: 'Spacewar', branch: 'public' },
    depots: [],
    fileCount: 2,
    installBytes: 1000,
    startedAt: 0
  },
  cells
})

const full = (seq: number, id = 'd1'): SteamDownloadUpdate =>
  update(seq, [cell(0), cell(1), cell(2), cell(3)], id)

test.describe('download updates', () => {
  test('changed cells land on the ones already there', () => {
    const start = applyDownloadUpdate(null, full(1))!
    const next = applyDownloadUpdate(start, update(2, [cell(1, 50)]))!
    expect(next.cells.map((entry) => entry.bytesDownloaded)).toEqual([0, 50, 0, 0])
    expect(next.seq).toBe(2)
    // What was there is left untouched.
    expect(start.cells[1].bytesDownloaded).toBe(0)
  })

  test('an update sent before a snapshot was taken, arriving after it, is ignored', () => {
    const snapshot = applyDownloadUpdate(
      null,
      update(5, [cell(0, 100), cell(1, 80), cell(2), cell(3)])
    )
    expect(applyDownloadUpdate(snapshot, update(4, [cell(1, 40)]))).toBe(snapshot)
    // And a snapshot older than what is already there changes nothing.
    const newer = applyDownloadUpdate(snapshot, update(6, [cell(1, 100)]))
    expect(applyDownloadUpdate(newer, full(5))).toBe(newer)
  })

  test('a download with no whole picture yet waits for one', () => {
    // A window that has just loaded can be sent a partial update before its snapshot comes back.
    expect(applyDownloadUpdate(null, update(3, [cell(2, 10)]))).toBeNull()
    const previous = applyDownloadUpdate(null, full(1, 'old'))
    expect(applyDownloadUpdate(previous, update(3, [cell(2, 10)], 'new'))).toBe(previous)
    // A new download's first update has every cell, and stands on its own.
    expect(applyDownloadUpdate(previous, full(1, 'new'))?.id).toBe('new')
  })
})
