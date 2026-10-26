import type {
  SteamAppDetails as Details,
  SteamArch,
  SteamDepot,
  SteamLibraryFolder,
  SteamOs,
  SteamPlan,
  SteamPrepareProgress,
  SteamSelection
} from '@shared/steam'
import {
  defaultDepots,
  defaultLanguage,
  depotUnavailable,
  languageName,
  manifestFor,
  steamSystem
} from '@shared/steamSelection'
import { cn } from 'cn'
import { AlertTriangle, ChevronDown } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useNetworkUsage } from '../../hooks/useNetworks'
import { useNetworkVisuals } from '../../hooks/useNetworkVisuals'
import { useAppStore } from '../../store/useAppStore'
import { describeError, formatBytes, toDisplayPath } from '../../utils/format'
import { Button } from '../ui/button'
import { Checkbox } from '../ui/checkbox'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger
} from '../ui/dropdown-menu'
import { ToggleGroup, ToggleGroupItem } from '../ui/toggle-group'
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip'
import { FamilySharing } from './FamilySharing'

// One owned game, and what of it to download: the branch, the system, architecture and language
// (which pick the depots Steam itself would install), the depots themselves, where it goes and
// over which networks. Download works the download out in the main process (manifests fetched,
// an existing folder checked) and then starts it.

const labelClass = 'w-20 shrink-0 text-[12.5px] text-[var(--text-secondary)]'

const SYSTEMS: { value: SteamOs; label: string }[] = [
  { value: 'windows', label: 'Windows' },
  { value: 'macos', label: 'macOS' },
  { value: 'linux', label: 'Linux' }
]

/** Looking for the Steam client's libraries, for a game to go where Steam keeps its own. */
type Detect =
  | { status: 'idle' }
  | { status: 'looking' }
  | { status: 'none' }
  | { status: 'choose'; libraries: SteamLibraryFolder[] }

type Start =
  | { status: 'idle' }
  | { status: 'preparing'; progress: SteamPrepareProgress | null }
  /** Worked out, with something worth saying before it starts. */
  | { status: 'confirm'; plan: SteamPlan }
  | { status: 'starting' }

/** What of a game to download, and where to: the choices, then Download. */
export function InstallOptions({
  details,
  onStarted
}: {
  details: Details
  onStarted: (downloadId: string, queued: boolean) => void
}): React.JSX.Element {
  const interfaces = useAppStore((store) => store.interfaces)
  const homeDir = useAppStore((store) => store.homeDir)
  const destinationDir = useAppStore((store) => store.destinationDir)
  const setDestinationDir = useAppStore((store) => store.setDestinationDir)
  const networkPreferences = useAppStore((store) => store.networkPreferences)
  const full = useAppStore(
    (store) =>
      Object.values(store.downloads).filter((download) => download.status === 'downloading')
        .length >= store.downloadsAtOnce
  )
  const networkVisual = useNetworkVisuals()
  const usage = useNetworkUsage(true)

  // The renderer can't tell the processor; every current Steam client is 64-bit.
  const [selection, setSelection] = useState<SteamSelection>(() => ({
    branch: details.branches.some((branch) => branch.name === 'public')
      ? 'public'
      : (details.branches.find((branch) => !branch.passwordRequired)?.name ?? 'public'),
    ...steamSystem(window.netfuse.platform, 'x64'),
    language: defaultLanguage(details)
  }))
  const [chosen, setChosen] = useState<number[]>(() => defaultDepots(details, selection))
  const [adopt, setAdopt] = useState(false)
  const [freeBytes, setFreeBytes] = useState<number | null>(null)
  const [deselected, setDeselected] = useState<string[]>(() =>
    Object.entries(useAppStore.getState().networkPreferences)
      .filter(([, preference]) => preference.off)
      .map(([id]) => id)
  )
  const [start, setStart] = useState<Start>({ status: 'idle' })
  const [error, setError] = useState<string | null>(null)
  const [detect, setDetect] = useState<Detect>({ status: 'idle' })
  /** The libraries last found, to tell when the folder is one of them. */
  const [libraries, setLibraries] = useState<SteamLibraryFolder[]>([])
  const folderName = details.installDir || details.name

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

  useEffect(
    () =>
      window.netfuse.onSteamPrepareProgress((progress) => {
        if (progress.appId !== details.appId) return
        setStart((now) => (now.status === 'preparing' ? { status: 'preparing', progress } : now))
      }),
    [details.appId]
  )

  /** A different branch, system or language: the depots go back to what Steam would pick. */
  const choose = (patch: Partial<SteamSelection>): void => {
    const next = { ...selection, ...patch }
    setSelection(next)
    setChosen(defaultDepots(details, next))
  }

  const isReached = (id: string): boolean => {
    const dataLimit = networkPreferences[id]?.dataLimit
    return dataLimit !== undefined && (usage[id] ?? 0) >= dataLimit
  }
  const availableIds = interfaces.map((iface) => iface.id).filter((id) => !isReached(id))
  const networkIds = availableIds.filter((id) => !deselected.includes(id))
  const toggleNetwork = (id: string): void => {
    if (isReached(id)) return
    setDeselected((previous) => {
      if (previous.includes(id)) return previous.filter((entry) => entry !== id)
      const remaining = availableIds.filter((other) => !previous.includes(other) && other !== id)
      return remaining.length === 0 ? previous : [...previous, id]
    })
  }

  const picked = details.depots.filter((depot) => chosen.includes(depot.depotId))
  const installBytes = picked.reduce(
    (sum, depot) => sum + (manifestFor(depot, selection.branch)?.size ?? 0),
    0
  )
  const downloadBytes = picked.reduce(
    (sum, depot) => sum + (manifestFor(depot, selection.branch)?.download ?? 0),
    0
  )
  const tooBig = !adopt && freeBytes !== null && installBytes > freeBytes
  const busy = start.status === 'preparing' || start.status === 'starting'
  const canStart =
    picked.length > 0 && networkIds.length > 0 && Boolean(destinationDir) && !busy && !tooBig

  const begin = async (plan: SteamPlan): Promise<void> => {
    setStart({ status: 'starting' })
    try {
      const id = await window.netfuse.startDownload({
        kind: 'steam',
        planId: plan.planId,
        interfaceIds: networkIds
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
      const plan = await window.netfuse.steamPrepare({
        appId: details.appId,
        branch: selection.branch,
        depotIds: picked.map((depot) => depot.depotId),
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

  /** A library that already has the game is installed over, so that only what's missing or
   * different is fetched, rather than into a second copy beside it. */
  const pickLibrary = (library: SteamLibraryFolder): void => {
    setDestinationDir(library.path)
    setAdopt(library.hasGame)
    setDetect({ status: 'idle' })
  }

  const autoDetect = async (): Promise<void> => {
    setDetect({ status: 'looking' })
    try {
      const found = await window.netfuse.steamLibraryFolders(folderName)
      setLibraries(found)
      if (found.length === 0) setDetect({ status: 'none' })
      else if (found.length === 1) pickLibrary(found[0])
      else setDetect({ status: 'choose', libraries: found })
    } catch {
      setDetect({ status: 'none' })
    }
  }

  const inLibrary = libraries.find((library) => library.path === destinationDir)
  const branch = details.branches.find((entry) => entry.name === selection.branch)

  return (
    <>
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <Choice
            label="Branch"
            value={selection.branch}
            options={details.branches.map((entry) => ({
              value: entry.name,
              label: entry.description ? `${entry.name}: ${entry.description}` : entry.name,
              disabled: entry.passwordRequired,
              note: entry.passwordRequired ? 'Password-protected' : undefined
            }))}
            onChange={(name) => choose({ branch: name })}
          />
          <ToggleGroup
            value={[selection.os]}
            onValueChange={(values) => values.length > 0 && choose({ os: values[0] as SteamOs })}
            aria-label="System"
            variant="pill"
            size="xs"
            spacing={1}
          >
            {SYSTEMS.map((system) => (
              <ToggleGroupItem key={system.value} value={system.value} className="h-6 px-2">
                {system.label}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
          <ToggleGroup
            value={[selection.arch]}
            onValueChange={(values) =>
              values.length > 0 && choose({ arch: values[0] as SteamArch })
            }
            aria-label="Architecture"
            variant="pill"
            size="xs"
            spacing={1}
          >
            <ToggleGroupItem value="64" className="h-6 px-2">
              64-bit
            </ToggleGroupItem>
            <ToggleGroupItem value="32" className="h-6 px-2">
              32-bit
            </ToggleGroupItem>
          </ToggleGroup>
          {details.languages.length > 1 && (
            <Choice
              label="Language"
              value={selection.language}
              options={details.languages
                .map((language) => ({ value: language, label: languageName(language) }))
                .sort((a, b) => a.label.localeCompare(b.label))}
              onChange={(language) => choose({ language })}
            />
          )}
        </div>
        {branch?.updatedAt && (
          <div className="font-mono text-[11px] text-muted-foreground">
            Build {branch.buildId}, updated {new Date(branch.updatedAt * 1000).toLocaleDateString()}
          </div>
        )}

        <div
          role="group"
          aria-label="Depots"
          className="flex max-h-56 flex-col overflow-y-auto rounded-lg border-[0.5px] border-border"
        >
          {details.depots.map((depot) => (
            <DepotRow
              key={depot.depotId}
              depot={depot}
              branch={selection.branch}
              checked={chosen.includes(depot.depotId)}
              onChange={(on) =>
                setChosen((previous) =>
                  on ? [...previous, depot.depotId] : previous.filter((id) => id !== depot.depotId)
                )
              }
            />
          ))}
        </div>

        <div className="font-mono text-[11.5px] text-muted-foreground">
          {[
            `${picked.length} of ${details.depots.length} depots`,
            installBytes > 0 && `${formatBytes(installBytes)} installed`,
            downloadBytes > 0 && `${formatBytes(downloadBytes)} to download`,
            freeBytes !== null && `${formatBytes(freeBytes)} free`
          ]
            .filter(Boolean)
            .join(' · ')}
        </div>
        {tooBig && (
          <Problem message="There isn’t enough free space on this drive for this game. Choose another folder or free up space." />
        )}

        <div className="flex items-center gap-3">
          <div className={labelClass}>Save to</div>
          <div className="min-w-0 flex-1 truncate font-mono text-[12.5px]">
            {toDisplayPath(destinationDir, homeDir)}
          </div>
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  disabled={busy || detect.status === 'looking'}
                  onClick={() => void autoDetect()}
                >
                  {detect.status === 'looking' ? 'Looking' : 'Auto-detect'}
                </Button>
              }
            />
            <TooltipContent>
              Find the Steam library’s games folder (steamapps/common)
            </TooltipContent>
          </Tooltip>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            disabled={busy}
            onClick={async () => {
              const folder = await window.netfuse.chooseDestinationFolder(destinationDir)
              if (folder) {
                setDestinationDir(folder)
                setDetect({ status: 'idle' })
              }
            }}
          >
            Change
          </Button>
        </div>
        {detect.status === 'none' && (
          <div className="text-[12px] text-muted-foreground">
            NetFuse couldn’t find Steam on this computer. Choose the folder with Change.
          </div>
        )}
        {detect.status === 'choose' && (
          <div
            role="group"
            aria-label="Steam libraries"
            className="flex flex-col rounded-lg border-[0.5px] border-border"
          >
            {detect.libraries.map((library) => (
              <button
                key={library.path}
                type="button"
                onClick={() => pickLibrary(library)}
                className="flex cursor-default items-center gap-2 border-b-[0.5px] border-border px-3 py-2 text-left text-[12.5px] last:border-b-0 hover:bg-secondary"
              >
                <span className="min-w-0 flex-1 truncate font-mono">
                  {toDisplayPath(library.path, homeDir)}
                </span>
                {library.hasGame && (
                  <span className="text-[11px] text-[var(--text-secondary)]">Has this game</span>
                )}
                {library.freeBytes !== null && (
                  <span className="font-mono text-[11px] text-muted-foreground tabular-nums">
                    {formatBytes(library.freeBytes)} free
                  </span>
                )}
              </button>
            ))}
          </div>
        )}
        {inLibrary && (
          <div className="text-[12px] leading-snug text-muted-foreground">
            {inLibrary.hasGame && adopt
              ? `“${folderName}” is already in this Steam library: only what’s missing or different will be fetched. `
              : 'This is a Steam library. '}
            Steam lists the game once you click Install on it in Steam, which finds these files and
            checks them rather than downloading them again.
          </div>
        )}
        <label className="flex items-start gap-2 text-[12.5px]">
          <Checkbox
            checked={adopt}
            disabled={busy}
            onCheckedChange={(checked) => setAdopt(checked)}
            className="mt-0.5"
          />
          <span>
            Install over the existing “{folderName}” folder
            <span className="block text-muted-foreground">
              Files already there and correct are kept: only what’s missing or different is fetched.
              Nothing else in the folder is touched.
            </span>
          </span>
        </label>

        <div className="flex items-start gap-3">
          <div className={cn(labelClass, 'pt-1.5')} id="steam-networks">
            Networks
          </div>
          <div
            role="group"
            aria-labelledby="steam-networks"
            className="flex min-w-0 flex-1 flex-wrap gap-1.5"
          >
            {interfaces.map((iface) => {
              const visual = networkVisual(iface.id, iface.kind, iface.displayName)
              const selected = networkIds.includes(iface.id)
              const reached = isReached(iface.id)
              return (
                <button
                  key={iface.id}
                  type="button"
                  aria-pressed={selected}
                  aria-disabled={reached || undefined}
                  title={reached ? 'Data limit reached' : undefined}
                  onClick={() => toggleNetwork(iface.id)}
                  className={cn(
                    'flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-[12.5px] transition-colors',
                    selected
                      ? 'border-transparent'
                      : 'border-border text-[var(--text-secondary)] opacity-70',
                    reached && 'cursor-not-allowed line-through opacity-50'
                  )}
                  style={
                    selected ? { background: visual.bg, borderColor: visual.border } : undefined
                  }
                >
                  <span className="size-2 rounded-full" style={{ background: visual.solid }} />
                  {visual.name}
                </button>
              )
            })}
          </div>
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
  if (!progress) return 'Asking Steam for the game’s file lists…'
  if (progress.step === 'manifests') {
    return `Fetching file lists: ${progress.done} of ${progress.total} depots`
  }
  return `Checking the files already there: ${Math.floor((progress.done / Math.max(1, progress.total)) * 100)}%`
}

function DepotRow({
  depot,
  branch,
  checked,
  onChange
}: {
  depot: SteamDepot
  branch: string
  checked: boolean
  onChange: (on: boolean) => void
}): React.JSX.Element {
  const unavailable = depotUnavailable(depot, branch)
  const manifest = manifestFor(depot, branch)
  const labels = [
    depot.dlcAppId !== undefined && 'DLC',
    depot.language && languageName(depot.language),
    depot.oslist.length > 0 &&
      depot.oslist.map((os) => SYSTEMS.find((s) => s.value === os)?.label).join(', '),
    depot.osarch && `${depot.osarch}-bit`,
    depot.lowViolence && 'Low violence',
    (depot.sharedInstall || depot.sharedFrom !== undefined) && 'Shared'
  ].filter(Boolean)
  return (
    <label
      className={cn(
        'flex items-center gap-2.5 border-b-[0.5px] border-border px-3 py-2 text-[12.5px] last:border-b-0',
        unavailable && 'opacity-60'
      )}
    >
      <Checkbox
        checked={checked && !unavailable}
        disabled={unavailable !== null}
        onCheckedChange={(on) => onChange(on)}
      />
      <span className="min-w-0 flex-1">
        <span className="block truncate">{depot.name}</span>
        <span className="block font-mono text-[10.5px] text-muted-foreground">
          {[`Depot ${depot.depotId}`, ...labels, unavailable].filter(Boolean).join(' · ')}
        </span>
      </span>
      {depot.borrowed && <FamilySharing />}
      {manifest?.size !== undefined && (
        <span className="font-mono text-[11px] text-muted-foreground tabular-nums">
          {formatBytes(manifest.size)}
        </span>
      )}
    </label>
  )
}

function Choice({
  label,
  value,
  options,
  onChange
}: {
  label: string
  value: string
  options: { value: string; label: string; disabled?: boolean; note?: string }[]
  onChange: (value: string) => void
}): React.JSX.Element {
  const current = options.find((option) => option.value === value)
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button type="button" variant="secondary" size="sm" aria-label={label}>
            <span className="text-[var(--text-secondary)]">{label}:</span>
            <span className="max-w-40 truncate">{current?.label ?? value}</span>
            <ChevronDown data-icon="inline-end" />
          </Button>
        }
      />
      <DropdownMenuContent className="min-w-48">
        <DropdownMenuRadioGroup value={value} onValueChange={(next) => onChange(String(next))}>
          {options.map((option) => (
            <DropdownMenuRadioItem
              key={option.value}
              value={option.value}
              disabled={option.disabled}
            >
              <span className="flex-1">{option.label}</span>
              {option.note && (
                <span className="text-[11px] text-muted-foreground">{option.note}</span>
              )}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function Problem({ message }: { message: string }): React.JSX.Element {
  return (
    <div role="alert" className="flex items-start gap-2 text-[12.5px] text-[var(--color-danger)]">
      <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
      {message}
    </div>
  )
}
