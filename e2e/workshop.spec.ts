import { expect, test } from '@playwright/test'
import { hasWorkshop, readAppInfo } from '../src/main/steam/appInfo'
import {
  isPublishedFileId,
  readWorkshopItem,
  WORKSHOP_PAGE_SIZE,
  workshopManifest,
  workshopPreview,
  workshopQuery
} from '../src/main/steam/workshop'

// What NetFuse makes of a game's Steam Workshop: the queries it sends, and the items it lists,
// checked, from details that come off the network. The tab and downloads are in
// steamWorkshop.spec.ts.

/** An item as PublishedFile.QueryFiles sends one, 64-bit numbers as strings. */
const ITEM = {
  result: 1,
  publishedfileid: '2863190123456789',
  consumer_appid: 281990,
  title: 'Gigastructural Engineering',
  short_description: 'Build [b]huge[/b] things,\n   across the galaxy.',
  file_size: '123456789',
  hcontent_file: '8126478954123456789',
  preview_url: 'https://images.steamusercontent.com/ugc/123/ABC/',
  time_updated: 1790000000,
  subscriptions: 900000,
  tags: [{ tag: 'Gameplay', display_name: 'Gameplay' }, { tag: 'Gameplay' }, { tag: 'Ships' }]
}

test('each order asks Steam for its own ranking, and a search for the best matches', () => {
  expect(workshopQuery({ appId: 281990, sort: 'popular' })).toEqual({
    appId: 281990,
    queryType: 3,
    days: 7,
    cursor: '*',
    perPage: WORKSHOP_PAGE_SIZE
  })
  expect(workshopQuery({ appId: 281990, sort: 'subscribed' }).queryType).toBe(9)
  expect(workshopQuery({ appId: 281990, sort: 'recent' }).queryType).toBe(1)
  expect(workshopQuery({ appId: 281990, sort: 'updated', cursor: 'AoJ4' })).toMatchObject({
    queryType: 21,
    cursor: 'AoJ4'
  })
  const search = workshopQuery({ appId: 281990, sort: 'recent', search: '  ships  ' })
  expect(search).toMatchObject({ queryType: 12, searchText: 'ships' })
  expect(search.days).toBeUndefined()
  expect(
    workshopQuery({ appId: 1, sort: 'popular', search: 'x'.repeat(500) }).searchText
  ).toHaveLength(100)
})

test('a query the window shouldn’t send is refused', () => {
  for (const query of [
    { appId: 0, sort: 'popular' },
    { appId: 1.5, sort: 'popular' },
    { appId: 1, sort: 'toString' },
    { appId: 1, sort: 'newest' }
  ]) {
    expect(() => workshopQuery(query as never)).toThrow('Choose what to list again.')
  }
})

test('a published file id is a 64-bit number, never 0', () => {
  expect(isPublishedFileId('2863190123456789')).toBe(true)
  expect(isPublishedFileId('18446744073709551615')).toBe(true)
  expect(isPublishedFileId('18446744073709551616')).toBe(false)
  for (const value of ['0', '0123', '-1', '1e5', '', ' 12', 12, null]) {
    expect(isPublishedFileId(value)).toBe(false)
  }
})

test('an item is read as the tab lists it: plain text, numbers, and whether it can be fetched', () => {
  expect(readWorkshopItem(ITEM, 281990)).toEqual({
    publishedFileId: '2863190123456789',
    appId: 281990,
    title: 'Gigastructural Engineering',
    description: 'Build huge things, across the galaxy.',
    size: 123456789,
    updatedAt: 1790000000,
    subscriptions: 900000,
    tags: ['Gameplay', 'Ships'],
    downloadable: true
  })
  expect(workshopManifest(ITEM)).toBe('8126478954123456789')
  // In Steam's old storage: listed, but not fetched.
  const legacy = { ...ITEM, hcontent_file: '0', file_url: 'https://cloud-3.steamusercontent.com/x' }
  expect(readWorkshopItem(legacy, 281990)?.downloadable).toBe(false)
  expect(workshopManifest(legacy)).toBeUndefined()
  // A long description is cut short, and an untitled item is named by its id.
  const long = readWorkshopItem({ ...ITEM, title: '', short_description: 'a '.repeat(400) }, 281990)
  expect(long?.title).toBe('Workshop item 2863190123456789')
  expect(long?.description.length).toBeLessThanOrEqual(400)
  expect(long?.description.endsWith('…')).toBe(true)
})

test('an item that isn’t a good one of this game’s Workshop is left out', () => {
  expect(readWorkshopItem(ITEM, 999)).toBeNull()
  expect(readWorkshopItem({ ...ITEM, banned: true }, 281990)).toBeNull()
  expect(readWorkshopItem({ ...ITEM, result: 9 }, 281990)).toBeNull()
  expect(readWorkshopItem({ ...ITEM, publishedfileid: '0' }, 281990)).toBeNull()
  for (const value of [null, 'item', 42, [], { publishedfileid: { evil: true } }]) {
    expect(readWorkshopItem(value, 281990)).toBeNull()
  }
  // Odd values in an item otherwise fine are dropped, not passed on.
  const odd = readWorkshopItem(
    { ...ITEM, file_size: -5, subscriptions: 'many', tags: 'Ships', time_updated: 1.5 },
    281990
  )
  expect(odd).toMatchObject({ size: 0, subscriptions: 0, tags: [], updatedAt: 0 })
})

test('a picture is fetched only from Steam’s Workshop image servers', () => {
  expect(workshopPreview(ITEM)).toBe('https://images.steamusercontent.com/ugc/123/ABC/')
  expect(workshopPreview({ preview_url: 'https://steamuserimages-a.akamaihd.net/ugc/1/A/' })).toBe(
    'https://steamuserimages-a.akamaihd.net/ugc/1/A/'
  )
  for (const url of [
    'http://images.steamusercontent.com/ugc/1/',
    'https://evil.example/ugc/1/',
    'https://images.steamusercontent.com.evil.example/ugc/1/',
    'https://user:pass@images.steamusercontent.com/ugc/1/',
    'https://images.steamusercontent.com:8443/ugc/1/',
    'javascript:alert(1)',
    'not a url'
  ]) {
    expect(workshopPreview({ preview_url: url })).toBeUndefined()
  }
  // The end-to-end tests' stand-in for Steam, only when it is the one named.
  const test = 'http://127.0.0.1:4567'
  expect(workshopPreview({ preview_url: `${test}/ugc/1.png` }, test)).toBe(`${test}/ugc/1.png`)
  expect(workshopPreview({ preview_url: `${test}/ugc/1.png` })).toBeUndefined()
})

test('a game’s Workshop and the depot its items are in come from its appinfo', () => {
  expect(hasWorkshop({ common: { workshop_visible: '1' } })).toBe(true)
  expect(hasWorkshop({ common: {} })).toBe(false)
  expect(hasWorkshop('nonsense')).toBe(false)
  // Most keep the items in a depot numbered as the game; some name another.
  expect(readAppInfo(281990, { common: { name: 'Stellaris' }, depots: {} }).workshopDepot).toBe(
    281990
  )
  expect(
    readAppInfo(281990, { common: { name: 'Stellaris' }, depots: { workshopdepot: '281991' } })
      .workshopDepot
  ).toBe(281991)
  expect(
    readAppInfo(281990, { common: { name: 'Stellaris' }, depots: { workshopdepot: 'x' } })
      .workshopDepot
  ).toBe(281990)
})
