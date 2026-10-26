// Everything NetFuse asks of Steam itself, as opposed to the content servers: logging in, what the
// account owns, apps' details, depot keys, manifest request codes, the content server list and
// CDN tokens. steamUserBackend.ts answers it with steam-session and steam-user; the end-to-end
// tests answer it with a fake (fakeBackend.ts), so everything past this seam — manifests and
// chunks over NetFuse's own pinned connections — runs the same code in both.
//
// Secrets cross this seam (refresh tokens, depot keys, CDN tokens) and stay in the main process:
// none of it is ever sent to the window, saved in the clear, or logged.

/** What Steam asks for before it accepts a login, once the password is right. */
export interface LoginGuard {
  /** A code to type: from the account's email, or from the Steam Mobile App. */
  code: 'email' | 'device' | null
  emailDomain?: string
  /** The login can be approved instead: in the mobile app, or from the email. */
  confirm: 'email' | 'device' | null
}

export interface LoginResult {
  refreshToken: string
  accountName: string
}

/** A login under way. */
export interface LoginAttempt {
  /** Null when Steam needs nothing more. */
  readonly guard: LoginGuard | null
  /** For a QR login: the URL the code encodes. */
  readonly qrUrl?: string
  /** Settles once Steam accepts or refuses the login, or it times out. */
  readonly result: Promise<LoginResult>
  /** Rejects when Steam says the code is wrong; the attempt carries on for another. */
  submitCode(code: string): Promise<void>
  /** Called once the QR code has been scanned, and the user is approving it on their phone. */
  onScanned(listener: () => void): void
  cancel(): void
}

export interface SteamLicense {
  packageId: number
  /** Lent through Steam Family Sharing. */
  borrowed: boolean
}

export interface RawProductInfo {
  apps: Record<string, { appinfo: unknown; missingToken: boolean }>
  packages: Record<string, { packageinfo: unknown; missingToken: boolean }>
}

export interface RawContentServer {
  type: string
  host: string
  vhost?: string
  httpsSupport?: string
  weightedLoad?: number
  allowedAppIds?: number[]
}

/** Steam refused something for a reason worth telling the user as it is (an EResult). */
export class SteamRefusedError extends Error {
  constructor(
    message: string,
    /** Steam's EResult, when it gave one. */
    readonly eresult?: number
  ) {
    super(message)
  }
}

export interface SteamSession {
  readonly accountName: string
  /** Licenses the account holds, expired ones left out. */
  licenses(): Promise<SteamLicense[]>
  productInfo(apps: number[], packages: number[]): Promise<RawProductInfo>
  depotKey(appId: number, depotId: number): Promise<Buffer>
  manifestRequestCode(
    appId: number,
    depotId: number,
    manifestId: string,
    branch: string
  ): Promise<string>
  contentServers(appId: number): Promise<RawContentServer[]>
  cdnAuthToken(
    appId: number,
    depotId: number,
    host: string
  ): Promise<{ token: string; expiresAt: number }>
  /** Steam renewed the refresh token: the one to keep from now on. */
  onRefreshToken(listener: (token: string) => void): void
  /** Logged out by Steam, for good (the token was revoked, or the account logged in elsewhere):
   * a new login is needed. `forget`: the stored login is no good any more. */
  onLoggedOut(listener: (reason: string, forget: boolean) => void): void
  logOff(): Promise<void>
}

export interface SteamBackend {
  startCredentials(accountName: string, password: string): Promise<LoginAttempt>
  startQr(): Promise<LoginAttempt>
  /** A session from a refresh token. Rejects (a SteamRefusedError) when Steam won't take it. */
  logOn(refreshToken: string, accountName: string): Promise<SteamSession>
}
