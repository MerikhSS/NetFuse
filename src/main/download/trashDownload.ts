import { shell } from 'electron'
import type { DownloadState, FinishedDownload } from '../../shared/types'

/** A game goes to the Trash whole, as uninstalling would take it, saves and all — unless it was
 * installed into a folder that was there before, which is never trashed. */
export async function trashDownload(download: DownloadState | FinishedDownload): Promise<void> {
  if (download.adopted) {
    throw new Error(
      'This game was installed into a folder that was already there, so NetFuse won’t move it to the Trash. Remove it from the list, then manage the folder in your file browser.'
    )
  }
  await shell.trashItem(download.destinationPath)
}
