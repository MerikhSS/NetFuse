// What a content server's answer means beyond its bytes: a status worth waiting out, and how long
// the server asked to be left alone.

/** The server answered with a status other than the content asked for. */
export class HttpStatusError extends Error {
  constructor(
    readonly status: number,
    /** How long the server asked to be left alone (Retry-After), if it said. */
    readonly retryAfterMs: number | null
  ) {
    super(`The content server answered with status ${status}`)
  }

  /** A server that is busy, briefly broken or limiting requests: worth waiting out, not a sign
   * that asking again will never work. The statuses curl's --retry treats as transient. */
  get transient(): boolean {
    return [408, 429, 500, 502, 503, 504].includes(this.status)
  }
}

/** Retry-After (RFC 9110 §10.2.3), in seconds or as an HTTP date, as milliseconds from now. */
export function retryAfterMs(value: string | undefined, now = Date.now()): number | null {
  if (!value) return null
  const trimmed = value.trim()
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000
  const at = Date.parse(trimmed)
  return Number.isNaN(at) ? null : Math.max(0, at - now)
}
