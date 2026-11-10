import type { SteamBackend, SteamSession } from './backend'
import { eresultOf } from './eresult'

// Steam's anonymous account, the one SteamCMD's `login anonymous` uses. It owns nothing, yet Steam
// hands it the Workshops of some games, game by game: most with a free dedicated server, and
// others their makers open to everyone. NetFuse uses it for one thing: a Workshop item of a game
// the logged-in account doesn't own, once the user has turned the Workshop tab's switch on. Never
// a game's own depots: those stay the account's (see prepare.ts and steamTransfer.ts), and Steam
// turns the anonymous account down for them in any case.
//
// It logs on the first time it is needed, and stays on for the rest of the run: a download through
// it asks for CDN tokens as it goes.

/** How long Steam's answer about a game is trusted before it is asked again. */
const OPEN_KNOWN_FOR_MS = 24 * 60 * 60_000

export class SteamAnonymous {
  private session: Promise<SteamSession> | null = null
  /** Whether Steam lets the anonymous account have each game's Workshop, as it last said. */
  private readonly open = new Map<number, { open: boolean; at: number }>()

  constructor(private readonly backend: () => Promise<SteamBackend>) {}

  /** The anonymous session, logged on now if it isn't already. */
  current(): Promise<SteamSession> {
    const session: Promise<SteamSession> = (this.session ??= this.backend()
      .then((backend) => backend.logOnAnonymous())
      .then((logged) => {
        // Steam dropped it: the next request logs on again.
        logged.onLoggedOut(() => {
          if (this.session === session) this.session = null
        })
        return logged
      })
      .catch((error) => {
        if (this.session === session) this.session = null
        throw error
      }))
    return session
  }

  /**
   * Whether Steam lets the anonymous account have `appId`'s Workshop: it is asked for the Workshop
   * depot's key, as a download would, and the key is dropped. Only Steam's answer is remembered:
   * a request that timed out or found no connection says nothing, and throws.
   */
  async workshopOpen(appId: number, workshopDepot: number): Promise<boolean> {
    const known = this.open.get(appId)
    if (known && Date.now() - known.at < OPEN_KNOWN_FOR_MS) return known.open
    const session = await this.current()
    let open: boolean
    try {
      await session.depotKey(appId, workshopDepot)
      open = true
    } catch (error) {
      if (eresultOf(error) === undefined) throw error
      open = false
    }
    this.open.set(appId, { open, at: Date.now() })
    return open
  }

  async logOff(): Promise<void> {
    const session = this.session
    this.session = null
    await session?.then((logged) => logged.logOff()).catch(() => {})
  }
}
