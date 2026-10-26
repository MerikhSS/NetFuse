import { existsSync } from 'node:fs'
import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test, type NetFuseApp } from './fixtures'
import { ACCOUNT, GUARD_CODE, type SteamOrigin } from './steamOrigin'

// The Steam login's secrets — the password, the Steam Guard code, the refresh token Steam hands
// back, the depot keys, manifest request codes and CDN tokens — go where they are needed and
// nowhere else: never to the window, never into the app's output, never into a file under
// userData. A remembered login is kept only sealed by the system keychain, and only when there is
// a real one.

/** Records, in the main process, everything sent to the window: pushed events, and what every
 * request from it is answered with. */
async function recordWindowTraffic(netfuse: NetFuseApp): Promise<void> {
  const wrapped = await netfuse.evaluateMain(({ BrowserWindow, ipcMain }) => {
    const sent: string[] = []
    ;(globalThis as Record<string, unknown>).__sentToWindow = sent
    for (const window of BrowserWindow.getAllWindows()) {
      const contents = window.webContents
      const send = contents.send.bind(contents)
      contents.send = (channel: string, ...args: unknown[]) => {
        sent.push(JSON.stringify([channel, ...args]))
        send(channel, ...args)
      }
    }
    // Electron keeps ipcMain.handle's handlers here; each answer is recorded on its way out.
    const handlers = (
      ipcMain as unknown as { _invokeHandlers?: Map<string, (...args: unknown[]) => unknown> }
    )._invokeHandlers
    for (const [channel, handler] of handlers ?? []) {
      handlers!.set(channel, async (...args: unknown[]) => {
        const result = await handler(...args)
        sent.push(JSON.stringify([channel, result ?? null]))
        return result
      })
    }
    return handlers?.size ?? 0
  }, null)
  expect(wrapped, 'every request handler is recorded').toBeGreaterThan(10)
}

const sentToWindow = (netfuse: NetFuseApp): Promise<string[]> =>
  netfuse.evaluateMain(
    () => (globalThis as Record<string, unknown>).__sentToWindow as string[],
    null
  )

async function filesUnder(root: string): Promise<string[]> {
  const entries = await readdir(root, { recursive: true, withFileTypes: true })
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name))
}

/** Each secret as it could be written down: as text, as UTF-16 (Chromium's storage), and for a
 * key, its raw bytes, hex and base64. */
function encodings(steam: SteamOrigin): { name: string; bytes: Buffer }[] {
  const texts = [
    { name: 'password', text: ACCOUNT.password },
    ...steam.refreshTokens.map((text) => ({ name: 'refresh token', text })),
    ...steam.grants.map((text) => ({ name: 'request code or CDN token', text }))
  ]
  const keys = steam.app.depots.map((depot) => depot.key)
  return [
    ...texts.flatMap(({ name, text }) => [
      { name, bytes: Buffer.from(text, 'utf8') },
      { name: `${name} (UTF-16)`, bytes: Buffer.from(text, 'utf16le') }
    ]),
    ...keys.flatMap((key) => [
      { name: 'depot key', bytes: key },
      { name: 'depot key (hex)', bytes: Buffer.from(key.toString('hex')) },
      { name: 'depot key (base64)', bytes: Buffer.from(key.toString('base64')) }
    ])
  ]
}

test.describe('steam credentials', () => {
  test('no secret reaches the window, the output or a file @smoke', async ({
    netfuse,
    serveSteam,
    dirs
  }) => {
    const steam = await serveSteam(undefined, { guard: 'email', requireToken: true })
    await recordWindowTraffic(netfuse)

    const before = await netfuse.api.steamLoginState()
    expect(before.status).toBe('logged-out')
    const canRemember = before.status === 'logged-out' && before.canRemember
    await netfuse.api.steamLogin({
      method: 'credentials',
      accountName: ACCOUNT.name,
      password: ACCOUNT.password,
      remember: true
    })
    await expect
      .poll(async () => (await netfuse.api.steamLoginState()).status)
      .toBe('awaiting-code')
    await netfuse.api.steamSubmitCode('WRONG')
    await expect
      .poll(async () => {
        const state = await netfuse.api.steamLoginState()
        return state.status === 'awaiting-code' ? state.error : undefined
      })
      .toBe('That Steam Guard code isn’t right. Check it and try again.')
    await netfuse.api.steamSubmitCode(GUARD_CODE.toLowerCase())
    await expect.poll(async () => (await netfuse.api.steamLoginState()).status).toBe('logged-in')
    const loggedIn = await netfuse.api.steamLoginState()
    expect(loggedIn).toEqual({
      status: 'logged-in',
      accountName: ACCOUNT.name,
      remembered: canRemember
    })

    // A whole download, with CDN tokens and request codes, and Steam's errors along the way.
    steam.setRule((request) => (request.n === 3 ? { status: 403 } : undefined))
    await netfuse.startSteam(steam)
    await netfuse.waitForSteamStatus('completed')
    expect(steam.refreshTokens.length).toBeGreaterThan(0)
    expect(steam.grants.length).toBeGreaterThan(0)

    const stored = join(dirs.userData, 'steam-account.json')
    // Kept only sealed by a real keychain: without one, not at all.
    expect(existsSync(stored)).toBe(canRemember)

    const secrets = encodings(steam)
    const traffic = (await sentToWindow(netfuse)).join('\n')
    expect(traffic).toContain('steam:login-state-changed')
    for (const { name, bytes } of secrets) {
      expect(Buffer.from(traffic).includes(bytes), `the window never gets the ${name}`).toBe(false)
    }
    const output = Buffer.from(netfuse.output.join(''))
    for (const { name, bytes } of [
      ...secrets,
      { name: 'Steam Guard code', bytes: Buffer.from(GUARD_CODE) }
    ]) {
      expect(output.includes(bytes), `the output never has the ${name}`).toBe(false)
    }
    for (const file of await filesUnder(dirs.userData)) {
      if ((await stat(file)).size > 64 * 1024 * 1024) continue
      const data = await readFile(file)
      for (const { name, bytes } of secrets) {
        expect(data.includes(bytes), `${file} never has the ${name}`).toBe(false)
      }
    }

    await netfuse.api.steamLogout()
    expect((await netfuse.api.steamLoginState()).status).toBe('logged-out')
    expect(existsSync(stored), 'logging out forgets the stored login').toBe(false)
  })

  test('a wrong password is said plainly, and nothing is kept @smoke', async ({
    netfuse,
    serveSteam,
    dirs
  }) => {
    await serveSteam()
    await netfuse.api.steamLogin({
      method: 'credentials',
      accountName: ACCOUNT.name,
      password: 'not the password',
      remember: true
    })
    await expect
      .poll(async () => {
        const state = await netfuse.api.steamLoginState()
        return state.status === 'logged-out' ? (state.error ?? 'no message') : state.status
      })
      .toBe('The account name or password is wrong.')
    expect(existsSync(join(dirs.userData, 'steam-account.json'))).toBe(false)
    expect(netfuse.output.join('')).not.toContain('not the password')
  })

  test('the window’s Steam requests are checked before anything is done with them', async ({
    netfuse,
    serveSteam
  }) => {
    await serveSteam()
    const bad = [
      () =>
        netfuse.api.steamLogin({
          method: 'credentials',
          accountName: '',
          password: 'x',
          remember: false
        }),
      () => netfuse.api.steamLogin({ method: 'magic' } as never),
      () => netfuse.api.steamSubmitCode('<script>' as never),
      () => netfuse.api.steamAppDetails(-1),
      () => netfuse.api.steamAppDetails('480' as never),
      () =>
        netfuse.api.steamPrepare({
          appId: 4000,
          branch: 'public',
          depotIds: ['4001'] as never,
          destinationDir: netfuse.dirs.dest,
          adopt: false
        }),
      () => netfuse.api.startDownload({ kind: 'steam', planId: 'x', interfaceIds: 'a' as never }),
      () =>
        netfuse.api.startDownload({
          kind: 'steam',
          planId: 'x',
          interfaceIds: ['a'],
          streamsPerNetwork: 1000
        })
    ]
    for (const call of bad) await expect(call()).rejects.toThrow()
    expect((await netfuse.api.steamLoginState()).status).toBe('logged-out')
  })
})
