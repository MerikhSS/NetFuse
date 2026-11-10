import { net } from 'electron'
import { testSteamFake } from '../testKnobs'
import { readStoreSearch, storeSearchParams } from './workshop'

// Steam's store, asked which games have a Steam Workshop: for the Workshop tab's games beyond the
// account's own (see library.ts). Like the store's pictures, it needs no login and is sent nothing
// about the account: only the words searched for, if any.

const STORE = 'https://store.steampowered.com'
const FETCH_TIMEOUT_MS = 20_000
/** An answer of 50 games is tens of kilobytes. */
const MAX_BYTES = 2 * 1024 * 1024

/** A page of the games on Steam's store with a Workshop, from `start`: the most popular first, or
 * those whose names match `search`. */
export async function searchStore(
  search: string,
  start: number
): Promise<{ appId: number; name: string }[]> {
  const fake = testSteamFake()
  const url = `${fake ? `${fake}/store` : STORE}/search/results/?${storeSearchParams(search, start)}`
  const response = await net.fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
  if (!response.ok) throw new Error('Steam’s store didn’t answer. Try again in a moment.')
  const text = await response.text()
  if (text.length > MAX_BYTES) throw new Error('Steam’s store sent something unexpected.')
  try {
    return readStoreSearch(JSON.parse(text))
  } catch {
    throw new Error('Steam’s store sent something unexpected.')
  }
}
