import type { IphoneTetherState } from '@shared/types'
import { Smartphone } from 'lucide-react'
import { useEffect, useState } from 'react'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle
} from './ui/alert-dialog'
import { Button } from './ui/button'

/** On Windows, an iPhone plugged in that isn't a network yet (see main/network/iphone.ts): what
 * it takes, with the way to Apple's app that brings the driver. Said once each time it's plugged
 * in, and gone by itself once the iPhone is a network. */
export function IphoneTetherDialog(): React.JSX.Element {
  const [state, setState] = useState<IphoneTetherState>({ status: 'none' })
  const [dismissed, setDismissed] = useState(false)
  // Kept from the last time it showed, so the steps don't change while it fades out.
  const [driverInstalled, setDriverInstalled] = useState(false)

  useEffect(() => {
    let current = true
    const unsubscribe = window.netfuse.onIphoneTether(setState)
    window.netfuse.iphoneTether().then(
      (initial) => current && setState(initial),
      () => {}
    )
    return () => {
      current = false
      unsubscribe()
    }
  }, [])

  // Unplugged or a network, it's said again the next time it's plugged in without being one.
  if (state.status === 'none' && dismissed) setDismissed(false)
  if (state.status === 'not-tethered' && state.driverInstalled !== driverInstalled) {
    setDriverInstalled(state.driverInstalled)
  }

  return (
    <AlertDialog
      open={state.status === 'not-tethered' && !dismissed}
      onOpenChange={(open) => {
        if (!open) setDismissed(true)
      }}
    >
      <AlertDialogContent className="sm:max-w-md">
        <AlertDialogHeader>
          <div className="mb-1 flex size-9 items-center justify-center rounded-full bg-[var(--color-usb-bg)] text-[var(--color-usb-text)]">
            <Smartphone aria-hidden className="size-4.5" />
          </div>
          <AlertDialogTitle>Use your iPhone as a network</AlertDialogTitle>
          <AlertDialogDescription>
            Your iPhone is plugged in, but Windows can&apos;t use its connection yet. Once it can,
            NetFuse adds it to your networks by itself.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <ol className="mt-3 flex list-decimal flex-col gap-1.5 pl-5 text-sm leading-snug">
          {!driverInstalled && (
            <li>
              Install <strong>Apple Devices</strong>, Apple&apos;s free app, unless you have it or
              iTunes already. It brings the driver Windows needs.
            </li>
          )}
          <li>
            Unlock your iPhone, and tap <strong>Trust</strong> if it asks.
          </li>
          <li>
            On the iPhone, open Settings › Personal Hotspot and turn on{' '}
            <strong>Allow Others to Join</strong>.
          </li>
        </ol>
        <AlertDialogFooter>
          {driverInstalled ? (
            <AlertDialogAction>Got it</AlertDialogAction>
          ) : (
            <>
              <AlertDialogCancel>Not now</AlertDialogCancel>
              {/* Stays open: the steps after the install are still to do. */}
              <Button size="sm" onClick={() => void window.netfuse.openAppleDevices()}>
                Get Apple Devices
              </Button>
            </>
          )}
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
