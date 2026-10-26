import type { DownloadState, DownloadUpdate } from './types'

/** The download as `current` plus `update`: what anything watching a download keeps. */
export function applyDownloadUpdate(
  current: DownloadState | null,
  update: DownloadUpdate
): DownloadState | null {
  const { state, cells: changed, seq } = update
  if (current?.id === state.id && current.kind === state.kind) {
    if ((current.seq ?? 0) >= seq) return current
    let cells = current.cells
    if (changed.length > 0) {
      cells = [...cells]
      for (const cell of changed) cells[cell.index] = cell
    }
    return { ...state, cells, seq }
  }
  // A download first seen in an update that has only some of its cells: wait for a snapshot.
  if (changed.length < state.totalCells) return current
  return { ...state, cells: changed, seq }
}
