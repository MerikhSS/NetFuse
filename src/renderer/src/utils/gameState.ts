import type { DownloadState, FinishedDownload } from '@shared/types'
import { formatPercent } from './format'

/** Where one game stands on this computer, as the library and its page show it. */
export type GameState =
  | { kind: 'none' }
  /** The Steam client has it installed (it isn't one of this app's own). */
  | { kind: 'in-steam' }
  | { kind: 'installed'; downloadId: string }
  | {
      kind: 'downloading' | 'queued' | 'paused' | 'error'
      downloadId: string
      percent: number
    }

/** A game's newest download that isn't over decides; then a finished one still where it was put;
 * then whether the Steam client has it. */
export function gameState(
  appId: number,
  downloads: Record<string, DownloadState>,
  history: FinishedDownload[],
  clientApps: number[]
): GameState {
  let latest: DownloadState | undefined
  for (const download of Object.values(downloads)) {
    if (download.app.appId !== appId || download.status === 'cancelled') continue
    if (!latest || download.startedAt > latest.startedAt) latest = download
  }
  if (latest && latest.status !== 'completed' && latest.status !== 'cancelled') {
    return {
      kind: latest.status,
      downloadId: latest.id,
      percent: formatPercent(latest.bytesDownloaded, latest.totalBytes)
    }
  }
  if (latest) return { kind: 'installed', downloadId: latest.id }
  // History is newest first.
  const finished = history.find((entry) => entry.app.appId === appId && !entry.missing)
  if (finished) return { kind: 'installed', downloadId: finished.id }
  return clientApps.includes(appId) ? { kind: 'in-steam' } : { kind: 'none' }
}

/** How a game's state reads under its picture. */
export function describeGameState(state: GameState): string | null {
  switch (state.kind) {
    case 'downloading':
      return `Downloading · ${state.percent}%`
    case 'queued':
      return 'Queued'
    case 'paused':
      return `Paused at ${state.percent}%`
    case 'error':
      return 'Download failed'
    case 'installed':
      return 'Installed'
    case 'in-steam':
      return 'Installed in Steam'
    case 'none':
      return null
  }
}
