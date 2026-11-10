import type { SteamLoginState, SteamPrepareProgress } from '../../shared/steam'
import type { NetworkMonitor } from '../network/interfaces'
import type { Limits } from '../network/limits'
import { loadSettings } from '../settings'
import { testSteamFake } from '../testKnobs'
import { SteamAccount } from './account'
import { SteamAnonymous } from './anonymous'
import type { SteamBackend } from './backend'
import { SteamLibrary } from './library'
import { SteamPlanner } from './prepare'
import { ChunkWorkerPool } from './workerPool'

// Everything Steam the main process keeps: the login, Steam's anonymous account (for Workshops of
// games the login doesn't own), the library, plans waiting to start, and the workers that check
// chunks. One of each, for every Steam download together.

export interface SteamServices {
  account: SteamAccount
  anonymous: SteamAnonymous
  library: SteamLibrary
  planner: SteamPlanner
  workers: ChunkWorkerPool
}

export function createSteamServices(deps: {
  networks: NetworkMonitor
  limits: Limits
  loginChanged: (state: SteamLoginState) => void
  progress: (progress: SteamPrepareProgress) => void
}): SteamServices {
  // Loaded the first time Steam is used: the real one brings steam-user and steam-session in.
  let backend: Promise<SteamBackend> | null = null
  const loadBackend = (): Promise<SteamBackend> => {
    const fake = testSteamFake()
    backend ??= fake
      ? import('./fakeBackend').then(({ fakeBackend }) => fakeBackend(fake))
      : import('./steamUserBackend').then(({ steamUserBackend }) => steamUserBackend())
    return backend
  }
  const account = new SteamAccount(loadBackend)
  account.onChange(deps.loginChanged)
  const anonymous = new SteamAnonymous(loadBackend)
  // Read each time: the switch is the renderer's, saved through updateSettings.
  const library = new SteamLibrary(
    account,
    anonymous,
    async () => (await loadSettings()).workshopAnonymous === true
  )
  const planner = new SteamPlanner({
    account,
    anonymous,
    library,
    networks: deps.networks,
    limits: deps.limits,
    progress: deps.progress
  })
  return { account, anonymous, library, planner, workers: new ChunkWorkerPool() }
}
