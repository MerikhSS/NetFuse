import { cn } from 'cn'
import { ChevronsUpDown, Download, Gamepad2, LogOut, type LucideIcon } from 'lucide-react'
import { useState } from 'react'
import { useAppStore } from '../store/useAppStore'
import { LimitsDialog } from './LimitsDialog'
import { NetworksMenu } from './NetworksMenu'
import { ScheduleIndicator } from './ScheduleIndicator'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from './ui/dropdown-menu'

// The way around the window: each launcher's library, then the downloads; at the foot, the
// networks every download shares and the account. Steam is the only launcher so far. Another
// gets a row here and a library screen of its own, and nothing else has to move.

const sectionClass =
  'px-3 pt-4 pb-1.5 font-mono text-[10px] leading-none font-medium tracking-[0.16em] text-muted-foreground uppercase'

function NavItem({
  icon: Icon,
  label,
  count,
  current,
  onClick
}: {
  icon: LucideIcon
  label: string
  count?: number
  current: boolean
  onClick: () => void
}): React.JSX.Element {
  return (
    <button
      type="button"
      aria-current={current ? 'page' : undefined}
      onClick={onClick}
      className={cn(
        'mx-2 flex h-8 cursor-default items-center gap-2.5 rounded-md px-2.5 text-left text-[13px] font-medium transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring',
        current
          ? 'bg-foreground/[0.07] text-foreground'
          : 'text-[var(--text-secondary)] hover:bg-foreground/[0.04] hover:text-foreground'
      )}
    >
      <Icon aria-hidden className="size-4 shrink-0" />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {count !== undefined && count > 0 && (
        // Seen at a glance; the screen it opens says it in words.
        <span aria-hidden className="font-mono text-[11px] text-muted-foreground tabular-nums">
          {count}
        </span>
      )}
    </button>
  )
}

function AccountMenu(): React.JSX.Element | null {
  const login = useAppStore((store) => store.steamLogin)
  if (login?.status !== 'logged-in') return null
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <button
            type="button"
            aria-label={`Steam account ${login.accountName}`}
            className="flex h-10 w-full cursor-default items-center gap-2.5 rounded-md px-2 text-left outline-none hover:bg-foreground/[0.04] focus-visible:ring-2 focus-visible:ring-ring aria-expanded:bg-foreground/[0.06]"
          />
        }
      >
        <span
          aria-hidden
          className="flex size-7 shrink-0 items-center justify-center rounded-full bg-primary/15 text-[12px] font-bold text-primary uppercase"
        >
          {login.accountName.slice(0, 1)}
        </span>
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-[12.5px] font-semibold">{login.accountName}</span>
          <span className="text-[11px] text-muted-foreground">
            {login.remembered ? 'Steam · stays logged in' : 'Steam'}
          </span>
        </span>
        <ChevronsUpDown aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="start" className="min-w-48">
        <DropdownMenuItem onClick={() => void window.netfuse.steamLogout().catch(() => {})}>
          <LogOut />
          Log out of Steam
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export function Sidebar(): React.JSX.Element {
  const view = useAppStore((store) => store.view)
  const setView = useAppStore((store) => store.setView)
  const owned = useAppStore((store) =>
    store.library.status === 'ready' ? store.library.apps.length : undefined
  )
  // A count, not the downloads: progress ticks don't re-render the sidebar.
  const unfinished = useAppStore(
    (store) =>
      Object.values(store.downloads).filter(
        (download) => download.status !== 'completed' && download.status !== 'cancelled'
      ).length
  )
  const [limits, setLimits] = useState<{ open: boolean; page: string | null; schedule: boolean }>({
    open: false,
    page: null,
    schedule: false
  })

  return (
    <nav
      aria-label="Main"
      className="flex w-[212px] shrink-0 flex-col border-r-[0.5px] border-border bg-[var(--bg-secondary)]"
    >
      <div className={sectionClass}>Library</div>
      <NavItem
        icon={Gamepad2}
        label="Steam"
        count={owned}
        current={view.name === 'library' || view.name === 'game'}
        onClick={() => setView({ name: 'library' })}
      />
      <div className={sectionClass}>Transfers</div>
      <NavItem
        icon={Download}
        label="Downloads"
        count={unfinished}
        current={view.name === 'downloads' || view.name === 'download'}
        onClick={() => setView({ name: 'downloads' })}
      />
      <div className="flex-1" />
      <div className="flex flex-col gap-2 border-t-[0.5px] border-border p-2">
        <div className="flex items-center gap-1.5">
          <NetworksMenu
            showSpeed={false}
            className="min-w-0 flex-1 justify-start"
            onOpenLimits={(page) => setLimits({ open: true, page, schedule: false })}
          />
          <ScheduleIndicator
            onClick={() => setLimits({ open: true, page: null, schedule: true })}
          />
        </div>
        <AccountMenu />
      </div>
      <LimitsDialog
        open={limits.open}
        showSchedule={limits.schedule}
        onOpenChange={(open) => setLimits((now) => ({ ...now, open }))}
        page={limits.page}
        onPageChange={(page) => setLimits((now) => ({ ...now, page }))}
      />
    </nav>
  )
}
