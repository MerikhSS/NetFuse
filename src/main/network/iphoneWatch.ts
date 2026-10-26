import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { IKoffiLib } from 'koffi'
import type { IphoneTetherState } from '../../shared/types'
import { testIphone, testKnobs } from '../testKnobs'
import { iphoneTethered, type NetworkMonitor } from './interfaces'
import {
  iphoneTetherState,
  isIphoneAdapter,
  isIphoneDeviceId,
  readIdList,
  type IphoneLook
} from './iphone'

// Watches, on Windows, for an iPhone plugged in that isn't a network (see iphone.ts). Nothing
// tells a process when a USB device arrives, so it looks: a list of the USB devices plugged in is
// one quick system call.

const execFileAsync = promisify(execFile)

const POLL_MS = 2000
/** Whether Apple's driver is there takes a PowerShell to tell, so it's only asked while an iPhone
 * waits to become a network, and again at most this often, to see it once it's installed. */
const DRIVER_CHECK_MS = 15_000
const DRIVER_CHECK_TIMEOUT_MS = 5000

// CM_Get_Device_ID_List's flags: the devices of one enumerator ("USB"), and only those present.
const CM_GETIDLIST_FILTER_ENUMERATOR = 0x1
const CM_GETIDLIST_FILTER_PRESENT = 0x100
/** CM_Locate_DevNode finds a device only while it's plugged in. */
const CM_LOCATE_DEVNODE_NORMAL = 0
const CR_SUCCESS = 0

type KoffiFunction = ReturnType<IKoffiLib['func']>

interface Cfgmgr32 {
  listSize: KoffiFunction
  list: KoffiFunction
  locate: KoffiFunction
}

let cfgmgr32: Promise<Cfgmgr32 | null> | null = null

function load(): Promise<Cfgmgr32 | null> {
  cfgmgr32 ??= (async () => {
    try {
      const { default: koffi } = await import('koffi')
      const lib = koffi.load('cfgmgr32.dll')
      return {
        listSize: lib.func(
          'uint32_t __stdcall CM_Get_Device_ID_List_SizeW(_Out_ uint32_t *length, const char16_t *filter, uint32_t flags)'
        ),
        list: lib.func(
          'uint32_t __stdcall CM_Get_Device_ID_ListW(const char16_t *filter, void *buffer, uint32_t length, uint32_t flags)'
        ),
        locate: lib.func(
          'uint32_t __stdcall CM_Locate_DevNodeW(_Out_ uint32_t *devInst, const char16_t *id, uint32_t flags)'
        )
      }
    } catch (error) {
      console.warn('USB devices unavailable:', error)
      return null
    }
  })()
  return cfgmgr32
}

const call = <T>(fn: KoffiFunction, ...args: unknown[]): Promise<T> =>
  new Promise((resolve, reject) =>
    fn.async(...args, (error: unknown, result: T) => (error ? reject(error) : resolve(result)))
  )

/** Whether an iPhone is among the USB devices plugged in; null when they can't be listed. */
async function iphoneConnected(): Promise<boolean | null> {
  const lib = await load()
  if (!lib) return null
  const flags = CM_GETIDLIST_FILTER_ENUMERATOR | CM_GETIDLIST_FILTER_PRESENT
  try {
    // In UTF-16 units. A device arriving in between makes the list too long for it, and the
    // second call fails: the next look reads it again.
    const length = [0]
    if ((await call<number>(lib.listSize, length, 'USB', flags)) !== CR_SUCCESS) return null
    const buffer = Buffer.alloc(length[0] * 2)
    if ((await call<number>(lib.list, 'USB', buffer, length[0], flags)) !== CR_SUCCESS) return null
    // Each iPhone listed is looked up again, as only a device plugged in can be: one remembered
    // from before would otherwise bring the popup up with no iPhone there.
    for (const id of readIdList(buffer).filter(isIphoneDeviceId)) {
      if ((await call<number>(lib.locate, [0], id, CM_LOCATE_DEVNODE_NORMAL)) === CR_SUCCESS) {
        return true
      }
    }
    return false
  } catch {
    return null
  }
}

/** Whether Windows has an adapter from Apple's driver, connected or not. Get-NetAdapter lists
 * those whose cable is "unplugged", as an iPhone's is with its hotspot off. */
async function appleDriverInstalled(): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync(
      'powershell.exe',
      [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; Get-NetAdapter -ErrorAction Stop | ForEach-Object InterfaceDescription'
      ],
      { windowsHide: true, timeout: DRIVER_CHECK_TIMEOUT_MS, encoding: 'utf8' }
    )
    return stdout.split(/\r?\n/).some(isIphoneAdapter)
  } catch {
    return false
  }
}

/** An iPhone as the test stand-in describes it (see testKnobs.testIphone). */
function fakeLook(fake: NonNullable<ReturnType<typeof testIphone>>): IphoneLook {
  return {
    connected: fake !== 'unplugged',
    tethered: fake === 'tethered',
    driverInstalled: fake === 'hotspot-off' || fake === 'tethered'
  }
}

/** The iPhone popup's state, kept current: `onChange` hears of every change. On macOS and Linux,
 * which tether an iPhone by themselves, it never looks. */
export class IphoneWatch {
  private state: IphoneTetherState = { status: 'none' }
  private untetheredSince: number | null = null
  private driver: { installed: boolean; checkedAt: number } | null = null
  private looking = false

  constructor(
    private readonly networks: NetworkMonitor,
    private readonly onChange: (state: IphoneTetherState) => void
  ) {
    if (process.platform !== 'win32' && testIphone() === undefined) return
    setInterval(() => void this.look(), POLL_MS).unref()
  }

  get current(): IphoneTetherState {
    return this.state
  }

  private async look(): Promise<void> {
    // A slow PowerShell mustn't have looks pile up behind it.
    if (this.looking) return
    this.looking = true
    try {
      const look = await this.see()
      if (!look) return
      const now = Date.now()
      if (look.connected && look.tethered === false) this.untetheredSince ??= now
      else this.untetheredSince = null
      const next = iphoneTetherState(look, this.untetheredSince, now, testKnobs.iphoneSettleMs)
      if (JSON.stringify(next) !== JSON.stringify(this.state)) {
        this.state = next
        this.onChange(next)
      }
    } finally {
      this.looking = false
    }
  }

  /** One look; null when it can't be told, which leaves things as they were. */
  private async see(): Promise<IphoneLook | null> {
    const fake = testIphone()
    if (fake) return fakeLook(fake)
    if (process.platform !== 'win32') return null

    const connected = await iphoneConnected()
    if (connected === null) return null
    if (!connected) {
      this.driver = null
      return { connected, tethered: null, driverInstalled: false }
    }
    const networks = this.networks.current
    const tethered = networks ? await iphoneTethered(networks) : null
    if (
      tethered === false &&
      (!this.driver || Date.now() - this.driver.checkedAt >= DRIVER_CHECK_MS)
    ) {
      this.driver = { installed: await appleDriverInstalled(), checkedAt: Date.now() }
    }
    return { connected, tethered, driverInstalled: this.driver?.installed ?? false }
  }
}
