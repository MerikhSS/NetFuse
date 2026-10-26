const IPC_INVOKE_PREFIX = /^Error invoking remote method '[^']*':\s*/
const NESTED_ERROR_PREFIX = /^Error:\s*/

const ERROR_HINTS: Array<{ pattern: RegExp; message: string }> = [
  {
    pattern: /ENOSPC|EDQUOT/,
    message:
      'There isn’t enough space to install this game. Free up space or choose another folder.'
  },
  {
    pattern: /EACCES|EPERM/,
    message:
      'NetFuse doesn’t have permission to access this file or folder. Check its permissions or choose another folder.'
  },
  {
    pattern: /ENOENT/,
    message: 'A file or folder is missing. Check the install folder and try again.'
  },
  { pattern: /EROFS/, message: 'This drive is read-only. Choose another folder.' },
  {
    pattern: /EIO/,
    message: 'NetFuse couldn’t read or write the install. Check the drive and try again.'
  },
  {
    pattern: /Download is incomplete/,
    message: 'NetFuse couldn’t download every part of the game. Try again.'
  },
  {
    pattern: /ENOTFOUND|EAI_AGAIN/,
    message: 'NetFuse couldn’t reach Steam. Check your connection.'
  },
  {
    pattern: /ECONNREFUSED/,
    message: 'Steam refused the connection. Try again later.'
  },
  {
    pattern: /ECONNRESET|socket hang up/,
    message: 'The connection was interrupted. Try again in a moment.'
  },
  {
    pattern: /ETIMEDOUT|ESOCKETTIMEDOUT/,
    message: 'The connection timed out. Check your network and try again.'
  },
  {
    pattern: /CERT|SSL|TLS/i,
    message: 'Steam’s security certificate couldn’t be verified. Try again later.'
  },
  // steam-user's errors are often bare EResult names.
  {
    pattern: /^(RateLimitExceeded|AccountLoginDeniedThrottle)$/,
    message:
      'Steam is turning away requests from this computer for now. Try again in a few minutes.'
  },
  {
    pattern: /^(ServiceUnavailable|TryAnotherCM|Busy|NoConnection)$/,
    message: 'Steam isn’t answering right now. Try again in a few minutes.'
  },
  {
    pattern: /^(InvalidPassword|AccessDenied)$/,
    message: 'Steam turned this down. Check the account, and that it owns this game.'
  },
  {
    pattern: /content server answered with status 5\d\d/,
    message: 'Steam’s content servers are having trouble. Try again later.'
  },
  {
    pattern: /content server answered with status 4\d\d/,
    message: 'Steam’s content servers turned the download down. Try again later.'
  }
]

/** Electron wraps a rejected IPC call as "Error invoking remote method 'x': Error: <message>" —
 * strip that framework noise and translate common network and disk errors, and Steam's bare error
 * names, into plain English. Used for every error the window shows, a download's own included. */
export function describeError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error)
  const stripped = raw.replace(IPC_INVOKE_PREFIX, '').replace(NESTED_ERROR_PREFIX, '')

  for (const { pattern, message } of ERROR_HINTS) {
    if (pattern.test(stripped)) return message
  }

  return stripped
}
