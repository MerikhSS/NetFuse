import type { SteamLoginState, SteamPrepareProgress } from '../../shared/steam'
import type { NetworkMonitor } from '../network/interfaces'
import type { Limits } from '../network/limits'
import { testSteamFake } from '../testKnobs'
import { SteamAccount } from './account'
import type { SteamBackend } from './backend'
import { SteamLibrary } from './library'
import { SteamPlanner } from './prepare'
import { ChunkWorkerPool } from './workerPool'

// Everything Steam the main process keeps: the login, the library, plans waiting to start, and
// the workers that check chunks. One of each, for every Steam download together.

export interface SteamServices {
  account: SteamAccount
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
  const library = new SteamLibrary(account)
  const planner = new SteamPlanner({
    account,
    library,
    networks: deps.networks,
    limits: deps.limits,
    progress: deps.progress
  })
  return { account, library, planner, workers: new ChunkWorkerPool() }
}
