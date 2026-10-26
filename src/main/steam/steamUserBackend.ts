import type SteamUserType from 'steam-user'
import type { LoginSession as LoginSessionType } from 'steam-session'
import {
  SteamRefusedError,
  type LoginAttempt,
  type LoginGuard,
  type LoginResult,
  type RawContentServer,
  type RawProductInfo,
  type SteamBackend,
  type SteamLicense,
  type SteamSession
} from './backend'
import { contentMessage, eresultOf, loginExpired, loginMessage } from './eresult'
import { redactedMessage } from './redact'

// Steam itself, through steam-session (logging in) and steam-user (the Steam client protocol: what
// the account owns, appinfo, depot keys, manifest request codes, content servers, CDN tokens). The
// only file that loads either: they come in through import() the first time Steam is used, and
// are left out of the app's start otherwise.
//
// steam-user is told to keep nothing on disk (dataDirectory: null): by default it saves depot keys,
// machine ids and cell ids to a folder of its own. Its debug output, which has request codes and
// tokens in it, is never listened to.

/** How long a login waits for a Steam Guard code or a confirmation: steam-session gives up after
 * 30 seconds by default, too soon to read an email. */
const LOGIN_TIMEOUT_MS = 5 * 60_000
/** How long one request to Steam may take. steam-user's own limit for appinfo is an hour. */
const REQUEST_TIMEOUT_MS = 60_000
const LOGON_TIMEOUT_MS = 30_000

/** ELicenseFlags. */
const LICENSE_EXPIRED = 8
const LICENSE_BORROWED = 16384

type SessionModule = typeof import('steam-session')

let sessionModule: Promise<SessionModule> | null = null
let userModule: Promise<typeof SteamUserType> | null = null

/** A CommonJS package through import(): its exports come as `default`, or as named exports, by how
 * Node read it. */
function exportsOf<T>(module: T): T {
  return (module as { default?: T }).default ?? module
}

function loadSession(): Promise<SessionModule> {
  sessionModule ??= import('steam-session').then(exportsOf)
  return sessionModule
}

function loadUser(): Promise<typeof SteamUserType> {
  userModule ??= import('steam-user').then((module) => module.default)
  return userModule
}

function within<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new SteamRefusedError(message)), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      }
    )
  })
}

/** A login error as the user should read it. */
function loginError(error: unknown): SteamRefusedError {
  const eresult = eresultOf(error)
  return new SteamRefusedError(loginMessage(eresult, redactedMessage(error)), eresult)
}

class Attempt implements LoginAttempt {
  readonly result: Promise<LoginResult>
  private readonly scanned = new Set<() => void>()

  constructor(
    private readonly session: LoginSessionType,
    readonly guard: LoginGuard | null,
    readonly qrUrl?: string
  ) {
    this.result = new Promise<LoginResult>((resolve, reject) => {
      session.once('authenticated', () =>
        resolve({ refreshToken: session.refreshToken, accountName: session.accountName })
      )
      session.once('timeout', () =>
        reject(new SteamRefusedError('The login took too long. Start it again.'))
      )
      session.once('error', (error: unknown) => reject(loginError(error)))
    })
    // Settled whether or not anyone is waiting on it yet.
    this.result.catch(() => {})
    session.on('remoteInteraction', () => {
      for (const listener of this.scanned) listener()
    })
  }

  async submitCode(code: string): Promise<void> {
    try {
      await this.session.submitSteamGuardCode(code)
    } catch (error) {
      throw loginError(error)
    }
  }

  onScanned(listener: () => void): void {
    this.scanned.add(listener)
  }

  cancel(): void {
    this.session.cancelLoginAttempt()
  }
}

class Session implements SteamSession {
  private readonly refreshListeners = new Set<(token: string) => void>()
  private readonly logoutListeners = new Set<(reason: string, forget: boolean) => void>()
  private loggingOff = false

  constructor(
    private readonly client: SteamUserType,
    readonly accountName: string
  ) {
    client.on('refreshToken', (token: string) => {
      for (const listener of this.refreshListeners) listener(token)
    })
    // Once logged on, an error is a disconnection steam-user won't come back from by itself.
    client.on('error', (error: unknown) => {
      if (this.loggingOff) return
      const eresult = eresultOf(error)
      const reason = loginMessage(eresult, 'Steam logged NetFuse out.')
      for (const listener of this.logoutListeners) listener(reason, loginExpired(eresult))
    })
  }

  async licenses(): Promise<SteamLicense[]> {
    const client = this.client
    // The list arrives just after logging on.
    const licenses =
      client.licenses ??
      (await within(
        new Promise<NonNullable<SteamUserType['licenses']>>((resolve) =>
          client.once('licenses', resolve)
        ),
        REQUEST_TIMEOUT_MS,
        'Steam didn’t send the account’s licenses.'
      ))
    return licenses
      .filter((license) => (license.flags & LICENSE_EXPIRED) === 0)
      .map((license) => ({
        packageId: license.package_id,
        borrowed: (license.flags & LICENSE_BORROWED) !== 0
      }))
  }

  async productInfo(apps: number[], packages: number[]): Promise<RawProductInfo> {
    const info = await within(
      this.client.getProductInfo(apps, packages, true),
      REQUEST_TIMEOUT_MS,
      'Steam didn’t send the app’s details in time.'
    ).catch((error) => {
      throw new SteamRefusedError(redactedMessage(error), eresultOf(error))
    })
    return { apps: info.apps, packages: info.packages }
  }

  async depotKey(appId: number, depotId: number): Promise<Buffer> {
    try {
      const { key } = await within(
        this.client.getDepotDecryptionKey(appId, depotId),
        REQUEST_TIMEOUT_MS,
        'Steam didn’t send a depot key in time.'
      )
      return key
    } catch (error) {
      throw new SteamRefusedError(contentMessage(eresultOf(error), depotId), eresultOf(error))
    }
  }

  async manifestRequestCode(
    appId: number,
    depotId: number,
    manifestId: string,
    branch: string
  ): Promise<string> {
    try {
      const { requestCode } = await within(
        this.client.getManifestRequestCode(appId, depotId, manifestId, branch, null),
        REQUEST_TIMEOUT_MS,
        'Steam didn’t send a manifest request code in time.'
      )
      return String(requestCode)
    } catch (error) {
      throw new SteamRefusedError(contentMessage(eresultOf(error), depotId), eresultOf(error))
    }
  }

  async contentServers(appId: number): Promise<RawContentServer[]> {
    const { servers } = await within(
      this.client.getContentServers(appId),
      REQUEST_TIMEOUT_MS,
      'Steam didn’t list its content servers in time.'
    ).catch((error) => {
      throw new SteamRefusedError(redactedMessage(error), eresultOf(error))
    })
    return servers.map((server) => ({
      type: server.type,
      host: server.Host,
      vhost: server.vhost,
      httpsSupport: server.https_support,
      weightedLoad: server.weightedload,
      allowedAppIds: server.allowed_app_ids
    }))
  }

  async cdnAuthToken(
    appId: number,
    depotId: number,
    host: string
  ): Promise<{ token: string; expiresAt: number }> {
    try {
      const { token, expires } = await within(
        this.client.getCDNAuthToken(appId, depotId, host),
        REQUEST_TIMEOUT_MS,
        'Steam didn’t send a content server token in time.'
      )
      return { token, expiresAt: expires.getTime() }
    } catch (error) {
      throw new SteamRefusedError(contentMessage(eresultOf(error), depotId), eresultOf(error))
    }
  }

  onRefreshToken(listener: (token: string) => void): void {
    this.refreshListeners.add(listener)
  }

  onLoggedOut(listener: (reason: string, forget: boolean) => void): void {
    this.logoutListeners.add(listener)
  }

  async logOff(): Promise<void> {
    this.loggingOff = true
    const disconnected = new Promise<void>((resolve) => {
      this.client.once('disconnected', () => resolve())
      setTimeout(resolve, 3000)
    })
    this.client.logOff()
    await disconnected
    this.client.removeAllListeners()
  }
}

export function steamUserBackend(): SteamBackend {
  return {
    async startCredentials(accountName, password) {
      const { LoginSession, EAuthTokenPlatformType, EAuthSessionGuardType } = await loadSession()
      const session = new LoginSession(EAuthTokenPlatformType.SteamClient)
      session.loginTimeout = LOGIN_TIMEOUT_MS
      let response
      try {
        response = await session.startWithCredentials({ accountName, password })
      } catch (error) {
        throw loginError(error)
      }
      const actions = response.validActions ?? []
      const has = (type: number): boolean => actions.some((action) => action.type === type)
      const guard: LoginGuard | null = response.actionRequired
        ? {
            code: has(EAuthSessionGuardType.DeviceCode)
              ? 'device'
              : has(EAuthSessionGuardType.EmailCode)
                ? 'email'
                : null,
            emailDomain: actions.find((action) => action.type === EAuthSessionGuardType.EmailCode)
              ?.detail,
            confirm: has(EAuthSessionGuardType.DeviceConfirmation)
              ? 'device'
              : has(EAuthSessionGuardType.EmailConfirmation)
                ? 'email'
                : null
          }
        : null
      return new Attempt(session, guard)
    },

    async startQr() {
      const { LoginSession, EAuthTokenPlatformType } = await loadSession()
      const session = new LoginSession(EAuthTokenPlatformType.SteamClient)
      session.loginTimeout = LOGIN_TIMEOUT_MS
      let response
      try {
        response = await session.startWithQR()
      } catch (error) {
        throw loginError(error)
      }
      if (!response.qrChallengeUrl) throw new SteamRefusedError('Steam didn’t send a QR code.')
      return new Attempt(session, { code: null, confirm: 'device' }, response.qrChallengeUrl)
    },

    async logOn(refreshToken, accountName) {
      const SteamUser = await loadUser()
      const client = new SteamUser({
        dataDirectory: null,
        autoRelogin: true,
        enablePicsCache: false,
        changelistUpdateInterval: 0,
        saveAppTickets: false,
        renewRefreshTokens: true
      })
      await within(
        new Promise<void>((resolve, reject) => {
          const onError = (error: unknown): void => reject(loginError(error))
          client.once('error', onError)
          client.once('loggedOn', () => {
            client.off('error', onError)
            resolve()
          })
          client.logOn({ refreshToken })
        }),
        LOGON_TIMEOUT_MS,
        'NetFuse couldn’t reach Steam. Check your connection and try again.'
      ).catch((error) => {
        client.logOff()
        client.removeAllListeners()
        throw error
      })
      return new Session(client, accountName)
    }
  }
}
