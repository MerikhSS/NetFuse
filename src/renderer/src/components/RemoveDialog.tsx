import { isDone, isFailed, type DownloadItem } from '../utils/downloadActions'
import { TRASH_NAME } from './downloadActionMeta'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle
} from './ui/alert-dialog'
import { buttonVariants } from './ui/button'

/** What the dialog asks about: `remove` takes downloads off the list (their files stay), `cancel`
 * stops unfinished ones, `trash` moves their files to the Trash. */
export type RemoveMode = 'remove' | 'cancel' | 'trash'

/** The one confirmation for taking downloads away, wherever it's asked from: a download's own
 * screen, the list's toolbar and menu, and clearing the finished list. */
export function RemoveDialog({
  open,
  onOpenChange,
  mode,
  items,
  clearAll = false,
  busy = false,
  error = null,
  onConfirm
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  mode: RemoveMode
  items: DownloadItem[]
  /** Clearing the whole finished list: no per-file choices. */
  clearAll?: boolean
  busy?: boolean
  error?: string | null
  onConfirm: () => void
}): React.JSX.Element {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <RemoveDialogBody
          mode={mode}
          items={items}
          clearAll={clearAll}
          busy={busy}
          error={error}
          onConfirm={onConfirm}
        />
      </AlertDialogContent>
    </AlertDialog>
  )
}

function RemoveDialogBody({
  mode,
  items,
  clearAll,
  busy,
  error,
  onConfirm
}: {
  mode: RemoveMode
  items: DownloadItem[]
  clearAll: boolean
  busy: boolean
  error: string | null
  onConfirm: () => void
}): React.JSX.Element {
  const count = items.length
  const one = count === 1
  const anyFailed = items.some(isFailed)
  const anyFinished = items.some(isDone)

  let title: string
  let description: string
  let confirm: string
  let dismiss = 'Cancel'
  let destructive = true
  if (mode === 'cancel') {
    title = one ? 'Cancel download?' : `Cancel ${count} downloads?`
    description = 'What it installed so far will be deleted. Anything else in its folder stays.'
    confirm = one ? 'Cancel download' : 'Cancel downloads'
    dismiss = 'Keep'
  } else if (mode === 'trash') {
    // Said as what it comes to: a game goes as uninstalling it would, its whole folder into the
    // Trash, saves and all.
    title = one ? 'Delete game?' : `Delete ${count} games?`
    description = `The install ${one ? 'folder' : 'folders'} will be moved to the ${TRASH_NAME}, with anything the game saved there.`
    confirm = one ? 'Delete game' : 'Delete games'
  } else {
    title = clearAll
      ? 'Clear finished list?'
      : one
        ? 'Remove from list?'
        : `Remove ${count} downloads from list?`
    description = !anyFailed
      ? `The installed ${one && !clearAll ? 'game stays' : 'games stay'} on your computer.`
      : anyFinished
        ? 'Finished games stay installed. Failed downloads lose what they installed so far.'
        : 'What it installed so far will be deleted. Anything else in its folder stays.'
    confirm = clearAll ? 'Clear list' : 'Remove'
    // Only the list changes, unless a failed one's partial data goes with it.
    destructive = anyFailed
  }

  return (
    <>
      <AlertDialogHeader>
        <AlertDialogTitle>{title}</AlertDialogTitle>
        <AlertDialogDescription>{description}</AlertDialogDescription>
      </AlertDialogHeader>
      <AlertDialogFooter>
        {error && (
          <p role="alert" className="text-[13px] text-destructive">
            {error}
          </p>
        )}
        <AlertDialogCancel disabled={busy}>{dismiss}</AlertDialogCancel>
        <AlertDialogAction
          disabled={busy || count === 0}
          className={buttonVariants({
            variant: destructive ? 'destructive' : 'default',
            size: 'sm'
          })}
          onClick={(event) => {
            // Stays open until the removal is done, and open if it fails.
            event.preventDefault()
            onConfirm()
          }}
        >
          {confirm}
        </AlertDialogAction>
      </AlertDialogFooter>
    </>
  )
}
