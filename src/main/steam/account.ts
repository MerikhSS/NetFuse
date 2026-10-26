import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { app, safeStorage } from 'electron'
import qrcode from 'qrcode-generator'
import {
  STEAM_LOGIN_REQUIRED,
  type SteamLoginRequest,
  type SteamLoginState
} from '../../shared/steam'
import { readJson, updateJson } from '../jsonFile'
import {
  type LoginAttempt,
  type LoginResult,
  type SteamBackend,
  type SteamSession
} from './backend'
import { eresultOf, loginExpired } from './eresult'
import { redactedMessage } from './redact'

// Who is logged in to Steam, and how they got there. A password and a Steam Guard code pass
// through here once, on their way to steam-session, and are never kept. What Steam gives back is
// a refresh token: with "remember" it is saved, encrypted with the system keychain through
// safeStorage, and nothing else about the login is. Without a keychain (Linux's basic_text
// backend encrypts with a fixed key) it is kept in memory only, so the next launch logs in again.
//
// The window is told the login state and nothing more: never a password, code or token.

/** The stored login: the account it is for, and the refresh token, sealed. */
interface StoredLogin {
  version: 1
  accountName: string
  token: string
}

/** Thrown when a Steam download or request needs a login and there is none. */
export class SteamLoginRequiredError extends Error {
  constructor() {
    super(STEAM_LOGIN_REQUIRED)
  }
}

const storePath = (): string => join(app.getPath('userData'), 'steam-account.json')

/** Whether this computer can keep a login safely: the same rule browser cookies follow. */
export function canRemember(): boolean {
  if (!safeStorage.isEncryptionAvailable()) return false
  return !(process.platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text')
}

function seal(token: string): string | null {
  if (!canRemember()) return null
  try {
    return safeStorage.encryptString(token).toString('base64')
  } catch {
    return null
  }
}

function unseal(sealed: string): string | null {
  try {
    return safeStorage.decryptString(Buffer.from(sealed, 'base64'))
  } catch {
    return null
  }
}

/** The QR code for `url`, as rows of modules. */
function qrMatrix(url: string): boolean[][] {
  const qr = qrcode(0, 'M')
  qr.addData(url)
  qr.make()
  const size = qr.getModuleCount()
  return Array.from({ length: size }, (_, row) =>
    Array.from({ length: size }, (_, column) => qr.isDark(row, column))
  )
}

export class SteamAccount {
  private state: SteamLoginState = { status: 'logged-out', canRemember: false }
  private session: SteamSession | null = null
  private attempt: LoginAttempt | null = null
  /** Bumped by every login, cancel and logout: an answer for an older one is ignored. */
  private generation = 0
  private remembered = false
  private started: Promise<void> | null = null
  /** Settles once start() has looked for a stored login. */
  private looked: Promise<void> = Promise.resolve()
  private readonly listeners = new Set<(state: SteamLoginState) => void>()
  /** Waiting for a login under way (or the stored one) to finish. */
  private readonly waiters = new Set<() => void>()

  constructor(private readonly backend: () => Promise<SteamBackend>) {}

  get loginState(): SteamLoginState {
    return this.state
  }

  onChange(listener: (state: SteamLoginState) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private set(state: SteamLoginState): void {
    this.state = state
    for (const listener of this.listeners) listener(state)
    for (const waiter of [...this.waiters]) waiter()
  }

  private loggedOut(error?: string): void {
    this.set({ status: 'logged-out', canRemember: canRemember(), ...(error ? { error } : {}) })
  }

  /** Logs in with the stored login, once, the first time the window asks for the login (which it
   * does as it opens: it shows nothing else until there is one). */
  start(): Promise<void> {
    if (!this.started) {
      let looked = (): void => {}
      this.looked = new Promise((resolve) => (looked = resolve))
      this.started = this.restore(looked).finally(looked)
    }
    return this.started
  }

  /** Once start() has looked for a stored login: the state then says whether one is being used,
   * so the window doesn't show the login form to someone who stays logged in. */
  lookedForStoredLogin(): Promise<void> {
    return this.looked
  }

  private async restore(looked: () => void): Promise<void> {
    const stored = (await readJson(storePath()).catch(() => undefined)) as StoredLogin | undefined
    const token =
      stored?.version === 1 &&
      typeof stored.token === 'string' &&
      typeof stored.accountName === 'string'
        ? unseal(stored.token)
        : null
    if (!token || !stored) {
      if (this.state.status === 'logged-out') this.loggedOut()
      return
    }
    const generation = ++this.generation
    this.set({ status: 'connecting' })
    looked()
    try {
      const session = await (await this.backend()).logOn(token, stored.accountName)
      if (generation !== this.generation) {
        void session.logOff()
        return
      }
      this.remembered = true
      this.adopt(session, token)
    } catch (error) {
      if (generation !== this.generation) return
      // A login Steam turned down is forgotten; one that couldn't reach Steam is kept for later.
      if (loginExpired(eresultOf(error))) await this.forget()
      this.started = null
      this.loggedOut(redactedMessage(error))
    }
  }

  private adopt(session: SteamSession, token: string): void {
    this.session = session
    let current = token
    session.onRefreshToken((renewed) => {
      current = renewed
      if (this.remembered) void this.store(session.accountName, current)
    })
    session.onLoggedOut((reason, forget) => {
      if (this.session !== session) return
      this.session = null
      this.started = null
      if (forget) void this.forget()
      this.loggedOut(reason)
    })
    this.set({ status: 'logged-in', accountName: session.accountName, remembered: this.remembered })
  }

  /** Saves the login, sealed. Whether it could: without a keychain, or when the save fails, the
   * login stays in memory only. */
  private async store(accountName: string, token: string): Promise<boolean> {
    const sealed = seal(token)
    if (!sealed) return false
    const stored: StoredLogin = { version: 1, accountName, token: sealed }
    try {
      await updateJson(storePath(), () => stored)
      return true
    } catch {
      return false
    }
  }

  private async forget(): Promise<void> {
    await rm(storePath(), { force: true }).catch(() => {})
  }

  /** Starts logging in. Resolves once Steam has answered the first step; the state says what
   * comes next (a code, a confirmation, a QR code, or logged in). */
  async login(request: SteamLoginRequest): Promise<void> {
    await this.cancelAttempt()
    if (this.session) await this.logout()
    const generation = ++this.generation
    this.set({ status: 'connecting' })
    let attempt: LoginAttempt
    try {
      const backend = await this.backend()
      attempt =
        request.method === 'credentials'
          ? await backend.startCredentials(request.accountName, request.password)
          : await backend.startQr()
    } catch (error) {
      if (generation === this.generation) this.loggedOut(redactedMessage(error))
      return
    }
    if (generation !== this.generation) {
      attempt.cancel()
      return
    }
    this.attempt = attempt
    void attempt.result.then(
      (result) => this.finish(generation, result, request.remember),
      (error) => {
        if (generation !== this.generation) return
        this.attempt = null
        this.loggedOut(redactedMessage(error))
      }
    )
    const { guard } = attempt
    if (attempt.qrUrl) {
      const qr = qrMatrix(attempt.qrUrl)
      this.set({ status: 'awaiting-qr', qr, scanned: false })
      attempt.onScanned(() => {
        if (generation === this.generation && this.state.status === 'awaiting-qr') {
          this.set({ status: 'awaiting-qr', qr, scanned: true })
        }
      })
    } else if (guard?.code) {
      this.set({
        status: 'awaiting-code',
        via: guard.code,
        ...(guard.emailDomain ? { emailDomain: guard.emailDomain } : {}),
        canConfirm: guard.confirm !== null
      })
    } else if (guard?.confirm) {
      this.set({ status: 'awaiting-confirmation', via: guard.confirm })
    }
  }

  private async finish(generation: number, result: LoginResult, remember: boolean): Promise<void> {
    if (generation !== this.generation) return
    this.attempt = null
    this.set({ status: 'connecting' })
    try {
      const session = await (await this.backend()).logOn(result.refreshToken, result.accountName)
      if (generation !== this.generation) {
        void session.logOff()
        return
      }
      this.remembered = remember && (await this.store(result.accountName, result.refreshToken))
      if (!this.remembered) await this.forget()
      this.started = Promise.resolve()
      this.adopt(session, result.refreshToken)
    } catch (error) {
      if (generation === this.generation) this.loggedOut(redactedMessage(error))
    }
  }

  /** Sends the Steam Guard code the user typed. A wrong one leaves the login waiting for another. */
  async submitCode(code: string): Promise<void> {
    const attempt = this.attempt
    const state = this.state
    if (!attempt || state.status !== 'awaiting-code') {
      throw new Error('No login is waiting for a code.')
    }
    const generation = this.generation
    this.set({ status: 'connecting' })
    try {
      await attempt.submitCode(code)
    } catch (error) {
      if (generation !== this.generation) return
      this.set({ ...state, error: redactedMessage(error) })
    }
  }

  private async cancelAttempt(): Promise<void> {
    this.attempt?.cancel()
    this.attempt = null
  }

  /** Gives up on a login under way. */
  async cancel(): Promise<void> {
    this.generation++
    await this.cancelAttempt()
    if (this.state.status !== 'logged-in') this.loggedOut()
  }

  /** Logs out and forgets the stored login. */
  async logout(): Promise<void> {
    this.generation++
    await this.cancelAttempt()
    const session = this.session
    this.session = null
    this.remembered = false
    this.started = Promise.resolve()
    await this.forget()
    this.loggedOut()
    await session?.logOff().catch(() => {})
  }

  /**
   * The logged-in session, for a download or a request. Waits up to `waitMs` for one being made —
   * the stored login after a restart, or one the user is going through — and throws
   * SteamLoginRequiredError when there is none by then.
   */
  async current(waitMs = 0): Promise<SteamSession> {
    const deadline = Date.now() + waitMs
    await Promise.race([this.start(), new Promise((resolve) => setTimeout(resolve, waitMs))])
    while (!this.session && this.loginUnderWay() && Date.now() < deadline) {
      await new Promise<void>((resolve) => {
        const done = (): void => {
          clearTimeout(timer)
          this.waiters.delete(done)
          resolve()
        }
        const timer = setTimeout(done, deadline - Date.now())
        this.waiters.add(done)
      })
    }
    if (!this.session) throw new SteamLoginRequiredError()
    return this.session
  }

  private loginUnderWay(): boolean {
    return this.state.status !== 'logged-out' && this.state.status !== 'logged-in'
  }
}
