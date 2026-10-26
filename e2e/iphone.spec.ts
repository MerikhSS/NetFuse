import { expect, test } from '@playwright/test'
import {
  iphoneTetherState,
  isIphoneAdapter,
  isIphoneDeviceId,
  readIdList,
  SETTLE_MS,
  type IphoneLook
} from '../src/main/network/iphone'

// How NetFuse tells, on Windows, that an iPhone is plugged in without being a network. The popup
// it leads to is in iphoneTether.spec.ts.

test('an iPhone is told from its own interfaces, iPads and other devices', () => {
  expect(isIphoneDeviceId('USB\\VID_05AC&PID_12A8\\00008110001A2B3C4D5E6F78')).toBe(true)
  expect(isIphoneDeviceId('usb\\vid_05ac&pid_12a8\\00008110001a2b3c')).toBe(true)
  expect(isIphoneDeviceId('USB\\VID_05AC&PID_12A0\\4b1f0c2a')).toBe(true)
  // The same iPhone's interfaces, under its composite device.
  expect(isIphoneDeviceId('USB\\VID_05AC&PID_12A8&MI_00\\7&2F3A1B&0&0000')).toBe(false)
  // An iPad, another maker under the same product id, a hub.
  expect(isIphoneDeviceId('USB\\VID_05AC&PID_12AB\\00008027000A1B2C')).toBe(false)
  expect(isIphoneDeviceId('USB\\VID_046D&PID_12A8\\5&1A2B3C&0&2')).toBe(false)
  expect(isIphoneDeviceId('USB\\ROOT_HUB30\\4&1A2B3C&0&0')).toBe(false)
})

test('the device list is read as Windows writes it', () => {
  const list = Buffer.from(
    'USB\\ROOT_HUB30\\4&1A2B3C&0&0\0USB\\VID_05AC&PID_12A8\\00008110001A2B3C\0\0',
    'utf16le'
  )
  expect(readIdList(list)).toEqual([
    'USB\\ROOT_HUB30\\4&1A2B3C&0&0',
    'USB\\VID_05AC&PID_12A8\\00008110001A2B3C'
  ])
  expect(readIdList(Buffer.from('\0', 'utf16le'))).toEqual([])
})

test("Apple's adapter is known whatever its number", () => {
  expect(isIphoneAdapter('Apple Mobile Device Ethernet')).toBe(true)
  expect(isIphoneAdapter('Apple Mobile Device Ethernet #2')).toBe(true)
  expect(isIphoneAdapter('Remote NDIS based Internet Sharing Device')).toBe(false)
  expect(isIphoneAdapter('Intel(R) Ethernet Connection (7) I219-V')).toBe(false)
})

test('the popup waits for the iPhone to settle, and stays away while it can’t be told', () => {
  const unplugged: IphoneLook = { connected: false, tethered: null, driverInstalled: false }
  const waiting: IphoneLook = { connected: true, tethered: false, driverInstalled: false }
  const at = 1_000_000

  expect(iphoneTetherState(unplugged, null, at)).toEqual({ status: 'none' })
  // Just plugged in: Windows may still be giving a working tether its address.
  expect(iphoneTetherState(waiting, at, at + SETTLE_MS - 1)).toEqual({ status: 'none' })
  expect(iphoneTetherState(waiting, at, at + SETTLE_MS)).toEqual({
    status: 'not-tethered',
    driverInstalled: false
  })
  expect(iphoneTetherState({ ...waiting, driverInstalled: true }, at, at + SETTLE_MS)).toEqual({
    status: 'not-tethered',
    driverInstalled: true
  })
  // A network already, or no telling: nothing to say.
  expect(iphoneTetherState({ ...waiting, tethered: true }, at, at + SETTLE_MS)).toEqual({
    status: 'none'
  })
  expect(iphoneTetherState({ ...waiting, tethered: null }, at, at + SETTLE_MS)).toEqual({
    status: 'none'
  })
})
