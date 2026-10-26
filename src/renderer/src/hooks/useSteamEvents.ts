import { useEffect } from 'react'
import { useAppStore } from '../store/useAppStore'

/** Keeps the Steam login the window shows as main says it is. Asking for it once, as the window
 * opens, is what logs in with a remembered login; every change after is pushed. */
export function useSteamEvents(): void {
  const receive = useAppStore((store) => store.receiveSteamLogin)
  useEffect(() => {
    const stop = window.netfuse.onSteamLoginState(receive)
    void window.netfuse
      .steamLoginState()
      .then(receive)
      .catch(() => {})
    return stop
  }, [receive])
}
