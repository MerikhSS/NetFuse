import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '../store/useAppStore'
import { gameState, type GameState } from '../utils/gameState'

/** One game's state, re-rendering only when it changes: a progress tick for another game, or
 * one that doesn't move this one's percent, leaves it alone. */
export function useGameState(appId: number): GameState {
  return useAppStore(
    useShallow((store) => gameState(appId, store.downloads, store.history, store.clientApps))
  )
}
