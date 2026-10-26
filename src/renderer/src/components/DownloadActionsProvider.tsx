import { useCallback, useMemo, useState } from 'react'
import { useAppStore } from '../store/useAppStore'
import { describeError } from '../utils/format'
import type { ActionId, DownloadItem } from '../utils/downloadActions'
import { ActionErrorDialog } from './ActionErrorDialog'
import { ACTION_META } from './downloadActionMeta'
import { ActionsContext, StateContext } from './downloadActionsContext'
import { RemoveDialog, type RemoveMode } from './RemoveDialog'

/** What can be done to a download, done: from its row, its menu, the selection toolbar and its
 * own screen alike. It owns the question an action can lead to (confirm a removal), so it looks
 * and behaves the same wherever it's asked from. */
export function DownloadActionsProvider({
  children
}: {
  children: React.ReactNode
}): React.JSX.Element {
  const setView = useAppStore((store) => store.setView)
  const openGame = useAppStore((store) => store.openGame)
  const [confirmation, setConfirmation] = useState<{
    mode: RemoveMode
    items: DownloadItem[]
    clearAll: boolean
  } | null>(null)
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<{ title: string; message: string } | null>(null)
  const [dialogError, setDialogError] = useState<string | null>(null)

  const perform = useCallback(
    async (id: ActionId, targets: DownloadItem[]): Promise<boolean> => {
      // Said in a dialog, whichever screen it came from.
      const fail = (cause: unknown): false => {
        setFailure({ title: ACTION_META[id].failure, message: describeError(cause) })
        return false
      }
      switch (id) {
        case 'pause':
        case 'resume':
        case 'retry': {
          const results = await Promise.allSettled(
            targets.map((item) =>
              id === 'pause'
                ? window.netfuse.pauseDownload(item.id)
                : window.netfuse.resumeDownload(item.id)
            )
          )
          const failed = results.find((result) => result.status === 'rejected')
          return failed ? fail(failed.reason) : true
        }
        case 'again': {
          // Nothing of it can be kept: it goes, and the game's page opens to start over. Only once
          // it's really gone, so the new one can't collide with what's left of it.
          const [item] = targets
          try {
            await window.netfuse.removeDownload(item.id)
          } catch (cause) {
            return fail(cause)
          }
          useAppStore.getState().forgetDownload(item.id)
          openGame(item.app.appId)
          return true
        }
        case 'open':
        case 'reveal': {
          try {
            const [item] = targets
            const found =
              id === 'open'
                ? await window.netfuse.openDownload(item.id)
                : await window.netfuse.revealDownload(item.id)
            return found || fail('That game is no longer where it was installed.')
          } catch (cause) {
            return fail(cause)
          }
        }
        case 'cancel':
        case 'remove':
        case 'trash':
          setDialogError(null)
          setConfirmation({
            mode: id === 'cancel' ? 'cancel' : id === 'trash' ? 'trash' : 'remove',
            items: targets,
            clearAll: false
          })
          return true
      }
    },
    [openGame]
  )

  const askClearFinished = useCallback((): void => {
    setDialogError(null)
    setConfirmation({ mode: 'remove', items: useAppStore.getState().history, clearAll: true })
  }, [])

  const confirmRemoval = async (): Promise<void> => {
    if (!confirmation || busy) return
    const { mode, items, clearAll } = confirmation
    setBusy(true)
    setDialogError(null)
    try {
      // One failing doesn't hold back the rest: each that goes is dropped from the window and
      // from the question, so what's left asked about is exactly what still needs doing.
      const gone = new Set<string>()
      let firstFailure: unknown
      if (clearAll) {
        await window.netfuse.clearHistory()
      } else {
        for (const item of items) {
          try {
            await window.netfuse.removeDownload(item.id, { trashFile: mode === 'trash' })
            useAppStore.getState().forgetDownload(item.id)
            gone.add(item.id)
          } catch (cause) {
            firstFailure ??= cause
          }
        }
      }
      // Showing one that's gone: back to the list.
      const view = useAppStore.getState().view
      if (view.name === 'download' && (clearAll || gone.has(view.id))) {
        setView({ name: 'downloads' })
      }
      const left = items.filter((item) => !gone.has(item.id))
      if (!clearAll && left.length > 0) {
        setConfirmation({ mode, items: left, clearAll })
        setDialogError(
          `${left.length} of ${items.length} couldn’t be removed: ${describeError(firstFailure)}`
        )
      } else setConfirmation(null)
    } catch (cause) {
      setDialogError(describeError(cause))
    } finally {
      setBusy(false)
    }
  }

  const actions = useMemo(() => ({ perform, askClearFinished }), [perform, askClearFinished])
  const state = useMemo(() => ({ busy }), [busy])

  return (
    <ActionsContext.Provider value={actions}>
      <StateContext.Provider value={state}>
        {children}
        <RemoveDialog
          open={confirmation !== null}
          onOpenChange={(open) => !open && !busy && setConfirmation(null)}
          mode={confirmation?.mode ?? 'remove'}
          items={confirmation?.items ?? []}
          clearAll={confirmation?.clearAll}
          busy={busy}
          error={dialogError}
          onConfirm={() => void confirmRemoval()}
        />
        <ActionErrorDialog failure={failure} onClose={() => setFailure(null)} />
      </StateContext.Provider>
    </ActionsContext.Provider>
  )
}
