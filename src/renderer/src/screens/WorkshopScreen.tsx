import type { SteamOwnedApp, WorkshopItem, WorkshopSort } from '@shared/steam'
import { cn } from 'cn'
import { AlertTriangle, Check, ChevronDown, ChevronLeft, Search } from 'lucide-react'
import { memo, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { GameCapsule, WorkshopPicture } from '../components/GameArt'
import { Button } from '../components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger
} from '../components/ui/dropdown-menu'
import { useWorkshopState } from '../hooks/useGameState'
import { useAppStore, type WorkshopBrowse } from '../store/useAppStore'
import { formatBytes } from '../utils/format'
import { describeWorkshopState } from '../utils/gameState'

// The Steam Workshop: mods, maps and the like that players make for a game, listed by Steam. The
// games the account owns that have a Workshop come first, to choose from; then the chosen game's
// items in one of Steam's orders, or matching a search, a page at a time. An item opens its own
// page, to be downloaded into a folder of the user's choosing (WorkshopItemScreen).

const SORTS: { value: WorkshopSort; label: string }[] = [
  { value: 'popular', label: 'Most popular' },
  { value: 'subscribed', label: 'Most subscribed' },
  { value: 'recent', label: 'Most recent' },
  { value: 'updated', label: 'Recently updated' }
]

/** How long typing pauses before the Workshop is searched. */
const SEARCH_DELAY_MS = 400

export function WorkshopScreen(): React.JSX.Element {
  const appId = useAppStore((store) => store.workshop.appId)
  const loadLibrary = useAppStore((store) => store.loadLibrary)
  useEffect(() => void loadLibrary(), [loadLibrary])
  return appId === null ? <WorkshopGames /> : <GameWorkshop key={appId} appId={appId} />
}

function SearchBox({
  value,
  onChange,
  label,
  onEnter
}: {
  value: string
  onChange: (value: string) => void
  label: string
  onEnter?: () => void
}): React.JSX.Element {
  return (
    <div className="flex h-8 w-52 min-w-0 shrink items-center gap-2 rounded-lg border border-input bg-[var(--input-bg)] px-2.5">
      <Search aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
      <input
        type="search"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => event.key === 'Enter' && onEnter?.()}
        placeholder={label}
        aria-label={label}
        spellCheck={false}
        className="min-w-0 flex-1 border-none bg-transparent text-[13px] outline-none"
      />
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

function Failure({
  message,
  onRetry
}: {
  message: string
  onRetry: () => void
}): React.JSX.Element {
  return (
    <div className="flex flex-col items-center gap-3 px-5 py-10 text-center">
      <div
        role="alert"
        className="flex max-w-[420px] items-start gap-2 text-[13px] text-[var(--color-danger)]"
      >
        <AlertTriangle className="mt-0.5 size-4 shrink-0" />
        {message}
      </div>
      <Button type="button" variant="secondary" onClick={onRetry}>
        Try again
      </Button>
    </div>
  )
}

/** The games the account owns that have a Workshop, to choose one. */
function WorkshopGames(): React.JSX.Element {
  const library = useAppStore((store) => store.library)
  const loadLibrary = useAppStore((store) => store.loadLibrary)
  const browseWorkshop = useAppStore((store) => store.browseWorkshop)
  const [query, setQuery] = useState('')

  const games = library.status === 'ready' ? library.apps.filter((app) => app.workshop) : []
  const needle = query.trim().toLowerCase()
  const shown = needle
    ? games.filter((app) => app.name.toLowerCase().includes(needle) || String(app.appId) === needle)
    : games

  return (
    <div className="flex h-full flex-col bg-background">
      <div className="flex h-12 shrink-0 items-center gap-3 border-b-[0.5px] border-border px-5">
        <h1 className="font-sans text-[14px] leading-none font-semibold">Workshop</h1>
        {library.status === 'ready' && (
          <span className="font-mono text-[11.5px] text-muted-foreground tabular-nums">
            {shown.length === games.length ? games.length : `${shown.length} of ${games.length}`}
          </span>
        )}
        <div className="flex-1" />
        <SearchBox value={query} onChange={setQuery} label="Search your games" />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {(library.status === 'loading' || library.status === 'idle') && (
          <Message>Loading your library…</Message>
        )}
        {library.status === 'error' && (
          <Failure message={library.message} onRetry={() => void loadLibrary(true)} />
        )}
        {library.status === 'ready' &&
          (games.length === 0 ? (
            <Message>None of the games this account owns has a Steam Workshop.</Message>
          ) : (
            <div className="flex flex-col gap-4 p-5">
              <p className="text-[12.5px] text-muted-foreground">
                Mods, maps and more, made by players for the games you own. Choose a game to see its
                Workshop.
              </p>
              {shown.length === 0 ? (
                <Message>None of your games with a Workshop matches.</Message>
              ) : (
                <div
                  role="list"
                  aria-label="Games with a Workshop"
                  className="grid grid-cols-[repeat(auto-fill,minmax(230px,1fr))] gap-2"
                >
                  {shown.map((app) => (
                    <div key={app.appId} role="listitem">
                      <GameRow app={app} onOpen={() => browseWorkshop({ appId: app.appId })} />
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}
      </div>
    </div>
  )
}

function GameRow({ app, onOpen }: { app: SteamOwnedApp; onOpen: () => void }): React.JSX.Element {
  return (
    <button
      type="button"
      aria-label={app.name}
      onClick={onOpen}
      className="flex w-full cursor-default items-center gap-3 rounded-lg border-[0.5px] border-border bg-card p-2 text-left outline-none hover:bg-secondary focus-visible:ring-2 focus-visible:ring-ring"
    >
      <div className="h-12 w-8 shrink-0 overflow-hidden rounded-md ring-1 ring-foreground/10">
        <GameCapsule appId={app.appId} name={app.name} small lazy />
      </div>
      <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{app.name}</span>
    </button>
  )
}

/** Where the items' list was scrolled to, for coming back to it from an item's page. */
let lastScroll: { browse: WorkshopBrowse; top: number } | null = null

/** One game's Workshop, in Steam's order or searched. */
function GameWorkshop({ appId }: { appId: number }): React.JSX.Element {
  const workshop = useAppStore((store) => store.workshop)
  const list = useAppStore((store) => store.workshopList)
  const browseWorkshop = useAppStore((store) => store.browseWorkshop)
  const loadWorkshop = useAppStore((store) => store.loadWorkshop)
  const setView = useAppStore((store) => store.setView)
  const name = useAppStore((store) =>
    store.library.status === 'ready'
      ? store.library.apps.find((app) => app.appId === appId)?.name
      : undefined
  )
  const [text, setText] = useState(workshop.search)
  const scroller = useRef<HTMLDivElement>(null)

  useEffect(() => void loadWorkshop(), [loadWorkshop])

  // Searched once typing pauses, or at once on Enter.
  useEffect(() => {
    if (text.trim() === workshop.search.trim()) return
    const timer = setTimeout(() => browseWorkshop({ search: text }), SEARCH_DELAY_MS)
    return () => clearTimeout(timer)
  }, [text, workshop.search, browseWorkshop])

  useLayoutEffect(() => {
    const element = scroller.current
    if (element && lastScroll && lastScroll.browse === useAppStore.getState().workshop) {
      element.scrollTop = lastScroll.top
    }
    return () => {
      if (element) lastScroll = { browse: useAppStore.getState().workshop, top: element.scrollTop }
    }
  }, [])

  const searching = workshop.search.trim() !== ''
  const items = list?.items ?? []
  const status = list?.status ?? 'loading'

  return (
    <div className="flex h-full flex-col bg-background">
      <div className="flex h-12 shrink-0 items-center gap-3 border-b-[0.5px] border-border px-5">
        <button
          type="button"
          onClick={() => browseWorkshop({ appId: null })}
          className="-ml-2 flex shrink-0 items-center gap-1 rounded-md px-1.5 py-1 font-sans text-[15px] leading-none font-medium text-[var(--text-secondary)] hover:text-foreground"
        >
          <ChevronLeft className="size-4.5" />
          Games
        </button>
        <h1 className="min-w-0 truncate font-sans text-[14px] leading-none font-semibold">
          {name ? `${name} Workshop` : 'Workshop'}
        </h1>
        <div className="flex-1" />
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button
                type="button"
                variant="secondary"
                size="sm"
                aria-label="Order"
                disabled={searching}
                className="shrink-0"
              >
                {searching
                  ? 'Best matches'
                  : SORTS.find((sort) => sort.value === workshop.sort)?.label}
                <ChevronDown data-icon="inline-end" />
              </Button>
            }
          />
          <DropdownMenuContent className="min-w-44">
            <DropdownMenuRadioGroup
              value={workshop.sort}
              onValueChange={(sort) => browseWorkshop({ sort: sort as WorkshopSort })}
            >
              {SORTS.map((sort) => (
                <DropdownMenuRadioItem key={sort.value} value={sort.value} closeOnClick>
                  {sort.label}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
        <SearchBox
          value={text}
          onChange={setText}
          label="Search the Workshop"
          onEnter={() => browseWorkshop({ search: text })}
        />
      </div>

      <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto">
        {status === 'loading' && items.length === 0 && (
          <Message>Asking Steam for this game’s Workshop…</Message>
        )}
        {status === 'error' && items.length === 0 && (
          <Failure message={list?.error ?? ''} onRetry={() => void loadWorkshop()} />
        )}
        {status === 'ready' && items.length === 0 && (
          <Message>
            {searching
              ? `Nothing in this Workshop matches “${workshop.search.trim()}”.`
              : 'This game’s Workshop has nothing in it yet.'}
          </Message>
        )}
        {items.length > 0 && (
          <div className="flex flex-col gap-5 p-5">
            <div
              role="list"
              aria-label="Workshop items"
              className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-[18px]"
            >
              {items.map((item) => (
                <div key={item.publishedFileId} role="listitem">
                  <WorkshopCard
                    item={item}
                    onOpen={(chosen) => setView({ name: 'workshop-item', item: chosen })}
                  />
                </div>
              ))}
            </div>
            <div className="flex flex-col items-center gap-2.5">
              <span className="font-mono text-[11.5px] text-muted-foreground tabular-nums">
                {items.length} of {list?.total ?? items.length}
              </span>
              {status === 'error' ? (
                <Failure message={list?.error ?? ''} onRetry={() => void loadWorkshop(true)} />
              ) : (
                list?.nextCursor && (
                  <Button
                    type="button"
                    variant="secondary"
                    disabled={status === 'loading'}
                    onClick={() => void loadWorkshop(true)}
                  >
                    {status === 'loading' ? 'Loading…' : 'Load more'}
                  </Button>
                )
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

const WorkshopCard = memo(function WorkshopCard({
  item,
  onOpen
}: {
  item: WorkshopItem
  onOpen: (item: WorkshopItem) => void
}): React.JSX.Element {
  const state = useWorkshopState(item.publishedFileId)
  const status = describeWorkshopState(state)
  const going = state.kind === 'downloading' || state.kind === 'paused' || state.kind === 'queued'

  return (
    <button
      type="button"
      aria-label={item.title}
      onClick={() => onOpen(item)}
      className="group flex w-full cursor-default flex-col gap-2 rounded-lg text-left outline-none"
    >
      <div className="relative aspect-square w-full overflow-hidden rounded-lg bg-muted shadow-sm ring-1 ring-foreground/10 transition-[box-shadow,transform] duration-150 group-hover:-translate-y-0.5 group-hover:shadow-lg group-hover:ring-foreground/25 group-focus-visible:ring-2 group-focus-visible:ring-ring">
        <WorkshopPicture publishedFileId={item.publishedFileId} name={item.title} />
        {state.kind === 'installed' && (
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
        <span className="line-clamp-2 text-[13px] leading-tight font-medium">{item.title}</span>
        <span
          className={cn(
            'truncate text-[11.5px] leading-tight',
            state.kind === 'error' ? 'text-[var(--color-danger)]' : 'text-muted-foreground'
          )}
        >
          {status ?? (item.downloadable ? formatBytes(item.size) : 'Can’t be downloaded')}
        </span>
      </div>
    </button>
  )
})
