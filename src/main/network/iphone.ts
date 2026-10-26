import type { IphoneTetherState } from '../../shared/types'

// Windows has no driver of its own for an iPhone's USB tethering. Apple's, which names the
// network adapter "Apple Mobile Device Ethernet", comes with its Apple Devices app or iTunes, so
// an iPhone plugged into a fresh Windows charges but never becomes a network. NetFuse notices the
// iPhone and says how to fix it (see iphoneWatch.ts). macOS and Linux have the driver built in.
// Pure, so it can be unit-tested.

/** USB product ids of iPhones, under Apple's vendor id 05AC. 12A8 is every iPhone since the 5;
 * the others are older ones. iPads and iPods have their own, and aren't asked about. */
const IPHONE_PRODUCT_IDS = new Set(['1290', '1292', '1294', '1297', '129C', '12A0', '12A8'])

/** Whether a Windows device instance id ("USB\VID_05AC&PID_12A8\00008110001A…") is an iPhone
 * itself, rather than one of its interfaces ("…&PID_12A8&MI_00\…") or anything else. */
export function isIphoneDeviceId(id: string): boolean {
  const match = /^USB\\VID_05AC&PID_([0-9A-F]{4})\\/i.exec(id)
  return !!match && IPHONE_PRODUCT_IDS.has(match[1].toUpperCase())
}

/** The ids in a list as Windows returns them: UTF-16 strings, each ended by a NUL, the whole
 * list by one more. */
export function readIdList(buffer: Buffer): string[] {
  return buffer.toString('utf16le').split('\0').filter(Boolean)
}

/** Apple's driver gives its adapter the same description in every language, numbered after the
 * first ("Apple Mobile Device Ethernet #2"). */
export const isIphoneAdapter = (description: string): boolean =>
  /apple mobile device ethernet/i.test(description)

/** How long an iPhone gets to come up as a network by itself before anything is said: with
 * everything set up, Windows still takes a few seconds to give it an address. */
export const SETTLE_MS = 10_000

/** What one look found. */
export interface IphoneLook {
  /** An iPhone is plugged in. */
  connected: boolean
  /** Its tethering is one of the networks NetFuse can use; null when that can't be told. */
  tethered: boolean | null
  /** Windows has an adapter from Apple's driver, connected or not: the driver is there. */
  driverInstalled: boolean
}

/** What to tell people, from a look and since when the iPhone has been plugged in without being a
 * network (null if it hasn't). Nothing when it can't be told whether it's tethered: a popup
 * about a phone that's working would be worse than none. */
export function iphoneTetherState(
  look: IphoneLook,
  untetheredSince: number | null,
  now: number,
  settleMs = SETTLE_MS
): IphoneTetherState {
  if (!look.connected || look.tethered !== false || untetheredSince === null) {
    return { status: 'none' }
  }
  if (now - untetheredSince < settleMs) return { status: 'none' }
  return { status: 'not-tethered', driverInstalled: look.driverInstalled }
}
