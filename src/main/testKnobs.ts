import { app } from 'electron'
import { isIP } from 'node:net'
import type { NetworkInterfaceInfo } from '../shared/types'

// Overrides for the end-to-end suite (e2e/), read from the environment. A packaged build ignores
// all of them, so a shipped app can't be steered through its environment variables.
const env: NodeJS.ProcessEnv = app.isPackaged ? {} : process.env

function positiveNumber(name: string, fallback: number): number {
  const value = Number(env[name])
  return value > 0 ? value : fallback
}

export const testKnobs = {
  userDataDir: env['NETFUSE_USER_DATA'],
  /** Keeps the window off-screen so a test run doesn't pop windows up over the desktop. */
  hideWindow: env['NETFUSE_E2E_HIDE_WINDOW'] === '1',
  retryBaseDelayMs: positiveNumber('NETFUSE_E2E_RETRY_BASE_MS', 1000),
  stallTimeoutMs: positiveNumber('NETFUSE_E2E_STALL_MS', 20_000),
  connectTimeoutMs: positiveNumber('NETFUSE_E2E_CONNECT_MS', 10_000),
  /** How long a server that keeps answering busy (429, 503, …) is waited out; see
   * steam/steamTransfer.ts. */
  serverBusyForMs: positiveNumber('NETFUSE_E2E_SERVER_BUSY_MS', 5 * 60_000),
  silentAfterMs: positiveNumber('NETFUSE_E2E_SILENT_MS', 5_000),
  hedgeAfterMs: positiveNumber('NETFUSE_E2E_HEDGE_MS', 2_000),
  /** How long a plugged-in iPhone gets to become a network before NetFuse says how; see
   * network/iphone.ts. */
  iphoneSettleMs: positiveNumber('NETFUSE_E2E_IPHONE_SETTLE_MS', 10_000)
}

/** What an iPhone plugged into Windows looks like, in place of looking (see network/iphone.ts):
 * `unplugged`, `no-driver` (plugged in, Apple's driver missing), `hotspot-off` (the driver there,
 * no network) or `tethered`. Set at launch, it also watches on systems other than Windows. Read on
 * every call, so a test can plug and unplug the phone by rewriting process.env in the main
 * process. */
export type TestIphone = 'unplugged' | 'no-driver' | 'hotspot-off' | 'tethered'

export function testIphone(): TestIphone | undefined {
  if (app.isPackaged) return undefined
  const value = process.env['NETFUSE_E2E_IPHONE']
  return value === 'unplugged' ||
    value === 'no-driver' ||
    value === 'hotspot-off' ||
    value === 'tethered'
    ? value
    : undefined
}

/** `NETFUSE_E2E_STEAM=http://127.0.0.1:1234` stands a local fake in for Steam itself (see
 * steam/fakeBackend.ts and e2e/steamOrigin.ts). Read when Steam is first used rather than at
 * launch, so a test can start its fake Steam after the app. */
export function testSteamFake(): string | undefined {
  if (app.isPackaged) return undefined
  return process.env['NETFUSE_E2E_STEAM'] || undefined
}

/** `NETFUSE_E2E_STEAM_ROOT=/tmp/x/Steam` is the only place NetFuse looks for the Steam client's
 * folder (see steam/steamFolders.ts), so a test can stand up a Steam library of its own. Read on
 * every call, like the others below. */
export function testSteamRoot(): string | undefined {
  if (app.isPackaged) return undefined
  return process.env['NETFUSE_E2E_STEAM_ROOT']
}

/** `NETFUSE_E2E_STREAMS=2` fixes how many streams each network runs and turns the automatic
 * sizing off, so a test can count requests. Read on every call rather than once, so a test can
 * change it between downloads. */
export function testStreamsPerNetwork(): number | null {
  if (app.isPackaged) return null
  const value = Number(process.env['NETFUSE_E2E_STREAMS'])
  return value > 0 ? value : null
}

/** `NETFUSE_E2E_INTERFACES=a=127.0.0.1,b=192.168.1.5` replaces the real interface list. Read on
 * every call rather than once, so a test can make a network "disappear" mid-download by
 * rewriting process.env in the main process. */
export function testInterfaces(): NetworkInterfaceInfo[] | null {
  if (app.isPackaged) return null
  const raw = process.env['NETFUSE_E2E_INTERFACES']
  if (raw === undefined) return null
  return raw
    .split(',')
    .filter(Boolean)
    .map((entry) => {
      const [id, address, subnet, kind] = entry.split('=')
      const inferredKind =
        kind === 'usb'
          ? ('usb' as const)
          : kind === 'wifi' ||
              id.toLowerCase().includes('wi-fi') ||
              id.toLowerCase().includes('wifi')
            ? ('wifi' as const)
            : ('ethernet' as const)
      return {
        id,
        device: id,
        displayName: id,
        addresses: [{ address, family: isIP(address) === 6 ? 6 : 4, subnet: subnet || undefined }],
        kind: inferredKind
      }
    })
}
