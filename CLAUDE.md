# NetFuse

Electron, TypeScript and React desktop app. It downloads the Steam games an account owns, spreading each download across several networks at once (Wi-Fi, Ethernet, a tethered phone). Steam is the only launcher so far; the window has room for others. Read `CONTRIBUTING.md` first; its rules apply.

## Commands

- `npm ci`: install. Needs Node 22.13+. `postinstall` runs install-electron and electron-builder's native rebuild.
- `npm run dev`: run the app.
- Before every commit:
  - `npm run lint`
  - `npm run typecheck` (node, web and e2e)
  - `npm run format:check`
  - `npm run test:e2e:smoke`
- On headless Linux, Electron needs a display:

  ```bash
  xvfb-run --auto-servernum --server-args="-screen 0 1280x1024x24 -noreset" npm run test:e2e:smoke
  ```

- `npm run test:e2e`: everything, including `@disk`.
- Run one file with `npx playwright test e2e/<name>.spec.ts`.
- Tests build the app first with `electron-vite build`, with no typecheck. Set `NETFUSE_E2E_SKIP_BUILD=1` when `out/` is already fresh.
- `npm run format` rewrites the whole repo. Prefer `npx prettier --write <files you touched>`.

## Conventions

- Match the surrounding style. Comments explain _why_, in plain sentences, and say what a thing is for rather than restating the code.
- Keep changes focused. No reformatting or refactoring of unrelated code.
- `src/main/download/`, `src/main/network/` and `src/main/steam/` hold resume, retry and stall logic that prevents data corruption. Changes there need their reasoning written in the PR description.
- Never push to `main`; it takes changes by pull request only.
- Electron security settings stay as they are: context isolation on, no node integration in the renderer. Every renderer-to-main call goes through the typed contract:
  - `src/shared/ipc-contract.ts`
  - `src/shared/ipc-channels.ts`
  - `src/main/ipc/handlers.ts`
  - `src/preload/index.ts` (exposed as `window.netfuse`)

  Handlers check their arguments at runtime; the types are compile-time only.

- The Steam libraries (steam-user, steam-session) are pinned to exact versions because NetFuse relies on their behaviour. New protocol libraries are pinned the same way.

## Architecture

- **`src/main/download/downloadManager.ts`** owns a download's lifecycle: queue, pause and resume, per-download networks, persistence, history, and updates to the window. The fetching itself is handed to a `Transfer` (`transfer.ts`); the one implementation is `steam/steamTransfer.ts`.
  - A download's `kind` is `'steam'`. Another launcher would add a kind, and every branch on it must handle the new one explicitly.
  - `restoreOne` discards a saved download whose kind it doesn't recognise; `history.ts` drops unknown kinds.
  - A download that stopped only because Steam wasn't logged in goes on by itself once it is.
- **Pinning.** Every socket is pinned to a network through `StreamConnection` and `connectRoute` (`src/main/network/routes.ts`, `deviceBinding.ts`). Loopback addresses skip device binding, which is how the tests run.
- **Limits.** Every received byte goes through `Limits.take(networkId, bytes)` (`src/main/network/limits.ts`), which applies the speed limits and data allowances.
- **`steam/scheduler.ts`** and **`download/concurrency.ts`** (`ConcurrencyController`, `DiskWatch`) are pure functions of a snapshot.
- **Window updates** carry only the grid cells that changed (`takeUpdate`, `shared/downloadUpdate.ts`), at most once every 200 ms.
- **Persistence** lives under `userData/downloads/<id>/manifest.json` (format version 1). A checkpoint every 15 s calls `file.sync()` before saving progress.
- **The window** (`src/renderer/src/App.tsx`) shows the Steam login until there is one; then a sidebar, the library (`LibraryScreen`), a game's page (`GameScreen`), and the downloads.
- **Game pictures** come from Steam's store CDN through the main process, as `game-art://steam/<appId>/<kind>` (`steam/art.ts`), cached under `userData/art`. The renderer's CSP allows that scheme for images and nothing else.
- **`src/main/testKnobs.ts`** reads `NETFUSE_E2E_*` and `NETFUSE_USER_DATA`, and only in an unpackaged app.

## Tests

- Playwright drives the real built app through `window.netfuse` (`e2e/fixtures.ts`), against a fake Steam (`e2e/steamOrigin.ts`): its control plane (login, licenses, appinfo, keys), two content servers, and the store CDN's pictures. A content server can damage, cut, stall or hold a response, return any status, or want a CDN token.
- **Automatic checks** run after every test:
  - a `completed` download matches its source byte for byte (`treeSha` of the install folder);
  - anything else leaves nothing of the install behind, and no open handle (`lsof`);
  - the event history follows the invariants in `checkEvents`.
- Retries are deliberately off. Known bugs are marked `test.fail(...)`.
- Tags (`@smoke`, `@disk`) are plain text in the test title.
- **Pure-module specs** (for example `steamScheduler.spec.ts`) import `src/main/...` directly and launch no app. They must not import `electron`, or any module that imports `testKnobs`, because those load Electron's `app`.
- **Fake networks.** `NETFUSE_E2E_INTERFACES=a=127.0.0.1,b=<LAN address>` replaces the interface list. Tests change it while a download runs through `evaluateMain`.

## Steam

Design: `docs/steam/DESIGN.md`.

- **Owned content only.** Only apps and depots the logged-in account is licensed for. No license bypass, no DRM circumvention, no anonymous download of paid content.
- **Credentials.**
  - Passwords and Steam Guard codes are never stored or logged.
  - Only the refresh token is kept, encrypted with `safeStorage`, and not at all without a real keychain.
  - The renderer only ever sees the login state.
  - Every Steam error goes through `redact()`.
- **Network calls.** Only to Steam endpoints, the content servers Steam hands out, and Steam's store CDN for game pictures. Manifests and chunks go through `StreamConnection` and `Limits`.
- **Pure Steam modules** (crypto, codecs, manifest, layout, scheduler, cells, appinfo) stay free of `electron` and `testKnobs`, so they can be unit-tested.
