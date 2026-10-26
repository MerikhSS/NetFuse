import { expect, test } from '@playwright/test'
import type { SteamDownloadState } from '../src/shared/types'
import { checkEvents } from './fixtures'

const paused = (): SteamDownloadState => ({
  kind: 'steam',
  id: 'invariant-download',
  url: 'steam://app/4000',
  fileName: 'Game',
  destinationPath: '/tmp/Game',
  totalBytes: 100,
  bytesDownloaded: 100,
  speedBytesPerSec: 0,
  status: 'paused',
  networks: [
    {
      transfer: 'steam',
      id: 'a',
      label: 'a',
      kind: 'ethernet',
      enabled: true,
      status: 'on',
      bytesDownloaded: 100,
      speedBytesPerSec: 0,
      retries: 0
    }
  ],
  streams: [],
  peakStreams: 0,
  totalCells: 1,
  totalChunks: 1,
  chunksDone: 1,
  app: { appId: 4000, name: 'Game', branch: 'public' },
  depots: [],
  fileCount: 1,
  installBytes: 100,
  startedAt: 0,
  cells: [
    {
      kind: 'steam',
      index: 0,
      rangeStart: 0,
      rangeEnd: 99,
      status: 'completed',
      bytesDownloaded: 100,
      bytesByInterface: { a: 100 }
    }
  ]
})

test('event validation retains integrity failures and download context', () => {
  const valid = paused()
  expect(() =>
    checkEvents([[valid, { ...valid, status: 'downloading' }, { ...valid, status: 'completed' }]])
  ).not.toThrow()

  const corrupt = paused()
  corrupt.cells[0].bytesByInterface.a = 99
  expect(() => checkEvents([[corrupt]])).toThrow(/invariant-download.*cell 0 attribution/)

  const short = paused()
  short.cells[0].bytesDownloaded = 99
  short.cells[0].bytesByInterface.a = 99
  expect(() => checkEvents([[short]])).toThrow(/invariant-download.*completed cell 0 is full/)

  expect(() => checkEvents([[{ ...valid, status: 'completed' }, valid]])).toThrow(
    /completed → paused/
  )
})

test('event validation checks long histories without per-cell report steps', () => {
  const state = paused()
  state.cells = Array.from({ length: 256 }, (_, index) => ({
    ...state.cells[0],
    index,
    rangeStart: index * 100,
    rangeEnd: index * 100 + 99
  }))
  state.totalCells = state.totalChunks = state.chunksDone = state.cells.length
  state.totalBytes = state.bytesDownloaded = state.totalCells * 100
  state.networks[0].bytesDownloaded = state.totalBytes
  const history = Array.from({ length: 1000 }, () => state)
  expect(() => checkEvents([history])).not.toThrow()
  // A failure at the end must still be inspected, rather than sampling a large history.
  const bad = { ...state, bytesDownloaded: state.totalBytes + 1 }
  expect(() => checkEvents([[...history, bad]])).toThrow(/bytesDownloaded ≤ totalBytes/)
})
