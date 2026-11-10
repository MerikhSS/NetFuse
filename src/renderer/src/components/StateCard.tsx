import { useAppStore } from '../store/useAppStore'
import type { GameState } from '../utils/gameState'
import { useDownloadActions } from './downloadActionsContext'
import { Button } from './ui/button'

/** A download of a game or a Workshop item under way, or the folder it left: a way to it, on the
 * game's or the item's own page. `describe` says the state as that page does. */
export function StateCard({
  state,
  describe
}: {
  state: GameState
  describe: (state: GameState) => string | null
}): React.JSX.Element | null {
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
        <div className="text-[13px] font-semibold">{describe(state)}</div>
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
