// What Steam's result codes (EResult) mean to someone using NetFuse. steam-user and steam-session
// reject with errors named after the code ("InvalidPassword") and carry the number as `eresult`;
// this turns the ones a login or a download meets into something to read. Anything else keeps
// Steam's own name, so it can still be looked up.

export const EResult = {
  NoConnection: 3,
  InvalidPassword: 5,
  LoggedInElsewhere: 6,
  Busy: 10,
  AccessDenied: 15,
  Timeout: 16,
  Banned: 17,
  AccountNotFound: 18,
  ServiceUnavailable: 20,
  NotLoggedOn: 21,
  Revoked: 26,
  Expired: 27,
  LogonSessionReplaced: 34,
  AccountDisabled: 43,
  TryAnotherCM: 48,
  Suspended: 51,
  AccountLogonDenied: 63,
  InvalidLoginAuthCode: 65,
  ParentalControlRestricted: 69,
  AccountLockedDown: 73,
  RegionLocked: 83,
  RateLimitExceeded: 84,
  AccountLoginDeniedNeedTwoFactor: 85,
  AccountLoginDeniedThrottle: 87,
  TwoFactorCodeMismatch: 88,
  LimitedUserAccount: 112,
  InvalidSignature: 121
} as const

const LOGIN: Record<number, string> = {
  [EResult.InvalidPassword]: 'The account name or password is wrong.',
  [EResult.AccountNotFound]: 'The account name or password is wrong.',
  [EResult.InvalidLoginAuthCode]: 'That Steam Guard code isn’t right. Check it and try again.',
  [EResult.TwoFactorCodeMismatch]: 'That Steam Guard code isn’t right. Check it and try again.',
  [EResult.RateLimitExceeded]:
    'Steam is limiting logins from this computer. Wait a while and try again.',
  [EResult.AccountLoginDeniedThrottle]:
    'Steam is limiting logins from this computer. Wait a while and try again.',
  [EResult.AccountDisabled]: 'This Steam account is disabled.',
  [EResult.AccountLockedDown]: 'This Steam account is locked. Steam Support can unlock it.',
  [EResult.Banned]: 'Steam won’t let this account log in.',
  [EResult.Suspended]: 'Steam won’t let this account log in.',
  [EResult.LimitedUserAccount]: 'Steam won’t let this account log in.',
  [EResult.ParentalControlRestricted]: 'Steam Family View restricts this account.',
  [EResult.Expired]: 'Your Steam login has expired. Log in again.',
  [EResult.Revoked]: 'Your Steam login was revoked. Log in again.',
  [EResult.AccessDenied]: 'Your Steam login was refused. Log in again.',
  [EResult.InvalidSignature]: 'Your Steam login was refused. Log in again.',
  [EResult.LoggedInElsewhere]: 'This Steam account logged in somewhere else.',
  [EResult.LogonSessionReplaced]: 'This Steam account logged in somewhere else.',
  [EResult.NoConnection]: 'NetFuse couldn’t reach Steam. Check your connection and try again.',
  [EResult.ServiceUnavailable]: 'Steam isn’t answering right now. Try again in a few minutes.',
  [EResult.Busy]: 'Steam isn’t answering right now. Try again in a few minutes.',
  [EResult.TryAnotherCM]: 'Steam isn’t answering right now. Try again in a few minutes.',
  [EResult.Timeout]: 'Steam took too long to answer. Try again.'
}

/** Results that mean the stored login is no good any more, as opposed to Steam being away. */
const LOGIN_EXPIRED: ReadonlySet<number> = new Set([
  EResult.InvalidPassword,
  EResult.AccessDenied,
  EResult.Expired,
  EResult.Revoked,
  EResult.InvalidSignature,
  EResult.LoggedInElsewhere,
  EResult.LogonSessionReplaced,
  EResult.AccountDisabled,
  EResult.AccountLockedDown,
  EResult.Banned,
  EResult.Suspended
])

/** A login error, worded for the user. */
export function loginMessage(eresult: number | undefined, fallback: string): string {
  return (eresult !== undefined && LOGIN[eresult]) || fallback
}

/** Whether a refusal of a stored login means it must be forgotten. */
export function loginExpired(eresult: number | undefined): boolean {
  return eresult !== undefined && LOGIN_EXPIRED.has(eresult)
}

/** Steam turning down a depot key or a manifest request code. */
export function contentMessage(eresult: number | undefined, depotId: number): string {
  if (eresult === EResult.AccessDenied) {
    return `This Steam account isn’t licensed for depot ${depotId}, so Steam won’t send it.`
  }
  if (eresult === EResult.RegionLocked) {
    return `Steam won’t send depot ${depotId} in this region.`
  }
  if (eresult === EResult.RateLimitExceeded) {
    return 'Steam is limiting requests from this account. Wait a while and try again.'
  }
  if (eresult === EResult.NotLoggedOn) return 'Log in to Steam to continue.'
  return loginMessage(eresult, `Steam wouldn’t send depot ${depotId}.`)
}

/** The EResult an error from steam-user or steam-session carries, if it does. */
export function eresultOf(error: unknown): number | undefined {
  const value = (error as { eresult?: unknown } | null)?.eresult
  return typeof value === 'number' ? value : undefined
}
