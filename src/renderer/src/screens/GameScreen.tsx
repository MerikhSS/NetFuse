import type { SteamAppDetails } from '@shared/steam'
import { AlertTriangle, Check, ChevronLeft } from 'lucide-react'
import { useEffect, useState } from 'react'
import { GameCapsule, GameHero } from '../components/GameArt'
import { useDownloadActions } from '../components/downloadActionsContext'
import { FamilySharing } from '../components/steam/FamilySharing'
import { InstallOptions } from '../components/steam/SteamAppDetails'
import { Button } from '../components/ui/button'
import { useGameState } from '../hooks/useGameState'
import { useAppStore } from '../store/useAppStore'
import { describeError } from '../utils/format'
import { describeGameState, type GameState } from '../utils/gameState'

// One game's own page: its banner and name, where it stands on this computer, and what of it to
// install. Steam is asked about it (its branches and depots) when the page opens.

type Load =
  | { status: 'loading' }
  | { status: 'ready'; details: SteamAppDetails }
  | { status: 'error'; message: string }

export function GameScreen({ appId }: { appId: number }): React.JSX.Element {
  const setView = useAppStore((store) => store.setView)
  const owned = useAppStore((store) =>
    store.library.status === 'ready'
      ? store.library.apps.find((app) => app.appId === appId)
      : undefined
  )
  const state = useGameState(appId)
  const [load, setLoad] = useState<Load>({ status: 'loading' })

  useEffect(() => {
    let stale = false
    window.netfuse
      .steamAppDetails(appId)
      .then((details) => !stale && setLoad({ status: 'ready', details }))
      .catch((error: unknown) => {
        if (!stale) setLoad({ status: 'error', message: describeError(error) })
      })
    return () => {
      stale = true
    }
  }, [appId])

  const name = owned?.name ?? (load.status === 'ready' ? load.details.name : '')

  return (
    <div className="flex h-full flex-col bg-background">
      <div className="flex h-12 shrink-0 items-center gap-2 border-b-[0.5px] border-border px-5">
        <button
          type="button"
          onClick={() => setView({ name: 'library' })}
          className="-ml-2 flex items-center gap-1 rounded-md px-1.5 py-1 font-sans text-[15px] leading-none font-medium text-[var(--text-secondary)] hover:text-foreground"
        >
          <ChevronLeft className="size-4.5" />
          Library
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="relative h-[210px] shrink-0">
          <GameHero appId={appId} />
          <div className="absolute inset-0 bg-gradient-to-t from-background via-background/40 to-transparent" />
          <div className="absolute inset-x-5 bottom-4 flex items-end gap-4">
            <div className="aspect-[2/3] w-[92px] shrink-0 overflow-hidden rounded-lg shadow-lg ring-1 ring-foreground/15">
              <GameCapsule appId={appId} name={name} />
            </div>
            <div className="flex min-w-0 flex-col gap-1.5 pb-1">
              <h1 className="truncate text-[24px] leading-tight font-bold">{name}</h1>
              <div className="flex flex-wrap items-center gap-2 text-[12px] text-[var(--text-secondary)]">
                {owned && owned.type !== 'game' && <span className="capitalize">{owned.type}</span>}
                {owned?.borrowed && <FamilySharing />}
                <StateLine state={state} />
              </div>
            </div>
          </div>
        </div>

        <div className="flex flex-col gap-4 px-5 pt-2 pb-6">
          <StateCard state={state} />
          <section
            aria-label="Install"
            className="flex flex-col gap-3.5 rounded-xl border-[0.5px] border-border bg-card p-4"
          >
            <h2 className="text-[13px] font-semibold">
              {state.kind === 'installed' || state.kind === 'in-steam'
                ? 'Install again'
                : 'Install'}
            </h2>
            {load.status === 'loading' && (
              <div className="py-4 text-[12.5px] text-muted-foreground">
                Asking Steam about this game…
              </div>
            )}
            {load.status === 'error' && (
              <div
                role="alert"
                className="flex items-start gap-2 text-[12.5px] text-[var(--color-danger)]"
              >
                <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
                {load.message}
              </div>
            )}
            {load.status === 'ready' && (
              <InstallOptions
                key={load.details.appId}
                details={load.details}
                onStarted={(id, queued) => {
                  // Its own screen opens, unless it only joined the queue: then this page says so.
                  if (!queued) setView({ name: 'download', id })
                }}
              />
            )}
          </section>
        </div>
      </div>
    </div>
  )
}

function StateLine({ state }: { state: GameState }): React.JSX.Element | null {
  const text = describeGameState(state)
  if (!text) return null
  return (
    <span
      className={state.kind === 'error' ? 'text-[var(--color-danger)]' : 'flex items-center gap-1'}
    >
      {(state.kind === 'installed' || state.kind === 'in-steam') && (
        <Check aria-hidden className="size-3.5" />
      )}
      {text}
    </span>
  )
}

/** A download of the game under way, or the install it left: a way to it. */
function StateCard({ state }: { state: GameState }): React.JSX.Element | null {
  const setView = useAppStore((store) => store.setView)
  const { perform } = useDownloadActions()
  const download = useAppStore((store) => {
    if (state.kind === 'none' || state.kind === 'in-steam') return null
    return (
      store.downloads[state.downloadId] ??
      store.history.find((entry) => entry.id === state.downloadId) ??
      null
    )
  })
  if (!download || state.kind === 'none' || state.kind === 'in-steam') return null

  const going = state.kind !== 'installed'
  const percent = 'percent' in state ? state.percent : 100
  return (
    <section
      aria-label={going ? 'Download' : 'Installed'}
      className="flex items-center gap-4 rounded-xl border-[0.5px] border-border bg-card p-4"
    >
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <div className="text-[13px] font-semibold">{describeGameState(state)}</div>
        {going ? (
          <div className="h-1.5 overflow-hidden rounded-full bg-muted">
            <div
              className="h-full rounded-full bg-foreground transition-[width] duration-200"
              style={{ width: `${percent}%` }}
            />
          </div>
        ) : (
          <div className="truncate font-mono text-[11.5px] text-muted-foreground">
            {download.destinationPath}
          </div>
        )}
      </div>
      {!going && (
        <Button
          type="button"
          variant="secondary"
          onClick={() => void perform('reveal', [download])}
        >
          {window.netfuse.platform === 'darwin' ? 'Show in Finder' : 'Show in folder'}
        </Button>
      )}
      <Button
        type="button"
        variant={going ? 'default' : 'secondary'}
        onClick={() => setView({ name: 'download', id: download.id })}
      >
        {going ? 'Show download' : 'Details'}
      </Button>
    </section>
  )
}
