import { expect, test } from '@playwright/test'
import type { DownloadState, FinishedDownload } from '../src/shared/types'
import {
  availableActions,
  failureAction,
  headerActions,
  manageAction,
  manageActions,
  rowAction,
  splitToolbar,
  type ActionId,
  type DownloadItem
} from '../src/renderer/src/utils/downloadActions'

function download(
  patch: Partial<DownloadState> & { status: DownloadState['status'] }
): DownloadItem {
  return {
    id: 'a',
    kind: 'steam',
    url: 'steam://app/480',
    fileName: 'Spacewar',
    bytesDownloaded: 100,
    totalBytes: 1000,
    ...patch
  } as unknown as DownloadItem
}

function finished(patch: Partial<FinishedDownload> = {}): DownloadItem {
  return {
    ...(download({ status: 'completed' }) as object),
    unitsWritten: 4,
    ...patch
  } as unknown as DownloadItem
}

const ids = (items: DownloadItem[]): ActionId[] =>
  availableActions(items).flatMap((group) => group.map((action) => action.id))

test.describe('what each state offers', () => {
  test('downloading and queued', () => {
    for (const status of ['downloading', 'queued'] as const)
      expect(ids([download({ status })])).toEqual(['pause', 'reveal', 'cancel'])
  })

  test('paused', () => {
    expect(ids([download({ status: 'paused' })])).toEqual(['resume', 'reveal', 'cancel'])
  })

  test('failed with its install kept can be retried, even with nothing fetched yet', () => {
    expect(ids([download({ status: 'error', error: 'reset' })])).toEqual(['retry', 'remove'])
    // Waiting on a login, with nothing fetched yet: it goes on rather than starting over.
    const waited = download({ status: 'error', bytesDownloaded: 0 })
    expect(failureAction(waited as DownloadState)).toBe('retry')
  })

  test('failed with nothing to resume starts over', () => {
    const item = download({ status: 'error', error: 'reset', resumable: false })
    expect(failureAction(item as DownloadState)).toBe('again')
    expect(ids([item])).toEqual(['again', 'remove'])
  })

  test('completed', () => {
    expect(ids([download({ status: 'completed' })])).toEqual(['open', 'reveal', 'remove', 'trash'])
    expect(ids([finished()])).toEqual(['open', 'reveal', 'remove', 'trash'])
  })

  test('completed but moved: nothing that needs the install', () => {
    expect(ids([finished({ missing: true })])).toEqual(['remove'])
  })

  test('installed into a folder that was already there: never trashed', () => {
    expect(ids([download({ status: 'completed', adopted: true })])).toEqual([
      'open',
      'reveal',
      'remove'
    ])
  })
})

test.describe('several selected', () => {
  test('an action acts on just the ones it is valid for', () => {
    const items = [
      download({ id: 'a', status: 'downloading' }),
      download({ id: 'b', status: 'paused' }),
      download({ id: 'c', status: 'queued' }),
      finished({ id: 'd' })
    ]
    const found = Object.fromEntries(
      availableActions(items)
        .flat()
        .map((action) => [action.id, action.targets.map((target) => target.id)])
    )
    expect(found.pause).toEqual(['a', 'c'])
    expect(found.resume).toEqual(['b'])
    expect(found.cancel).toEqual(['a', 'b', 'c'])
    expect(found.remove).toEqual(['d'])
  })

  test('single-download actions are not offered for several', () => {
    const items = [finished({ id: 'a' }), finished({ id: 'b' })]
    expect(ids(items)).toEqual(['remove', 'trash'])
    const failed = [
      download({ id: 'a', status: 'error', error: 'reset', resumable: false }),
      download({ id: 'b', status: 'error', error: 'reset', resumable: false })
    ]
    expect(ids(failed)).toEqual(['remove'])
  })
})

test.describe('the places that show them agree', () => {
  test('a row button, a screen header and the menu start from the same list', () => {
    const states = [
      download({ status: 'downloading' }),
      download({ status: 'paused' }),
      download({ status: 'error', error: 'reset' }),
      download({ status: 'error', error: 'reset', resumable: false }),
      finished()
    ]
    for (const item of states) {
      const menu = ids([item])
      const row = rowAction(item)
      if (row) expect(menu).toContain(row)
      for (const id of headerActions(item)) expect(menu).toContain(id)
      const manage = manageAction(item)
      if (manage) expect(menu).toContain(manage)
      // The first thing a menu offers is what its row button does.
      if (row) expect(menu[0]).toBe(row)
    }
  })

  test('a finished download can be removed or have its install trashed, from its own screen too', () => {
    expect(manageActions(finished())).toEqual(['remove', 'trash'])
    expect(manageActions(finished({ missing: true }))).toEqual(['remove'])
    expect(manageActions(download({ status: 'paused' }))).toEqual(['cancel'])
    expect(manageActions(download({ status: 'error', error: 'x' }))).toEqual(['remove'])
  })

  test('a download that is going can be cancelled, one that is over can be removed', () => {
    expect(manageAction(download({ status: 'paused' }))).toBe('cancel')
    expect(manageAction(download({ status: 'error', error: 'x' }))).toBe('remove')
    expect(manageAction(finished())).toBe('remove')
  })
})

test.describe('the selection toolbar', () => {
  const shown = (items: DownloadItem[]): { buttons: ActionId[]; more: ActionId[] } => {
    const { buttons, more } = splitToolbar(availableActions(items))
    return { buttons: buttons.map((a) => a.id), more: more.flat().map((a) => a.id) }
  }

  test('two buttons for every state, the rest behind More', () => {
    expect(shown([download({ status: 'downloading' })])).toEqual({
      buttons: ['pause', 'cancel'],
      more: ['reveal']
    })
    expect(shown([download({ status: 'paused' })])).toEqual({
      buttons: ['resume', 'cancel'],
      more: ['reveal']
    })
    expect(shown([download({ status: 'error', error: 'reset' })])).toEqual({
      buttons: ['retry', 'remove'],
      more: []
    })
    expect(
      shown([download({ status: 'error', error: 'reset', resumable: false })]).buttons
    ).toEqual(['again', 'remove'])
    expect(shown([finished()])).toEqual({
      buttons: ['open', 'reveal'],
      more: ['remove', 'trash']
    })
  })

  test('several finished: remove and trash', () => {
    expect(shown([finished({ id: 'a' }), finished({ id: 'b' })])).toEqual({
      buttons: ['remove', 'trash'],
      more: []
    })
  })

  test('a mixed selection still gets two, and nothing is lost', () => {
    const items = [
      download({ id: 'a', status: 'downloading' }),
      download({ id: 'b', status: 'paused' }),
      finished({ id: 'c' })
    ]
    const { buttons, more } = shown(items)
    expect(buttons).toHaveLength(2)
    expect([...buttons, ...more].sort()).toEqual([...ids(items)].sort())
  })
})
