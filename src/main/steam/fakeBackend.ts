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
import { contentMessage, loginExpired, loginMessage } from './eresult'

// Steam, as the end-to-end tests stand it up (e2e/steamOrigin.ts): a local server answering what
// steam-session and steam-user would ask the real one, so a Steam download can be driven from
// login to the last chunk with no Steam account and no internet. Only the control plane is
// faked: manifests and chunks still come over NetFuse's own pinned connections, from the same
// server, through the same code as a real download.
//
// Chosen by the NETFUSE_E2E_STEAM test knob, which a packaged app ignores (see testKnobs.ts).

interface Refusal {
  error: string
  eresult?: number
}

async function call<T>(base: string, path: string, body?: unknown, token?: string): Promise<T> {
  const response = await fetch(new URL(path, base), {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { 'x-steam-token': token } : {})
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  })
  const result = (await response.json()) as T | Refusal
  if (!response.ok || (result && typeof result === 'object' && 'error' in result)) {
    const refusal = result as Refusal
    throw Object.assign(new SteamRefusedError(refusal.error, refusal.eresult), {
      eresult: refusal.eresult
    })
  }
  return result as T
}

class FakeAttempt implements LoginAttempt {
  readonly result: Promise<LoginResult>
  private readonly scanned = new Set<() => void>()
  private cancelled = false

  constructor(
    private readonly base: string,
    private readonly id: string,
    readonly guard: LoginGuard | null,
    readonly qrUrl?: string
  ) {
    this.result = this.poll()
    this.result.catch(() => {})
  }

  private async poll(): Promise<LoginResult> {
    let told = false
    for (;;) {
      if (this.cancelled) throw new SteamRefusedError('The login was cancelled.')
      const status = await call<{
        done: boolean
        scanned?: boolean
        refreshToken?: string
        accountName?: string
      }>(this.base, `/cm/attempt/${this.id}`).catch((error: SteamRefusedError) => {
        throw new SteamRefusedError(loginMessage(error.eresult, error.message), error.eresult)
      })
      if (status.scanned && !told) {
        told = true
        for (const listener of this.scanned) listener()
      }
      if (status.done && status.refreshToken && status.accountName) {
        return { refreshToken: status.refreshToken, accountName: status.accountName }
      }
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
  }

  async submitCode(code: string): Promise<void> {
    try {
      await call(this.base, '/cm/code', { attempt: this.id, code })
    } catch (error) {
      const refused = error as SteamRefusedError
      throw new SteamRefusedError(loginMessage(refused.eresult, refused.message), refused.eresult)
    }
  }

  onScanned(listener: () => void): void {
    this.scanned.add(listener)
  }

  cancel(): void {
    this.cancelled = true
  }
}

class FakeSession implements SteamSession {
  private readonly logoutListeners = new Set<(reason: string, forget: boolean) => void>()
  private timer: NodeJS.Timeout

  constructor(
    private readonly base: string,
    private token: string,
    readonly accountName: string
  ) {
    // The server can revoke a login, as Steam does; the session hears it as steam-user would.
    this.timer = setInterval(() => {
      void call<{ ok: boolean }>(this.base, '/cm/alive', undefined, this.token).catch(
        (error: SteamRefusedError) => {
          clearInterval(this.timer)
          for (const listener of this.logoutListeners) {
            listener(loginMessage(error.eresult, error.message), loginExpired(error.eresult))
          }
        }
      )
    }, 500)
    this.timer.unref()
  }

  private get<T>(path: string): Promise<T> {
    return call<T>(this.base, path, undefined, this.token)
  }

  licenses(): Promise<SteamLicense[]> {
    return this.get('/cm/licenses')
  }

  productInfo(apps: number[], packages: number[]): Promise<RawProductInfo> {
    return call(this.base, '/cm/productinfo', { apps, packages }, this.token)
  }

  async depotKey(appId: number, depotId: number): Promise<Buffer> {
    try {
      const { key } = await this.get<{ key: string }>(`/cm/depotkey?app=${appId}&depot=${depotId}`)
      return Buffer.from(key, 'hex')
    } catch (error) {
      throw new SteamRefusedError(
        contentMessage((error as SteamRefusedError).eresult, depotId),
        (error as SteamRefusedError).eresult
      )
    }
  }

  async manifestRequestCode(
    appId: number,
    depotId: number,
    manifestId: string,
    branch: string
  ): Promise<string> {
    const { code } = await this.get<{ code: string }>(
      `/cm/requestcode?app=${appId}&depot=${depotId}&manifest=${manifestId}&branch=${encodeURIComponent(branch)}`
    )
    return code
  }

  contentServers(appId: number): Promise<RawContentServer[]> {
    return this.get(`/cm/servers?app=${appId}`)
  }

  cdnAuthToken(
    appId: number,
    depotId: number,
    host: string
  ): Promise<{ token: string; expiresAt: number }> {
    return this.get(`/cm/token?app=${appId}&depot=${depotId}&host=${encodeURIComponent(host)}`)
  }

  onRefreshToken(): void {
    // The fake never renews a token.
  }

  onLoggedOut(listener: (reason: string, forget: boolean) => void): void {
    this.logoutListeners.add(listener)
  }

  async logOff(): Promise<void> {
    clearInterval(this.timer)
  }
}

export function fakeBackend(base: string): SteamBackend {
  return {
    async startCredentials(accountName, password) {
      const { attempt, guard } = await call<{ attempt: string; guard: LoginGuard | null }>(
        base,
        '/cm/login',
        { accountName, password }
      ).catch((error: SteamRefusedError) => {
        throw new SteamRefusedError(loginMessage(error.eresult, error.message), error.eresult)
      })
      return new FakeAttempt(base, attempt, guard)
    },
    async startQr() {
      const { attempt, url } = await call<{ attempt: string; url: string }>(base, '/cm/qr', {})
      return new FakeAttempt(base, attempt, { code: null, confirm: 'device' }, url)
    },
    async logOn(refreshToken, accountName) {
      try {
        await call(base, '/cm/logon', {}, refreshToken)
      } catch (error) {
        const refused = error as SteamRefusedError
        throw new SteamRefusedError(loginMessage(refused.eresult, refused.message), refused.eresult)
      }
      return new FakeSession(base, refreshToken, accountName)
    }
  }
}
