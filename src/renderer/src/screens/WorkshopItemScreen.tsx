import type { SteamPlan, SteamPrepareProgress, WorkshopItem } from '@shared/steam'
import { AlertTriangle, ChevronLeft } from 'lucide-react'
import { useEffect, useState } from 'react'
import { WorkshopPicture } from '../components/GameArt'
import { StateCard } from '../components/StateCard'
import { NetworkChips } from '../components/steam/NetworkChips'
import { Badge } from '../components/ui/badge'
import { Button } from '../components/ui/button'
import { Checkbox } from '../components/ui/checkbox'
import { useWorkshopState } from '../hooks/useGameState'
import { useNetworkChoice } from '../hooks/useNetworkChoice'
import { useAppStore } from '../store/useAppStore'
import { describeError, formatBytes, toDisplayPath } from '../utils/format'
import { describeWorkshopState } from '../utils/gameState'

// One Workshop item's own page: its picture, what it is, and where it stands here; then where to
// download it and over which networks. It goes into a folder named after it, in the folder chosen,
// as a download of its own. NetFuse doesn't subscribe to it, or write into Steam's own Workshop
// folder: the game is pointed at it however the game takes mods.

const labelClass = 'w-20 shrink-0 text-[12.5px] text-[var(--text-secondary)]'

export function WorkshopItemScreen({ item }: { item: WorkshopItem }): React.JSX.Element {
  const setView = useAppStore((store) => store.setView)
  const owned = useAppStore((store) =>
    store.library.status === 'ready'
      ? store.library.apps.find((app) => app.appId === item.appId)
      : undefined
  )
  const gameName = useAppStore(
    (store) =>
      owned?.name ?? (store.workshop.appId === item.appId ? store.workshop.name : undefined)
  )
  const state = useWorkshopState(item.publishedFileId)
  const status = describeWorkshopState(state)

  return (
    <div className="flex h-full flex-col bg-background">
      <div className="flex h-12 shrink-0 items-center gap-2 border-b-[0.5px] border-border px-5">
        <button
          type="button"
          onClick={() => setView({ name: 'workshop' })}
          className="-ml-2 flex min-w-0 items-center gap-1 rounded-md px-1.5 py-1 font-sans text-[15px] leading-none font-medium text-[var(--text-secondary)] hover:text-foreground"
        >
          <ChevronLeft className="size-4.5 shrink-0" />
          <span className="truncate">{gameName ? `${gameName} Workshop` : 'Workshop'}</span>
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="flex flex-col gap-4 px-5 pt-5 pb-6">
          <div className="flex items-start gap-5">
            <div className="size-[168px] shrink-0 overflow-hidden rounded-lg shadow-lg ring-1 ring-foreground/15">
              <WorkshopPicture publishedFileId={item.publishedFileId} name={item.title} />
            </div>
            <div className="flex min-w-0 flex-1 flex-col gap-2">
              <h1 className="text-[22px] leading-tight font-bold break-words">{item.title}</h1>
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-[11.5px] text-muted-foreground tabular-nums">
                {[
                  item.size > 0 && formatBytes(item.size),
                  item.updatedAt > 0 &&
                    `Updated ${new Date(item.updatedAt * 1000).toLocaleDateString()}`,
                  `${item.subscriptions.toLocaleString()} ${item.subscriptions === 1 ? 'subscriber' : 'subscribers'}`
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </div>
              {status && (
                <div
                  className={
                    state.kind === 'error'
                      ? 'text-[12px] text-[var(--color-danger)]'
                      : 'text-[12px] text-[var(--text-secondary)]'
                  }
                >
                  {status}
                </div>
              )}
              {item.tags.length > 0 && (
                <div aria-label="Tags" className="flex flex-wrap gap-1">
                  {item.tags.map((tag) => (
                    <Badge key={tag} variant="secondary" className="h-5 text-[11px]">
                      {tag}
                    </Badge>
                  ))}
                </div>
              )}
              {item.description && (
                <p className="text-[12.5px] leading-relaxed text-[var(--text-secondary)]">
                  {item.description}
                </p>
              )}
            </div>
          </div>

          <StateCard state={state} describe={describeWorkshopState} />
          <section
            aria-label="Download options"
            className="flex flex-col gap-3.5 rounded-xl border-[0.5px] border-border bg-card p-4"
          >
            <h2 className="text-[13px] font-semibold">
              {state.kind === 'installed' ? 'Download again' : 'Download'}
            </h2>
            {item.downloadable ? (
              <DownloadOptions
                item={item}
                anonymous={!owned}
                onStarted={(id, queued) => {
                  // Its own screen opens, unless it only joined the queue: then this page says so.
                  if (!queued) setView({ name: 'download', id })
                }}
              />
            ) : (
              <p className="text-[12.5px] text-muted-foreground">
                This item is kept in Steam’s old Workshop storage, which NetFuse can’t download.
                Subscribe to it in Steam to get it.
              </p>
            )}
          </section>
        </div>
      </div>
    </div>
  )
}

type Start =
  | { status: 'idle' }
  | { status: 'preparing'; progress: SteamPrepareProgress | null }
  /** Worked out, with something worth saying before it starts. */
  | { status: 'confirm'; plan: SteamPlan }
  | { status: 'starting' }

/** Where the item goes and over which networks, then Download. As a game's page does, it's worked
 * out in the main process first (its file list fetched, a folder already there checked). */
function DownloadOptions({
  item,
  anonymous,
  onStarted
}: {
  item: WorkshopItem
  /** The account doesn't own the game. */
  anonymous: boolean
  onStarted: (downloadId: string, queued: boolean) => void
}): React.JSX.Element {
  const homeDir = useAppStore((store) => store.homeDir)
  const destinationDir = useAppStore((store) => store.destinationDir)
  const setDestinationDir = useAppStore((store) => store.setDestinationDir)
  const full = useAppStore(
    (store) =>
      Object.values(store.downloads).filter((download) => download.status === 'downloading')
        .length >= store.downloadsAtOnce
  )
  const networks = useNetworkChoice()
  const [adopt, setAdopt] = useState(false)
  const [freeBytes, setFreeBytes] = useState<number | null>(null)
  const [start, setStart] = useState<Start>({ status: 'idle' })
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let stale = false
    window.netfuse
      .freeSpace(destinationDir)
      .then((bytes) => !stale && setFreeBytes(bytes))
      .catch(() => !stale && setFreeBytes(null))
    return () => {
      stale = true
    }
  }, [destinationDir])

  // Progress is told by game; only one of the game's items is worked out here at a time.
  useEffect(
    () =>
      window.netfuse.onSteamPrepareProgress((progress) => {
        if (progress.appId !== item.appId) return
        setStart((now) => (now.status === 'preparing' ? { status: 'preparing', progress } : now))
      }),
    [item.appId]
  )

  const tooBig = !adopt && freeBytes !== null && item.size > freeBytes
  const busy = start.status === 'preparing' || start.status === 'starting'
  const canStart = networks.networkIds.length > 0 && Boolean(destinationDir) && !busy && !tooBig

  const begin = async (plan: SteamPlan): Promise<void> => {
    setStart({ status: 'starting' })
    try {
      const id = await window.netfuse.startDownload({
        kind: 'steam',
        planId: plan.planId,
        interfaceIds: networks.networkIds
      })
      onStarted(id, full)
    } catch (cause) {
      setError(describeError(cause))
      setStart({ status: 'idle' })
    }
  }

  const prepare = async (): Promise<void> => {
    setError(null)
    setStart({ status: 'preparing', progress: null })
    try {
      const plan = await window.netfuse.steamPrepareWorkshop({
        appId: item.appId,
        publishedFileId: item.publishedFileId,
        destinationDir,
        adopt
      })
      if (plan.warnings.length > 0) setStart({ status: 'confirm', plan })
      else await begin(plan)
    } catch (cause) {
      setError(describeError(cause))
      setStart({ status: 'idle' })
    }
  }

  return (
    <>
      <div className="flex flex-col gap-3">
        <div className="flex items-center gap-3">
          <div className={labelClass}>Save to</div>
          <div className="min-w-0 flex-1 truncate font-mono text-[12.5px]">
            {toDisplayPath(destinationDir, homeDir)}
          </div>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            disabled={busy}
            onClick={async () => {
              const folder = await window.netfuse.chooseDestinationFolder(destinationDir)
              if (folder) setDestinationDir(folder)
            }}
          >
            Change
          </Button>
        </div>
        <div className="text-[12px] leading-snug text-muted-foreground">
          It goes into a folder named after it. Point the game at it the way the game takes mods.
        </div>
        {anonymous && (
          <div className="text-[12px] leading-snug text-muted-foreground">
            This game isn’t in your Steam library: the item comes through Steam’s anonymous account,
            which Steam lets have this game’s Workshop.
          </div>
        )}
        <div className="font-mono text-[11.5px] text-muted-foreground">
          {[
            item.size > 0 && `${formatBytes(item.size)} installed`,
            freeBytes !== null && `${formatBytes(freeBytes)} free`
          ]
            .filter(Boolean)
            .join(' · ')}
        </div>
        {tooBig && (
          <Problem message="There isn’t enough free space on this drive for this item. Choose another folder or free up space." />
        )}
        <label className="flex items-start gap-2 text-[12.5px]">
          <Checkbox
            checked={adopt}
            disabled={busy}
            onCheckedChange={(checked) => setAdopt(checked)}
            className="mt-0.5"
          />
          <span>
            Update the copy already in this folder
            <span className="block text-muted-foreground">
              Files already there and correct are kept: only what’s missing or different is fetched.
              Nothing else in the folder is touched.
            </span>
          </span>
        </label>

        <div className="flex items-start gap-3">
          <div className={`${labelClass} pt-1.5`} id="workshop-networks">
            Networks
          </div>
          <NetworkChips choice={networks} labelledBy="workshop-networks" />
        </div>

        {start.status === 'confirm' && (
          <div className="flex flex-col gap-1.5 rounded-lg border-[0.5px] border-border bg-card px-3 py-2 text-[12.5px]">
            {start.plan.warnings.map((warning) => (
              <div key={warning} className="flex items-start gap-2">
                <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-foreground" />
                {warning}
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="flex items-center gap-2 border-t-[0.5px] border-border pt-3">
        <div className="min-w-0 flex-1 truncate text-[12.5px]">
          {error ? (
            <span role="alert" className="text-[var(--color-danger)]">
              {error}
            </span>
          ) : start.status === 'preparing' ? (
            <span className="text-muted-foreground">{progressText(start.progress)}</span>
          ) : null}
        </div>
        {start.status === 'confirm' ? (
          <>
            <Button type="button" variant="secondary" onClick={() => setStart({ status: 'idle' })}>
              Back
            </Button>
            <Button type="button" onClick={() => void begin(start.plan)}>
              Download anyway
            </Button>
          </>
        ) : (
          <Button type="button" disabled={!canStart} onClick={() => void prepare()}>
            {busy ? 'Preparing' : full ? 'Add to queue' : 'Download'}
          </Button>
        )}
      </div>
    </>
  )
}

function progressText(progress: SteamPrepareProgress | null): string {
  if (!progress || progress.step === 'manifests') return 'Asking Steam for the item’s file list…'
  return `Checking the files already there: ${Math.floor((progress.done / Math.max(1, progress.total)) * 100)}%`
}

function Problem({ message }: { message: string }): React.JSX.Element {
  return (
    <div role="alert" className="flex items-start gap-2 text-[12.5px] text-[var(--color-danger)]">
      <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
      {message}
    </div>
  )
}
