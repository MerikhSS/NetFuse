import type { SteamOwnedApp } from '@shared/steam'
import { cn } from 'cn'
import { AlertTriangle, Check, RefreshCw, Search } from 'lucide-react'
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { FilterMenu } from '../components/FilterMenu'
import { GameCapsule } from '../components/GameArt'
import { FamilySharing } from '../components/steam/FamilySharing'
import { Button } from '../components/ui/button'
import { ToggleGroup, ToggleGroupItem } from '../components/ui/toggle-group'
import { useGameState } from '../hooks/useGameState'
import { useAppStore, type LibraryFilter, type LibraryKind } from '../store/useAppStore'
import { describeGameState } from '../utils/gameState'

// The account's Steam library: every game it owns, by its picture, with where each stands here
// (downloading, installed, installed by Steam itself). A library can run to thousands, so only
// the rows in view are drawn.

/** The narrowest a card gets before the grid drops a column. */
const MIN_CARD_PX = 148
const GAP_PX = 18
const PAD_PX = 20
/** The name and the status line under a picture. */
const CAPTION_PX = 44
/** Rows drawn beyond the visible ones, so a quick scroll doesn't show blanks. */
const OVERSCAN_ROWS = 2

const KINDS: { value: LibraryKind; label: string }[] = [
  { value: 'games', label: 'Games' },
  { value: 'tools', label: 'Tools' },
  { value: 'all', label: 'Games & tools' }
]

/** Which list an app belongs in, from its appinfo type. Steam lists its software ("application")
 * with its tools; demos and betas are games. */
const kindOf = (app: SteamOwnedApp): Exclude<LibraryKind, 'all'> =>
  app.type === 'tool' || app.type === 'application' ? 'tools' : 'games'

const FILTERS: { value: LibraryFilter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'installed', label: 'Installed' },
  { value: 'not-installed', label: 'Not installed' }
]

export function LibraryScreen(): React.JSX.Element {
  const library = useAppStore((store) => store.library)
  const loadLibrary = useAppStore((store) => store.loadLibrary)
  const loadClientApps = useAppStore((store) => store.loadClientApps)
  const query = useAppStore((store) => store.libraryQuery)
  const setQuery = useAppStore((store) => store.setLibraryQuery)
  const filter = useAppStore((store) => store.libraryFilter)
  const setFilter = useAppStore((store) => store.setLibraryFilter)
  const kind = useAppStore((store) => store.libraryKind)
  const setKind = useAppStore((store) => store.setLibraryKind)
  const history = useAppStore((store) => store.history)
  const clientApps = useAppStore((store) => store.clientApps)

  useEffect(() => {
    void loadLibrary()
    void loadClientApps()
  }, [loadLibrary, loadClientApps])

  // Installed by either: this app's finished downloads still where they were put, or Steam.
  const installed = useMemo(
    () =>
      new Set([
        ...history.filter((entry) => !entry.missing).map((entry) => entry.app.appId),
        ...clientApps
      ]),
    [history, clientApps]
  )

  const owned = library.status === 'ready' ? library.apps : []
  const kindCounts: Record<LibraryKind, number> = { games: 0, tools: 0, all: owned.length }
  for (const app of owned) kindCounts[kindOf(app)]++
  const all = kind === 'all' ? owned : owned.filter((app) => kindOf(app) === kind)
  const needle = query.trim().toLowerCase()
  const apps = all.filter(
    (app) =>
      (!needle || app.name.toLowerCase().includes(needle) || String(app.appId) === needle) &&
      (filter === 'all' || (filter === 'installed') === installed.has(app.appId))
  )

  return (
    <div className="flex h-full flex-col bg-background">
      <div className="flex h-12 shrink-0 items-center gap-3 border-b-[0.5px] border-border px-5">
        <div className="-ml-2.5 shrink-0">
          <FilterMenu
            options={KINDS}
            value={kind}
            counts={kindCounts}
            onChange={setKind}
            label="Show in the library"
          />
        </div>
        {library.status === 'ready' && (
          <span className="hidden shrink-0 font-mono text-[11.5px] text-muted-foreground tabular-nums min-[1000px]:inline">
            {apps.length === all.length ? all.length : `${apps.length} of ${all.length}`}
          </span>
        )}
        <div className="flex-1" />
        <ToggleGroup
          value={[filter]}
          onValueChange={(values) => values.length > 0 && setFilter(values[0] as LibraryFilter)}
          aria-label="Show"
          variant="pill"
          size="xs"
          spacing={1}
          className="shrink-0"
        >
          {FILTERS.map((option) => (
            <ToggleGroupItem key={option.value} value={option.value} className="h-6 px-2.5">
              {option.label}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
        <div className="flex h-8 w-52 min-w-0 shrink items-center gap-2 rounded-lg border border-input bg-[var(--input-bg)] px-2.5">
          <Search aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search your library"
            aria-label="Search your library"
            spellCheck={false}
            className="min-w-0 flex-1 border-none bg-transparent text-[13px] outline-none"
          />
        </div>
        <Button
          type="button"
          variant="secondary"
          size="icon"
          aria-label="Refresh library"
          disabled={library.status === 'loading'}
          onClick={() => {
            void loadLibrary(true)
            void loadClientApps()
          }}
        >
          <RefreshCw />
        </Button>
      </div>

      {(library.status === 'loading' || library.status === 'idle') && (
        <Message>Loading your library…</Message>
      )}
      {library.status === 'error' && (
        <div className="flex flex-col items-center gap-3 px-5 py-16 text-center">
          <div
            role="alert"
            className="flex max-w-[420px] items-start gap-2 text-[13px] text-[var(--color-danger)]"
          >
            <AlertTriangle className="mt-0.5 size-4 shrink-0" />
            {library.message}
          </div>
          <Button type="button" variant="secondary" onClick={() => void loadLibrary(true)}>
            Try again
          </Button>
        </div>
      )}
      {library.status === 'ready' &&
        apps.length === 0 &&
        (owned.length === 0 ? (
          <Message>This account owns nothing that can be downloaded.</Message>
        ) : (
          <div role="status" className="flex flex-col items-center gap-3 px-5 py-16 text-center">
            <p className="text-[14px] font-semibold">Nothing in your library matches</p>
            <Button
              type="button"
              variant="secondary"
              onClick={() => {
                setQuery('')
                setFilter('all')
                setKind('all')
              }}
            >
              Show everything
            </Button>
          </div>
        ))}
      {apps.length > 0 && <GameGrid apps={apps} />}
    </div>
  )
}

function Message({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <div role="status" className="px-5 py-16 text-center text-[13px] text-muted-foreground">
      {children}
    </div>
  )
}

function GameGrid({ apps }: { apps: SteamOwnedApp[] }): React.JSX.Element {
  const openGame = useAppStore((store) => store.openGame)
  const scroller = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({ width: 0, height: 0 })
  const [scrollTop, setScrollTop] = useState(0)

  useLayoutEffect(() => {
    const element = scroller.current
    if (!element) return
    const observer = new ResizeObserver(([entry]) =>
      setSize({ width: entry.contentRect.width, height: entry.contentRect.height })
    )
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  const inner = Math.max(0, size.width - PAD_PX * 2)
  const columns = Math.max(1, Math.floor((inner + GAP_PX) / (MIN_CARD_PX + GAP_PX)))
  const cardWidth = (inner - GAP_PX * (columns - 1)) / columns
  const rowHeight = cardWidth * 1.5 + CAPTION_PX + GAP_PX
  const rows = Math.ceil(apps.length / columns)
  const firstRow = Math.max(0, Math.floor((scrollTop - PAD_PX) / rowHeight) - OVERSCAN_ROWS)
  const lastRow = Math.min(rows, Math.ceil((scrollTop + size.height) / rowHeight) + OVERSCAN_ROWS)
  const shown = size.width > 0 ? apps.slice(firstRow * columns, lastRow * columns) : []

  return (
    <div
      ref={scroller}
      onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
      className="min-h-0 flex-1 overflow-y-auto"
    >
      <div
        role="list"
        aria-label="Your Steam library"
        className="relative"
        style={{ height: rows * rowHeight - GAP_PX + PAD_PX * 2 }}
      >
        {shown.map((app, offset) => {
          const index = firstRow * columns + offset
          return (
            <div
              key={app.appId}
              role="listitem"
              className="absolute"
              style={{
                top: PAD_PX + Math.floor(index / columns) * rowHeight,
                left: PAD_PX + (index % columns) * (cardWidth + GAP_PX),
                width: cardWidth
              }}
            >
              <GameCard app={app} onOpen={openGame} />
            </div>
          )
        })}
      </div>
    </div>
  )
}

const GameCard = memo(function GameCard({
  app,
  onOpen
}: {
  app: SteamOwnedApp
  onOpen: (appId: number) => void
}): React.JSX.Element {
  const state = useGameState(app.appId)
  const status = describeGameState(state)
  const going = state.kind === 'downloading' || state.kind === 'paused' || state.kind === 'queued'
  const installed = state.kind === 'installed' || state.kind === 'in-steam'
  const typeLabel = app.type !== 'game' ? app.type[0].toUpperCase() + app.type.slice(1) : null

  return (
    <button
      type="button"
      aria-label={app.name}
      onClick={() => onOpen(app.appId)}
      className="group flex w-full cursor-default flex-col gap-2 rounded-lg text-left outline-none"
    >
      <div className="relative aspect-[2/3] w-full overflow-hidden rounded-lg bg-muted shadow-sm ring-1 ring-foreground/10 transition-[box-shadow,transform] duration-150 group-hover:-translate-y-0.5 group-hover:shadow-lg group-hover:ring-foreground/25 group-focus-visible:ring-2 group-focus-visible:ring-ring">
        <GameCapsule appId={app.appId} name={app.name} />
        {installed && (
          <span
            aria-hidden
            className="absolute top-2 right-2 flex size-6 items-center justify-center rounded-full bg-black/55 text-white backdrop-blur-sm"
          >
            <Check className="size-3.5" />
          </span>
        )}
        {going && (
          <div className="absolute inset-x-0 bottom-0 h-1.5 bg-black/45">
            <div
              className={cn(
                'h-full transition-[width] duration-200',
                state.kind === 'downloading' ? 'bg-white' : 'bg-white/50'
              )}
              style={{ width: `${state.percent}%` }}
            />
          </div>
        )}
      </div>
      <div className="flex min-w-0 flex-col gap-1 px-0.5">
        <span className="truncate text-[13px] leading-tight font-medium">{app.name}</span>
        <span
          className={cn(
            'flex min-w-0 items-center gap-1.5 truncate text-[11.5px] leading-tight',
            state.kind === 'error' ? 'text-[var(--color-danger)]' : 'text-muted-foreground'
          )}
        >
          {status ?? typeLabel ?? (app.borrowed ? null : ' ')}
          {!status && app.borrowed && <FamilySharing />}
        </span>
      </div>
    </button>
  )
})
