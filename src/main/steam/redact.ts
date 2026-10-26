// Steam's secrets — refresh and access tokens (JWTs), CDN auth tokens, depot keys, manifest request
// codes — travel inside URLs and error messages from the libraries NetFuse uses. Anything that leaves
// the Steam modules (a download's error, a notification, the window, the console) goes through
// redact() first, so a secret can't reach a screen, a log or a saved file by way of an error.

const REDACTED = '[redacted]'

const RULES: [RegExp, (match: string, ...groups: string[]) => string][] = [
  // JWTs: Steam's refresh and access tokens.
  [/\beyJ[\w-]{6,}\.[\w-]{6,}\.[\w-]{6,}/g, () => REDACTED],
  // A token or code handed over in a query string or header-like text.
  [
    /\b(token|access_token|refresh_token|code|password|key|authorization)=([^\s&"']+)/gi,
    (_match, name) => `${name}=${REDACTED}`
  ],
  // A manifest URL ends in its request code: /depot/<id>/manifest/<gid>/5/<code>.
  [/(\/manifest\/\d+\/\d+\/)\d+/g, (_match, prefix) => `${prefix}${REDACTED}`],
  // Depot keys and other long hex secrets (a 32-byte key is 64 hex digits).
  [/\b[0-9a-f]{40,}\b/gi, () => REDACTED]
]

/** `text` with every secret NetFuse knows the shape of replaced. */
export function redact(text: string): string {
  return RULES.reduce((result, [pattern, replace]) => result.replace(pattern, replace), text)
}

/** An error's message, and its causes', made safe to show or log. */
export function redactedMessage(error: unknown): string {
  const parts: string[] = []
  let current: unknown = error
  // A cause chain is short; the bound only guards against a cycle.
  for (let depth = 0; current !== undefined && current !== null && depth < 5; depth++) {
    parts.push(current instanceof Error ? current.message : String(current))
    current = current instanceof Error ? current.cause : undefined
  }
  const unique = parts.filter((part, index) => part && parts.indexOf(part) === index)
  return redact(unique.join(': ') || 'Unknown error')
}
