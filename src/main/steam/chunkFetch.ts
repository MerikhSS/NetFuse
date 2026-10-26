import type { IncomingMessage } from 'node:http'
import { HttpStatusError, retryAfterMs } from '../download/httpStatus'
import { asConnectionError, type StreamConnection } from '../network/routes'

// One request for one whole body — a depot chunk or a manifest — through a stream's connection,
// pinned to its network as HTTP downloads' are, so a Steam download spreads over every network
// it is given. A chunk is encrypted as a whole, so unlike an HTTP block nothing of it is any use
// until all of it is in: the body is gathered in memory and handed over complete, or not at all.
//
// What a content server sends is checked as it arrives: never more than the manifest says the
// chunk is, and never silent for longer than the stall timeout.

export interface BodyRequest {
  connection: StreamConnection
  url: URL
  /** The name the server answers to, when it isn't the host connected to. */
  vhost?: string
  /** The body's exact size when known (a chunk's cb_compressed), else at most `maxBytes`. */
  expectedBytes?: number
  maxBytes: number
  stallMs: number
  signal: AbortSignal
  /** Told of every body byte received; answers how many ms to stop reading for (see Limits). */
  throttle: (bytes: number) => number
  /** Every body byte received, as it is. */
  onBytes?: (bytes: number) => void
  onResponse?: (info: { ttfbMs: number; reusedSocket: boolean }) => void
}

/** The server sent a body of a size it can't have: not this chunk. */
export class BodySizeError extends Error {}

const MAX_REDIRECTS = 5

// Steam's own client name: some content servers answer only to it.
const HEADERS = { 'User-Agent': 'Valve/Steam HTTP Client 1.0', Accept: '*/*' }

function header(res: IncomingMessage, name: string): string | undefined {
  const value = res.headers[name]
  return Array.isArray(value) ? value[0] : value
}

export function fetchBody(request: BodyRequest): Promise<Buffer> {
  const { connection, signal, stallMs, throttle, onBytes, onResponse, expectedBytes } = request
  const limit = expectedBytes ?? request.maxBytes

  const attempt = async (url: URL, redirectsLeft: number): Promise<Buffer> => {
    const headers: Record<string, string> = { ...HEADERS }
    if (request.vhost && request.vhost !== url.host) headers.Host = request.vhost
    const { req, res, sentAt } = await connection.request(url, headers, signal)
    const status = res.statusCode ?? 0
    if (status >= 300 && status < 400 && res.headers.location && redirectsLeft > 0) {
      res.resume()
      return attempt(new URL(res.headers.location, url), redirectsLeft - 1)
    }
    if (status !== 200) {
      res.resume()
      throw new HttpStatusError(status, retryAfterMs(header(res, 'retry-after')))
    }
    const length = header(res, 'content-length')
    if (
      length !== undefined &&
      (expectedBytes !== undefined ? Number(length) !== expectedBytes : Number(length) > limit)
    ) {
      res.resume()
      req.destroy()
      throw new BodySizeError(`The server sent ${length} bytes where ${limit} were expected`)
    }
    onResponse?.({ ttfbMs: Date.now() - sentAt, reusedSocket: req.reusedSocket })

    return new Promise<Buffer>((resolve, reject) => {
      const parts: Buffer[] = []
      let received = 0
      let settled = false
      let watchdog: NodeJS.Timeout | null = null
      let holds = 0

      const finish = (error: Error | null, body?: Buffer): void => {
        if (settled) return
        settled = true
        if (watchdog) clearTimeout(watchdog)
        signal.removeEventListener('abort', onAbort)
        if (error) {
          req.destroy()
          reject(error)
        } else {
          resolve(body!)
        }
      }
      const arm = (): void => {
        if (watchdog) clearTimeout(watchdog)
        watchdog = setTimeout(
          () => finish(asConnectionError(new Error('Connection stalled: no response from server'))),
          stallMs
        )
      }
      const onAbort = (): void => finish(new DOMException('Aborted', 'AbortError'))
      signal.addEventListener('abort', onAbort, { once: true })
      if (signal.aborted) return onAbort()
      arm()

      res.on('data', (chunk: Buffer) => {
        if (settled) return
        received += chunk.length
        if (received > limit) {
          finish(new BodySizeError('The server sent more than the chunk holds'))
          return
        }
        parts.push(chunk)
        onBytes?.(chunk.length)
        const wait = throttle(chunk.length)
        if (wait > 0) {
          // A speed limit holds reading, which says nothing about the network: the watchdog
          // stops until reading goes on.
          if (holds++ === 0) {
            if (watchdog) clearTimeout(watchdog)
            res.pause()
          }
          setTimeout(() => {
            if (--holds > 0 || settled) return
            arm()
            res.resume()
          }, wait)
        } else if (holds === 0) {
          arm()
        }
      })
      res.on('end', () => {
        if (expectedBytes !== undefined && received !== expectedBytes) {
          finish(new BodySizeError(`The server sent ${received} of ${expectedBytes} bytes`))
          return
        }
        finish(null, Buffer.concat(parts, received))
      })
      res.on('error', (error) => finish(asConnectionError(error)))
      req.on('error', (error) => finish(asConnectionError(error)))
      // A connection that closes mid-body doesn't always say so with an error.
      res.on('close', () => {
        if (!res.complete) finish(asConnectionError(new Error('The connection closed mid-body')))
      })
    })
  }

  return attempt(request.url, MAX_REDIRECTS)
}
