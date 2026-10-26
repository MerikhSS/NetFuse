# Steam downloads: design

## NetFuse

NetFuse downloads Steam games and, later, those of other game launchers. This design was first planned beside HTTP and torrent transfers:

- **Only Steam downloads are built.** Multi-network pinning, speed and data limits, the queue and schedule, retries and stall handling, and the progress grid serve them. Where the sections below describe HTTP or torrent behaviour, that code doesn't exist.
- **The window opens on the Steam login** and shows nothing else until there is one. Logged in, a sidebar leads to the library and the downloads (see "The window" below, which replaces the Steam dialog this design first planned).
- **Saved downloads** are format version 1, under NetFuse's own app ID and user data folder.
- **A download stopped only for want of a login goes on by itself** once Steam is logged in.

## Context

NetFuse speeds up one download by spreading its chunks across several networks: Wi-Fi, Ethernet, a tethered phone. Its download kind is **Steam**. The depot chunks of a game the account owns are fetched over every selected network in parallel. Each request uses NetFuse's own pinned connections and is counted through `Limits`. Each chunk is decrypted, decompressed and checked against the manifest before anything is written.

Status: Phases 1 to 3 are built: the protocol layer, the download itself, and the Steam dialog, tested end to end against a fake Steam (`e2e/steamOrigin.ts`). Nothing has been run against real Steam yet (see "Risks, and what needs a real Steam account"). This document describes what was built; where the first draft differed after review, the corrections are listed under "Changes after review" and the sections below say what is done now. Each phase ends with lint, typecheck, format:check, smoke tests, a commit and a report.

**Decisions made with the maintainer:**

| Topic          | Decision                                                                                                                                                                                                   |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Branch         | Everything goes on `feature/steam-downloads`, created from `main` (`2ffd681`) and pushed with `git push -u origin feature/steam-downloads`. Nothing is pushed to `main` or to the session's preset branch. |
| Phase 4        | Deferred. Folder installs only; `DESIGN.md` records why, with a design sketch.                                                                                                                             |
| UI             | A separate Steam dialog.                                                                                                                                                                                   |
| Family Sharing | Borrowed licenses are included, labelled "Family Sharing", and downloaded only when Steam itself grants the depot key.                                                                                     |

## Changes after review

An independent review of the first draft, and building it, changed these points:

1. **No "durable set".** `persistNow` already snapshots a download's progress _before_ it calls `file.sync()`, so a chunk done during the sync is saved at the next checkpoint, never ahead of its data. Steam does the same: a chunk is done once every one of its writes has resolved, and `SteamDestination.sync()` flushes the files written since the last sync (by file index, so a handle closed meanwhile is still flushed), putting them back if the sync fails. A Steam download saved with a resumable error is synced too.
2. **Saved progress is one byte per chunk:** 0 for not done, otherwise 1 + the index of the network that delivered it in a saved list of network ids. Restore can credit each network exactly. It is base64 in a `steam` field of `manifest.json`.
3. **An existing folder is checked while planning** (`steamPrepare`), not during the run. The plan holds only the chunks still needed, so a running download's cells never change. A plan with nothing to fetch is refused ("Everything in this folder is already up to date."). `start()` checks again that the files that were checked have the same size and modification time.
4. **Only one phase, `preparing`.** Each run starts by making sure of the install's folders, files (at full size, sparse), symlinks and executable bits (`SteamTransfer.checkFiles`). A file that is missing or the wrong size has its chunks marked not done, so they are fetched again; this needs no login. Only then does the run ask Steam for the depot keys and content servers. `publish()` refuses if a file with content has gone missing since, rather than make it empty.
5. **Restore.** A Steam download restores as `completed` only when its recorded publication matches, which is set after the final sync. A crash before that restores it paused at 100 %, and the next run checks its files and publishes it. Its layout is worked out again from the manifests it saved (`steam-manifests.json.gz`), with every path checked again.
6. **Deletion safety.** `SteamDestination.discard()` removes only the layout's own files (each checked with `lstat` through `ownedFiles`, never followed through a link), then the folders that leaves empty, deepest first.
7. **Starting.** The Steam branch of `start()` comes before the destination folder is made: it takes the plan out of the planner (so a second click can't start it twice), checks the folder names and free space, saves the manifests, and claims the install folder last. A failure removes the download's own folder again.
8. **What is saved** is `SteamRequestPayload`, never the plan id. The state carries `url: 'steam://app/<appId>'` and `adopted`.
9. **IPC.** The handlers check every Steam argument at runtime, and pass every error through `redact()`.
10. **The worker** is built with `?modulePath`; the main process reads the bundled file and starts `new Worker(source, { eval: true })`, which works inside the app archive. If no worker starts, chunks are checked on the main thread.
11. **Phase order.** The IPC the e2e specs need moved into Phase 2.

## Findings that change the brief

1. **The pure-JS LZMA decoder is too slow.** `steam-user` decompresses VZip chunks with the `lzma` package. Benchmarked in memory here, it decodes **2.5 MB/s**. Native `xz` does 51 MB/s on the same data. Most existing depots are LZMA, so this would cap a Steam download below what one network delivers. **Decision:** write our own typed-array LZMA1 decoder (`steam/lzma.ts`), use the `lzma` package as the test oracle, and run decoding in a `worker_threads` pool.
   - Fallback, only if our decoder turns out under about 15 MB/s per core: `@napi-rs/lzma`. It is N-API with prebuilt binaries and no install script. It does complicate the cross-arch mac and Windows packaging. The maintainer decides before it is added.
2. **`lzma`'s `decompress()` can return a JS string instead of bytes.** It does this when the output happens to look like UTF-8. That is another reason not to call it on the data path.
3. **zstd needs no library.** Electron 44.4.4 ships Node 24.21, and Playwright runs on Node 22.22. Both have `zlib.zstdDecompressSync`, and it supports `maxOutputLength`. We use that; `zstddec` is only an oracle.
4. **`steam-user` writes depot keys to disk by default.** Unless `dataDirectory: null` is set, it saves `depot_key_<app>_<depot>.bin`, machine ids and cell ids to a global AppData folder. We set `dataDirectory: null` and `saveAppTickets: false`.
5. **`steam-user`'s own downloaders can't be used.** Its manifest and chunk downloaders use plain `http(s).request` with no pinning, and `getRawManifest` picks a random server. We fetch manifests and chunks ourselves, through `StreamConnection`.
6. **Manifest signatures aren't checked by anyone, and many content servers speak plain HTTP.** So a manifest's file names are untrusted. Path validation is strict, and we use HTTPS whenever a server offers it.
7. **Pitfalls found in the existing code.** A third kind would hit these:
   - `restoreOne` returns null for an unknown kind, and the download is then discarded (`downloadManager.ts:750-800`, `:644`).
   - `history.ts:27` drops unknown kinds silently.
   - `shared/downloadUpdate.ts:8` treats "no `blocks`" as a torrent.
   - Several renderer and `transfer.ts` ternaries treat "not http" as torrent.
   - All of these become explicit three-way branches before any Steam state can be saved.
8. **Pure specs can't import modules that use `testKnobs`.** `testKnobs` reads Electron's `app` when it loads, and the pure specs run in plain Node. So every pure Steam module stays free of `electron` and `testKnobs`.

## Libraries (verified by reading the tarballs)

| Package            | Version             | License              | Use                                                                                                                                                                                                                                                                                                               |
| ------------------ | ------------------- | -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `steam-session`    | 1.9.4 (pin exactly) | MIT                  | Login: `LoginSession(EAuthTokenPlatformType.SteamClient)`, `startWithCredentials`, `submitSteamGuardCode`, `startWithQR`, `cancelLoginAttempt`. Events: `authenticated`, `timeout`, `error`, `remoteInteraction`; `refreshToken` getter. Ships its own `.d.ts`.                                                   |
| `steam-user`       | 5.3.0 (pin exactly) | MIT                  | CM session from the refresh token: `logOn({refreshToken})`, the `licenses` event, `getProductInfo` with access tokens, `getDepotDecryptionKey`, `getManifestRequestCode`, `getContentServers`, `getCDNAuthToken`. No bundled types: a narrow local `src/main/steam/modules.d.ts`, as `torrent/modules.d.ts` does. |
| `qrcode-generator` | 2.0.4               | MIT, no dependencies | Builds the QR matrix in main. The renderer draws it as SVG `<rect>`s.                                                                                                                                                                                                                                             |

- **No native modules.** All transitive dependencies are pure JS. Electron and Node compatibility is fine: they're CJS packages, and `electron-vite` externalizes them.
- **Install scripts.** `protobufjs@7` has a postinstall that only prints a version-scheme warning. It is not added to `allowScripts`.
- **Pinned exactly**, like webtorrent, because we rely on their message behaviour.
- **Oracles only:** `@doctormckay/steam-crypto` (`symmetricEncrypt`/`symmetricDecrypt`), `lzma`, `zstddec`, `steam-user/components/{content_manifest,cdn_compression}.js`. They make test fixtures and check our functions, and are never used on the data path.

## Module layout (`src/main/steam/`)

**Pure, with no `electron` or `testKnobs` import, so it can be unit-tested:**

| Module          | What it holds                                                                                                                                                                                         |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `crypto.ts`     | `decryptChunk(body, key)`. The first 16 bytes are an IV, AES-256-ECB encrypted; the rest is AES-256-CBC with PKCS7 padding. Also `decryptFilename`.                                                   |
| `lzma.ts`       | LZMA1 decoder, with output bounded by the declared size.                                                                                                                                              |
| `chunkCodec.ts` | Detects `VZa`, `VSZa` or `PK\x03\x04`; parses the header and footer; decompresses with `maxOutputLength = cb_original`. Then checks length == `cb_original`, the footer CRC32, and SHA-1 == chunk id. |
| `manifest.ts`   | Unzips the manifest (bounded) and runs a minimal protobuf reader for `ContentManifestPayload` and `Metadata`, with caps on files, chunks and name length. Decrypts file names.                        |
| `layout.ts`     | Turns manifests into the install layout. See "Files, paths and resume".                                                                                                                               |
| `appInfo.ts`    | Validates the untrusted PICS appinfo into typed details: depots, branches, filters, sizes, DLC, `depotfromapp`, encrypted manifests. Also picks the default depot selection.                          |
| `scheduler.ts`  | Steam work picker. See "Scheduler".                                                                                                                                                                   |
| `cells.ts`      | Groups chunks into at most 2048 grid cells, and saves and restores progress.                                                                                                                          |
| `redact.ts`     | Strips JWTs, `token=` query values, hex keys and URLs with request codes out of any message.                                                                                                          |

**Electron side:**

| Module                             | What it holds                                                                                                                                                          |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `backend.ts`                       | The `SteamBackend` interface, below.                                                                                                                                   |
| `steamUserBackend.ts`              | The real backend. The only file that loads `steam-session` and `steam-user`, lazily, as `engine.ts` does for webtorrent.                                               |
| `fakeBackend.ts`                   | Tests only. Active when `NETFUSE_E2E_STEAM=<url>` is set; `testKnobs` ignores it in a packaged app. Talks to the local test server.                                    |
| `account.ts`                       | Login state machine and refresh-token storage.                                                                                                                         |
| `library.ts`                       | Owned apps and app details, cached per session.                                                                                                                        |
| `prepare.ts`                       | Turns a request into a plan: manifests over a pinned connection, layout, sizes, free space. Plans live in an LRU keyed by `planId`, like `probedTorrentFile`.          |
| `chunkFetch.ts`                    | One pinned GET of a whole chunk body into memory. Exact length, stall watchdog, `Limits.take` and meters on every data event; reuses `HttpStatusError`/`retryAfterMs`. |
| `chunkWorker.ts` + `workerPool.ts` | Decrypt, decompress and verify off the main thread. The worker is built with electron-vite's `?modulePath`.                                                            |
| `steamDestination.ts`              | `extends DownloadFile`. Pool of open file handles, positional writes, `sync()` that makes progress durable, `publish`, `discard`.                                      |
| `steamTransfer.ts`                 | `implements Transfer`.                                                                                                                                                 |
| `servers.ts`                       | Content servers and CDN tokens. See "Content servers and tokens".                                                                                                      |

`SteamBackend`, the seam tests replace:

```ts
interface SteamBackend {
  // auth
  startCredentials(accountName: string, password: string): Promise<LoginStep>
  startQr(onChallenge: (url: string) => void): Promise<LoginStep>
  submitCode(code: string): Promise<LoginStep>
  cancelLogin(): void
  logOn(refreshToken: string): Promise<{ accountName: string }>
  logOff(): Promise<void>
  onRefreshToken(cb: (token: string) => void): void
  onLoggedOut(cb: (reason: string) => void): void
  // control plane
  licenses(): Promise<{ packageId: number; borrowed: boolean }[]> // expired licenses already filtered
  productInfo(apps: number[], packages: number[]): Promise<RawProductInfo> // tokens included
  depotKey(appId: number, depotId: number): Promise<Buffer>
  manifestRequestCode(
    appId: number,
    depotId: number,
    manifestId: string,
    branch: string
  ): Promise<string>
  contentServers(appId: number): Promise<RawContentServer[]>
  cdnAuthToken(
    appId: number,
    depotId: number,
    host: string
  ): Promise<{ token: string; expiresAt: number }>
}
```

The data plane (manifest and chunk HTTP) is production code in both backends. Only the control plane is faked.

## Data model (`src/shared/types.ts`)

```ts
export interface SteamCellState extends WorkUnitState {
  kind: 'steam'
  status: HttpBlockStatus
}
export interface SteamStreamState {
  id
  interfaceId
  status: HttpStreamStatus
  host: string
  bytesDownloaded
  speedBytesPerSec
  currentCellIndex?
  /** Bytes of the chunk it is fetching so far, and the chunk's size. */
  chunkReceived?
  chunkBytes?
  hedge?
}
export interface SteamDownloadNetwork extends DownloadNetworkBase {
  transfer: 'steam'
}
export interface SteamDownloadState extends DownloadStateBase {
  kind: 'steam'
  networks: SteamDownloadNetwork[]
  streams: SteamStreamState[]
  peakStreams: number
  cells: SteamCellState[]
  totalCells: number
  totalChunks: number
  chunksDone: number
  app: { appId: number; name: string; branch: string; buildId?: string }
  depots: { depotId: number; manifestId: string; name: string }[]
  fileCount: number
  installBytes: number
  /** Installed into a folder that was already there. */
  adopted?: boolean
  phase?: 'preparing'
  diskLimited?: boolean
}
export interface StartSteamDownloadRequest {
  kind: 'steam'
  planId: string
  interfaceIds: string[]
  streamsPerNetwork?: number
}
export interface SteamRequestPayload {
  kind: 'steam'
  appId
  branch
  depots: { depotId; manifestId }[]
  destinationDir
  interfaceIds
  streamsPerNetwork?
} // what is saved; never a key or token
export type SteamLoginState =
  | { status: 'logged-out'; error?: string; canRemember: boolean }
  | { status: 'connecting' }
  | { status: 'awaiting-code'; guard: 'email' | 'device'; emailDomain?: string; error?: string }
  | { status: 'awaiting-confirmation' }
  | { status: 'awaiting-qr'; qr: boolean[][] }
  | { status: 'logged-in'; accountName: string; remembered: boolean }
```

- `SteamOwnedApp`, `SteamAppDetails` and `SteamPlan` carry display data only.
- Each union also gets its Steam member: `DownloadState`, `DownloadNetwork`, `DownloadUnitState`, `FinishedDownload`, `DownloadUpdate`, `StartDownloadRequest`.
- `totalBytes` and `bytesDownloaded` count **download bytes**: the sum of `cb_compressed` over unique chunks. That is what the speed meters count, so time left stays right. The install size is shown separately.
- **Per-chunk state stays in main**, as typed arrays (struct-of-arrays). Status is a `Uint8Array`. SHA-1s sit in one `Buffer`. Sizes, depot index, cell index and the flattened write targets (file, offset) are typed arrays too. A 100k-chunk game costs a few MB and no per-chunk objects. The window only ever sees the cells.

## Plugging `SteamTransfer` into `downloadManager.ts`

Steam-specific helpers live in `src/main/steam/runtime.ts`: `newSteamRuntime`, `restoreSteam`, `saveSteamProgress` and `steamHistoryEntry`. That keeps the manager change to explicit branches. Branches to change, from the explorer's map:

| Where                                                                           | What changes                                                                                                                                                                                                                |
| ------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DownloadRuntime` (108-118), `PersistedState` (130-136)                         | Add the Steam member.                                                                                                                                                                                                       |
| `savedRequest` (165-176)                                                        | Plain payload.                                                                                                                                                                                                              |
| network factory (228-249)                                                       | `newSteamNetwork`.                                                                                                                                                                                                          |
| `unitsOf` (255-256)                                                             | Explicit cells.                                                                                                                                                                                                             |
| `httpDownloadsOn` (470-485)                                                     | Also counts Steam downloads on Auto, so they share a network's streams with HTTP. Unchanged when no Steam download runs.                                                                                                    |
| `newHttpRuntime`/`newTorrentRuntime` (553-613)                                  | Gain a Steam sibling.                                                                                                                                                                                                       |
| `moveToHistory` (689-708)                                                       | `unitsWritten` = chunks, and `adopt` is kept.                                                                                                                                                                               |
| `restoreOne` (743-869)                                                          | A Steam branch: read `steam-manifests.json.gz` from the download folder, work the layout out again (every path checked), and take up the saved chunks if they fit. Per-file checks happen at the start of each run instead. |
| `listDownloads` (889-895), `takeUpdate` (1902-1911), `changedUnits` (1923-1931) | Send `{cells}`.                                                                                                                                                                                                             |
| `start` (898-1012)                                                              | A `kind === 'steam'` branch before the destination folder is made: take the plan, `ensureDiskSpace(installBytes - present)`, save the manifests, `claimDestinationPath(dir, installdir, true)` unless adopting.             |
| `pause` (1057-1070), `begin` (1291-1302), `cancelRuntime` (1510)                | Stream status, as HTTP.                                                                                                                                                                                                     |
| `relink` (1093), `failedMatch` (1185), torrent-only calls                       | Unchanged: they already refuse others.                                                                                                                                                                                      |
| `remove` (1551)                                                                 | Not adopted: trash the folder. Adopted: offer no trash, and nothing is deleted.                                                                                                                                             |
| `run` (1635, 1733)                                                              | Not torrent-specific.                                                                                                                                                                                                       |
| `reconcile` (1796-1817)                                                         | Keep a network that has streams, as HTTP does.                                                                                                                                                                              |
| `persistNow` (1972-1982)                                                        | Strips cells and streams, and writes a `steam` field: the chunks done (see "Changes after review"), the files it created, and the units it fetches when that isn't all of them.                                             |

Also changed:

- `transfer.ts`: `SteamTransferTarget`, and explicit branches in `updateSpeeds`, `clearSpeeds`, `updateTimeLeft`.
- `history.ts:27`: accepts `'steam'`.
- `trashDownload.ts`: knows about adopted folders.
- `shared/downloadUpdate.ts`: switches on `update.state.kind`. http and torrent behave the same as now.

### `SteamTransfer`

It follows `HttpTransfer`'s structure:

- **Streams.** Each stream has its own pinned `StreamConnection` (a kept-alive agent per stream and network). The count comes from `startingStreams`/`interleave` plus `ConcurrencyController` and `DiskWatch` from `concurrency.ts`, unchanged.
- **The worker loop.** Pick work, `chunkFetch`, the worker pool verifies, write to every target, then mark done.
- **A corrupt chunk is never written.** It counts as a strike against that network and server, and goes back to the queue avoiding that server. If one chunk fails verification on 3 different servers, the download fails with "Steam keeps sending a damaged copy of a file".
- **Failures** are handled like `finishFailed`. Connection errors retry while the network exists. Transient statuses (429/5xx) are waited out with `Retry-After` honoured per network and server (the `holdUntil` pattern). 401/403 means the token is refreshed once, and the server is switched after that. 404 means another server.
- **Network status.** A silent network becomes `unreachable` and keeps one stream trying. Repeated refusals make it `failed` via `host.failNetwork`.
- **Tail hedging only:** at most 1 hedge per chunk, at the end.
- **Each run** first makes sure of the install's folders, files (`ftruncate`, `markSparse` on Windows), symlinks and executable bits, and forgets the chunks of any file that went missing (the `preparing` phase). Then it asks Steam for the depot keys and content servers, and only then do its streams start.

### Scheduler: Steam-specific, same rules

`pickWork` doesn't fit, for two reasons:

- **It scans every block on every pick.** That is O(n) per call, and with 100k+ chunks and hundreds of picks a second it would cost the main thread real time.
- **It is built around resumable byte ranges.** It works on `HttpBlockState` frontiers. A Steam chunk is all-or-nothing, because the body must be decrypted whole.

`steam/scheduler.ts` keeps `pickWork`'s rules:

- A free stream pulls the next pending chunk, so faster networks take more.
- A chunk whose last attempt on this network delivered nothing is left to another network while one is free, and is never stranded.
- Hedges come only once the queue is empty and the disk isn't behind. They need a measured speed, prefer another network, are capped per chunk, and go to the one that will finish latest.

It works from a cursor plus a requeue ring, so a pick costs O(1) amortised. The relevant `scheduler.spec.ts` cases are ported, with fast-check properties added.

### Content servers and tokens

- **Server list.** Sorted by Steam's weighted load; take the best 8.
- **Spreading.** Streams get servers round-robin, offset by network, so each network spreads across servers.
- **Server health** is tracked per (network, server): a server that keeps failing is benched for a while for that network.
- **CDN tokens** are cached per (depot, vhost), refreshed shortly before they expire and on a 401/403.
- **HTTPS** when `https_support` is `mandatory` or `optional`. The URL host is `server.Host`, as `steam-user` does.

## Files, paths and resume

- **Path validation** (`layout.ts`, pure). We treat both `\` and `/` as separators. We reject:
  - empty segments, `.` and `..`;
  - absolute paths, drive letters and UNC paths;
  - NUL and control characters;
  - any segment over 255 bytes;
  - on Windows, reserved names, invalid characters and a trailing dot or space;
  - anything that resolves outside the install folder (the `torrent/paths.ts` approach);
  - a file that sits below a symlink entry;
  - a symlink whose target is absolute or escapes the install folder;
  - two files that collide on a case-insensitive system (win32, darwin).

  Folder names that differ only in case merge on win32 and darwin and stay separate on Linux.

- **Long Windows paths.** Paths over 260 characters get a warning, not a refusal; Node's fs handles them.
- **Chunks within a file** must be in bounds, ordered and non-overlapping. Gaps are zero-filled; how real manifests behave goes on the manual checklist.
- **Sizes** are uint64; anything above `Number.MAX_SAFE_INTEGER` is refused.
- **Multi-depot.** When two selected depots contain the same path, the depot later in appinfo order wins.
- **Dedup.** One unit is one unique chunk SHA per depot, with one or more write targets. It is fetched once and written to all of them.
- **Progress that survives a crash.** A checkpoint takes its snapshot of the chunks done, then syncs the files written since the last one, then saves the snapshot. A chunk is in the snapshot only once all its writes have resolved, so a saved chunk is on disk. Chunks not saved as done are fetched again and overwritten, so resuming after a crash needs no checking pass.
- **Installing over an existing folder.** An explicit choice in the dialog. While planning, every chunk's ranges are read back and checked against their SHA-1s; the plan then holds only the chunks still needed. Chunks already correct never count as downloaded, and are never credited to any network.
- **Cancel and remove.**
  - A fresh folder is ours: cancel removes it entirely.
  - An adopted folder: we delete only the files this download created, kept in a persisted list. Nothing that was there before is touched.
- **Free space.** Shown in the dialog, and enforced at start through `ensureDiskSpace`.
- **Persisted per download** in `<userData>/downloads/<id>/`:
  - `manifest.json`: version 7, with the Steam state and progress.
  - `steam-manifests.json.gz`: the depots' manifests as read and decrypted (file names, sizes, flags and chunk lists; nothing secret), so a restart can list a paused download and work its layout out again without logging in.
  - Never a depot key or token. Keys are asked for again each session.

## Credentials and privacy

- **Passwords and Guard codes** are passed through once and never stored or logged.
- **The refresh token** is stored with `safeStorage.encryptString` in `userData/steam-account.json`: unavailable, or Linux `basic_text`, means it is kept in memory only and the login screen says the login can't be remembered on this computer.
- **Refresh tokens Steam renews** are re-encrypted.
- **Logout** deletes the stored token and logs the client off.
- **What the renderer gets:** `SteamLoginState` only. The QR is sent as a boolean matrix, not as the challenge URL.
- **Every error** from the Steam modules goes through `redact()` before it reaches `state.error`, the window, a notification or the console.
- **`steam-user`'s `debug` event** is never connected to the console.
- **Ownership.**
  - Only depots from the account's non-expired licenses are offered. Borrowed (Family Sharing) licenses are included and labelled.
  - Steam's own key and manifest-code refusal (AccessDenied and others) stops the download with a plain message.
  - No anonymous login. Password-protected branches are listed but disabled, with "Password-protected branches aren't supported".
- **Network calls.** Only Steam endpoints are contacted: the CM websocket, `api.steampowered.com`, the content servers Steam hands out, and Steam's store CDN (`shared.akamai.steamstatic.com`) for the games' pictures, which need no login and carry nothing of the account.
- **Known limitation, documented:** the control-plane traffic (CM websocket, WebAPI) uses the system's default route and isn't counted toward per-network data limits. It is small. Manifests and chunks are pinned and counted.

## IPC additions

Typed in `ipc-contract.ts` and `ipc-channels.ts`, with handlers in `handlers.ts` and the API in `preload`:

| Call                                                                         | Result                                                                                                  |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `steamLoginState()`                                                          | `SteamLoginState`                                                                                       |
| `steamLogin({method:'credentials', accountName, password} \| {method:'qr'})` | —                                                                                                       |
| `steamSubmitCode(code)`                                                      | —                                                                                                       |
| `steamCancelLogin()`                                                         | —                                                                                                       |
| `steamLogout()`                                                              | —                                                                                                       |
| `steamOwnedApps(refresh?)`                                                   | `SteamOwnedApp[]`                                                                                       |
| `steamAppDetails(appId)`                                                     | `SteamAppDetails`                                                                                       |
| `steamPrepare({appId, branch, depotIds, destinationDir, adopt})`             | `SteamPlan {planId, folderName, downloadBytes, installBytes, freeBytes, fileCount, existing, warnings}` |
| `startDownload`                                                              | Now also takes `StartSteamDownloadRequest`.                                                             |

Push events: `steamLoginStateChanged`, `steamPrepareProgress`.

Every handler checks its arguments at runtime: integers, string lengths, branch names, a code format, depot ids that are a subset of the owned depots.

## The window

- **Login first.** Until Steam is logged in, the window shows only the login (`LoginScreen`, with `SteamLogin` in it): account name and password or a QR code, then a Steam Guard code or an approval in the mobile app. The first login-state request waits until the stored login has been looked for, so someone who stays logged in never sees the form flash up. "Stay logged in" is disabled, with the reason, when there's no system keychain.
- **Sidebar.** Under Library, a row per launcher (Steam, with its game count); under Transfers, Downloads with how many are unfinished. At its foot the networks menu (with Speed & data limits and the schedule) and the account, whose menu logs out. Another launcher gets a row and a library screen; nothing else moves.
- **Library** (`LibraryScreen`). Every owned game by its portrait picture, searched by name or app id and filtered by All, Installed or Not installed. Its title is a menu of Games (the default: games, demos and betas), Tools (Steam's tools and software) and Games & tools, each with its count. Each card says where the game stands: its download's progress, installed by NetFuse, or installed by the Steam client (an `appmanifest_<id>.acf` in one of its libraries, `steamClientApps`). Only the rows in view are drawn, so a library of thousands stays light.
- **Pictures** (`steam/art.ts`). The window asks for `game-art://steam/<appId>/<capsule|header|hero>`; the main process fetches it from Steam's store CDN, at the path the app's appinfo gives or Steam's usual file name, and keeps it under `userData/art`. Six at a time, at most 12 MB, JPEG, PNG or WebP only; a picture Steam doesn't have is noted as missing for three days. A game with no portrait picture shows its header over a blur of itself, and one with neither its name on a color of its own.
- **Game page** (`GameScreen`). Its banner, name and state, a way to its download or its install folder, then what to install:
  - Branch, then OS, architecture and language filters, then a depot checklist with the defaults pre-ticked. DLC and shared depots are labelled, and a borrowed license says Family Sharing.
  - Download and install sizes, free space, a "Save to" folder with Change and Auto-detect.
    - Auto-detect finds the Steam client (the registry and Program Files on Windows, the usual folders on macOS and Linux, Flatpak and Snap included) and reads its `libraryfolders.vdf` (`steam/libraryFolders.ts`, pure). It offers each library's `steamapps/common`, those that already have the game first.
    - Picking one that has the game ticks "install over the existing folder", so only what's missing or different is fetched.
    - Steam itself lists the game once Install is clicked on it in Steam, which finds the files; writing Steam's `appmanifest` is Phase 4.
  - Network chips, and "Fetching file lists: 2 of 3 depots" progress; then the download starts and its own screen opens. The plan's warnings (long Windows paths, symlinks on Windows) are shown first, with "Download anyway".
  - The depot choice is worked out by `shared/steamSelection.ts`, the same code the main process checks it with.
- **Downloads** and each download's own screen: the game's picture, streams with their content server, the grid over cells ("parts"), phase lines ("Preparing files…"), the Complete screen counting chunks. "Download again" opens the game's page. Cancel and Move to Trash say what they do to a game: a cancel removes only what it installed; the Trash takes the whole install folder, with anything the game saved there.
- **Error messages** cover: not owned or refused, region-restricted, rate limited, login expired ("Log in to Steam to continue", resumable), password branch, disk full, damaged chunk.

## Test plan

**Pure specs** (no app; fast-check where useful):

- `steamCrypto` against the steam-crypto oracle, plus wrong key, truncated and bad-padding inputs.
- `steamLzma` against `lzma` and `xz --format=lzma` fixtures. Random round-trips. Malformed streams must throw quickly; output stays bounded.
- `steamChunk` across all three formats against the steam-user `CdnCompression` oracle. Covers CRC, size and SHA failures, truncation, and decompression bombs.
- `steamManifest` against the steam-user parser oracle, plus malformed, truncated and huge-count inputs.
- `steamLayout`: traversal, case, reserved names, symlinks, depot override, tiling, uint64, dedup.
- `steamAppInfo`, `steamScheduler`, `steamCells` (save and restore round-trip, malformed saves), `steamRedact`.

**Steam test origin** (`e2e/steamOrigin.ts`, a sibling of `origin.ts`):

- Builds a synthetic multi-depot app from seeded bytes. It covers every compression format, duplicate chunks, a symlink, an exec file, an empty file and nested folders.
- Encrypts with a test key, and serves manifests and chunks on 2 virtual servers.
- Fault rules per request: ok, `{status, headers}` (429 with Retry-After, 5xx, 404), `{cutAfter}`, `{corruptAt}` (flips one byte at an exact offset), `stallHeaders`, `stallBody`, `{crawl}`, short or overlong bodies, and an expired-token mode (401 until a new token is used), plus a hold at a byte.
- The fake control plane serves login (credentials plus Guard code, and a QR approve endpoint), licenses, appinfo, keys, request codes, servers and tokens.

**App specs:**

- `steam.spec.ts`, tagged @smoke:
  - log in, list, details, prepare, start;
  - completes with `treeSha` equal to the source, on 2 networks when there is a LAN address;
  - each network's bytes > 0.
- `steamFaults.spec.ts`:
  - A corrupt chunk is re-fetched, and a hold checks the bytes on disk were never the corrupt ones.
  - 429 waits out Retry-After; 5xx; stalls.
  - An expired token gets refreshed.
  - A 404 moves to the other server.
- `steamLifecycle.spec.ts`:
  - pause and resume;
  - kill and relaunch, where the server log shows each done chunk fetched once;
  - switching a network off mid-download;
  - cancel and remove leave nothing;
  - an adopted folder keeps pre-existing files.
- `steamAuth.spec.ts`: a marker token, password and key are never found in any recorded IPC payload, the store, the app output or any file under userData. Logout clears the stored token. The no-keychain path doesn't persist.
- `chaos.spec.ts` gains a Steam property with the same command set and Steam faults. The HTTP property is unchanged.
- The existing automatic checks also cover Steam: byte-for-byte equality, no stray files, `lsof` open handles.

## Risks, and what needs a real Steam account

These need real Steam:

- whether content servers still need CDN tokens;
- HTTPS versus vhost certificates;
- the key and request-code app id for `depotfromapp` depots;
- whether manifest chunks tile files exactly;
- how common zstd chunks are;
- the Guard flows: email, mobile code, mobile confirm, QR.

Other risks:

- **Our LZMA decoder's speed.** It is benchmarked in Phase 1.
- **Worker bundling** through electron-vite `?modulePath`, checked in Phase 2.
- **Many open files.** Handled by the handle pool.
- **The manager grows by about 150 lines** of branches. The Steam logic itself stays in `steam/`.

Other notes:

- **`docs/` is the GitHub Pages site** (it has a CNAME). With Pages enabled, `docs/steam/DESIGN.md` and `docs/steam.md` would be published. This design uses those paths as asked.

## Phase 4, deferred

What it would take, recorded in `DESIGN.md` for later:

- **Finding libraries.** Read `libraryfolders.vdf` on Windows (registry `SteamPath`), macOS (`~/Library/Application Support/Steam`) and Linux (`~/.steam/steam`, `~/.local/share/Steam`, Flatpak `~/.var/app/com.valvesoftware.Steam/...`, Snap `~/snap/steam/common/...`).
- **Installing.** Into `steamapps/common/<installdir>`.
- **The appmanifest.** Write `appmanifest_<appid>.acf` only after every file has been verified. It needs `StateFlags 4`, `buildid`, `InstalledDepots` with manifest ids and sizes, `SizeOnDisk` and `LastOwner`.
- **Safety.** Refuse an existing install without explicit confirmation, and tell the user to close Steam.
- **Why deferred.** It can't be checked here against a real Steam client.

## `CLAUDE.md`

- **Commands:**
  - `npm ci` (Node 22.13+);
  - `npm run dev`, `lint`, `typecheck`, `format:check`;
  - `xvfb-run … npm run test:e2e:smoke`;
  - `NETFUSE_E2E_SKIP_BUILD=1`;
  - the chaos seed and runs variables.
- **Conventions:**
  - Comments explain _why_, in plain sentences.
  - No unrelated reformatting or refactors.
  - Download and network changes need reasoning in the PR (CONTRIBUTING).
  - Retries stay off; known bugs are marked `test.fail`.
  - Tags (`@smoke`, `@disk`, `@chaos`) go in the test title.
- **Architecture pointers:**
  - the `Transfer` seam;
  - the manager owns the lifecycle;
  - every socket goes through `StreamConnection`/`connectRoute`;
  - every received byte goes through `Limits.take`;
  - `testKnobs` only work unpackaged.
- **Test rules:**
  - Pure specs must not import `electron` or `testKnobs` dependents.
  - The automatic invariants apply to every test.
  - Loopback skips device binding.
- **Steam rules:**
  - Owned content only.
  - Secrets never reach the renderer, disk in the clear, or logs.
  - `redact()` every Steam error.

## Phases

| Phase | Contents                                                                                                                                                                              |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0     | `CLAUDE.md` and this document.                                                                                                                                                        |
| 1     | Install the pinned dependencies; the pure modules and their specs; the backend interface and real backend; `account`, `library`, `prepare` logic. No manager changes. LZMA benchmark. |
| 2     | Types, `transfer.ts` and manager branches, `SteamTransfer`, destination, worker pool, fake backend, Steam origin, lifecycle and fault specs.                                          |
| 3     | IPC, preload, store, `SteamDialog`, screen branches, error messages, auth spec.                                                                                                       |
| 4     | Deferred (see above).                                                                                                                                                                 |
| 5     | Chaos and smoke coverage, hardening, manual checklist (`docs/steam/MANUAL-TEST.md`).                                                                                                  |
| 6     | README, `docs/steam.md`, PR description draft.                                                                                                                                        |

## Verification (every phase)

- `npm run lint`, `npm run typecheck`, `npm run format:check`.
- `xvfb-run --auto-servernum --server-args="-screen 0 1280x1024x24 -noreset" npm run test:e2e:smoke`.
- The phase's own specs.
- The full `npm run test:e2e` at Phases 2, 5 and 6.
- The existing HTTP and torrent specs must pass unchanged.
- The report lists what was verified only against the fake backend.
