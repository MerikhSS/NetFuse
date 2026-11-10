import { useState } from 'react'
import { useAppStore } from '../store/useAppStore'
import { useNetworkUsage } from './useNetworks'

// Which networks a download goes over, as a game's page and a Workshop item's page offer them
// (NetworkChips): every network but those turned off in their settings, to start with, and never
// none. One past its data allowance can't be picked.

export interface NetworkChoice {
  /** The networks picked that can be used. */
  networkIds: string[]
  isReached: (id: string) => boolean
  toggle: (id: string) => void
}

export function useNetworkChoice(): NetworkChoice {
  const interfaces = useAppStore((store) => store.interfaces)
  const networkPreferences = useAppStore((store) => store.networkPreferences)
  const usage = useNetworkUsage(true)
  const [deselected, setDeselected] = useState<string[]>(() =>
    Object.entries(useAppStore.getState().networkPreferences)
      .filter(([, preference]) => preference.off)
      .map(([id]) => id)
  )

  const isReached = (id: string): boolean => {
    const dataLimit = networkPreferences[id]?.dataLimit
    return dataLimit !== undefined && (usage[id] ?? 0) >= dataLimit
  }
  const availableIds = interfaces.map((iface) => iface.id).filter((id) => !isReached(id))
  const networkIds = availableIds.filter((id) => !deselected.includes(id))
  const toggle = (id: string): void => {
    if (isReached(id)) return
    setDeselected((previous) => {
      if (previous.includes(id)) return previous.filter((entry) => entry !== id)
      const remaining = availableIds.filter((other) => !previous.includes(other) && other !== id)
      return remaining.length === 0 ? previous : [...previous, id]
    })
  }
  return { networkIds, isReached, toggle }
}
