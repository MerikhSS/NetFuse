import type { DownloadState, FinishedDownload } from '@shared/types'
import { DownloadActionsProvider } from './components/DownloadActionsProvider'
import { NetworkBindingDialog } from './components/NetworkBindingDialog'
import { Sidebar } from './components/Sidebar'
import { StatusBar } from './components/StatusBar'
import { TitleBar } from './components/TitleBar'
import { TooltipProvider } from './components/ui/tooltip'
import { useDownloadEvents } from './hooks/useDownloadEvents'
import { useNetworkEvents } from './hooks/useNetworks'
import { useSteamEvents } from './hooks/useSteamEvents'
import { CompleteScreen } from './screens/CompleteScreen'
import { DownloadingScreen } from './screens/DownloadingScreen'
import { DownloadsScreen } from './screens/DownloadsScreen'
import { ErrorScreen } from './screens/ErrorScreen'
import { GameScreen } from './screens/GameScreen'
import { LibraryScreen } from './screens/LibraryScreen'
import { LoginScreen } from './screens/LoginScreen'
import { useAppStore } from './store/useAppStore'

function assertNever(status: never): never {
  throw new Error(`Unhandled download status: ${String(status)}`)
}

/** One screen per download.status — a switch with an assertNever default so a new
 * DownloadStatus value is a compile error here instead of silently falling into whichever branch
 * happened to be last. */
function renderDownload(download: DownloadState | FinishedDownload): React.JSX.Element {
  if ('unitsWritten' in download) return <CompleteScreen download={download} />
  switch (download.status) {
    case 'queued':
    case 'downloading':
    case 'paused':
      return <DownloadingScreen download={download} />
    case 'completed':
      return <CompleteScreen download={download} />
    case 'error':
    case 'cancelled':
      return <ErrorScreen download={download} />
    default:
      return assertNever(download.status)
  }
}

/** One download's screen. Only this re-renders on its progress updates: the shell around it, and
 * every other screen, don't. */
function DownloadView({ id }: { id: string }): React.JSX.Element {
  // Just the one shown: an update to any other download leaves this selector's result alone.
  const shown = useAppStore(
    (store) => store.downloads[id] ?? store.history.find((entry) => entry.id === id) ?? null
  )
  const cancelled = shown && !('unitsWritten' in shown) && shown.status === 'cancelled'
  // A download that's gone (removed, deleted) leaves the list showing.
  return shown && !cancelled ? renderDownload(shown) : <DownloadsScreen />
}

function CurrentScreen(): React.JSX.Element {
  const view = useAppStore((store) => store.view)
  switch (view.name) {
    case 'library':
      return <LibraryScreen />
    case 'game':
      return <GameScreen key={view.appId} appId={view.appId} />
    case 'downloads':
      return <DownloadsScreen />
    case 'download':
      return <DownloadView id={view.id} />
  }
}

/** Logged in: a launcher's library, a game, or the downloads, with the way between them. */
function Shell(): React.JSX.Element {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex min-h-0 flex-1">
        <Sidebar />
        <main className="min-w-0 flex-1">
          <CurrentScreen />
        </main>
      </div>
      <StatusBar />
    </div>
  )
}

function App(): React.JSX.Element {
  useDownloadEvents()
  useNetworkEvents()
  useSteamEvents()
  const login = useAppStore((store) => store.steamLogin)

  return (
    <TooltipProvider>
      <DownloadActionsProvider>
        <div className="flex h-full flex-col">
          <TitleBar />
          {/* Nothing until main has said whether a login is remembered: the login form would
              otherwise flash up for someone who stays logged in. */}
          {login?.status === 'logged-in' ? (
            <Shell />
          ) : (
            login && (
              <div className="min-h-0 flex-1">
                <LoginScreen state={login} />
              </div>
            )
          )}
          <NetworkBindingDialog />
        </div>
      </DownloadActionsProvider>
    </TooltipProvider>
  )
}

export default App
