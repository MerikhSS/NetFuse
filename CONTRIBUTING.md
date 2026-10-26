# Contributing to NetFuse

Thanks for taking a look at NetFuse. It's a small project, so the process is intentionally lightweight.

## Setup

```bash
git clone https://github.com/MerikhSS/NetFuse.git
cd NetFuse
npm ci
npm run dev
```

Requires Node.js 22.13+ and npm 9+, on Windows, macOS, or Linux.

## Packaging

Run packaging commands on the corresponding operating system. Packages are written to `dist/`.

- **macOS**: `npm run build:mac` creates Intel and Apple silicon `.dmg` and `.zip` packages. Unpacked apps are in `dist/mac/NetFuse.app` and `dist/mac-arm64/NetFuse.app`.
- **Windows**: `npm run build:win` creates one installer for x64 and ARM64. `npm run build:unpack` creates an unpacked app for the current architecture; run `dist/win-unpacked/netfuse.exe`.
- **Linux**: `npm run build:linux` creates AppImage, `.deb`, `.rpm` and `.tar.gz` packages for x86_64 and ARM64. RPM packaging requires `rpmbuild`; the release workflow installs it through the `rpm` package.

Local builds are unsigned unless signing credentials are configured.

The icon's source is `build/icon.svg`; `build/icon.png`, `.ico` and `.icns` and `resources/icon-dark.png` are rendered from it.

## Before opening a PR

```bash
npm run lint
npm run typecheck
npm run format
npm run test:e2e:smoke
```

CI runs these checks on every pull request, with formatting checked rather than applied — if it flags something, `npm run format` fixes it.

`main` takes changes by pull request only: direct pushes and force-pushes are rejected, and CI has to be green before a PR can merge.

Please describe how you checked your change manually (which game, its size, which networks) in the PR description.

## End-to-end tests

On Linux, Electron needs a display even when the test window is hidden. In a headless environment, install Xvfb and run:

```bash
xvfb-run --auto-servernum --server-args="-screen 0 1280x1024x24 -noreset" npm run test:e2e:smoke
```

`e2e/` drives the real built app through the same `window.netfuse` API the renderer uses, against a local fake Steam (`e2e/steamOrigin.ts`): logins with Steam Guard, licenses, appinfo, depot keys, and two content servers that can damage, drop, stall or hold any chunk. No test talks to the real Steam. Every test also runs automatic checks: a `completed` download must match the game byte for byte, and anything else must leave nothing of its install or any open handle behind. The app's window stays hidden while tests run.

```bash
npm run test:e2e:smoke          # smoke tests run on every PR
npm run test:e2e                # everything, including @disk
```

Tests build the app first; set `NETFUSE_E2E_SKIP_BUILD=1` when `out/` is already fresh. Known bugs are written as `test.fail(...)` — when a fix lands, Playwright reports the test as unexpectedly passing, and the marker comes off. Retries are deliberately off: a download test that passes only on a retry has found a race.

## Making changes

- Keep PRs focused — one fix or feature per PR is easier to review than a bundle of unrelated changes.
- Match the existing code style (enforced by `eslint`/`prettier`, run `npm run format` before committing).
- If you're changing download, networking or Steam behaviour (`src/main/download/`, `src/main/network/`, `src/main/steam/`), explain the reasoning in the PR — a lot of the logic there (resume/retry/stall handling, chunk verification) exists to avoid subtle data-corruption bugs, so tradeoffs matter more than usual.
- UI changes: a screenshot or short screen recording in the PR description is very helpful.
- Only content the logged-in account owns is ever downloaded, and no password, Steam Guard code or token is ever stored in the clear or logged. Changes that weaken either aren't accepted.

## Releasing

A release ships NetFuse for macOS (Apple silicon and Intel `.dmg`), Windows (one installer for x64 and ARM64) and Linux (AppImage, `.deb`, `.rpm` and `.tar.gz`, x86_64 and ARM64). The release notes label each file from its name (`scripts/downloads.cjs`), so keep the naming in `electron-builder.yml` intact.

First bump the version and add its entry at the top of `scripts/changelog.cjs`, in one PR. The entry becomes the release notes, and a tag without one stops before building.

```bash
npm version <version> --no-git-tag-version     # e.g. 0.2.0
# add the v<version> entry to scripts/changelog.cjs, open the PR, merge it
git checkout main && git pull
git tag v<version> && git push origin v<version>
```

The tag runs `.github/workflows/release.yml`: it builds every OS and leaves a draft GitHub Release with the changelog entry and the downloads table. Check the draft and publish it. Publishing is what ships it: it becomes the Latest release, and within a few hours every running NetFuse downloads it in the background and offers a restart. Mark a release pre-release to keep it from everyone's automatic updates: the app only updates to Latest. A build to throw away? Delete the draft and the tag.

Besides the downloads, a release carries what the app's updater reads (`src/main/updater.ts`): the `latest*.yml` channel files, the macOS `.zip`s and the blockmaps. `scripts/release-notes.mjs --files` lists them.

macOS only installs signed updates. The release workflow signs and notarizes the Mac build when these repository secrets are set: `MAC_CERTIFICATE_P12_BASE64` and `MAC_CERTIFICATE_PASSWORD` (a Developer ID Application certificate), and `APPLE_API_KEY_P8`, `APPLE_API_KEY_ID` and `APPLE_API_ISSUER` (an App Store Connect API key). Without them a Mac that finds an update sends you to the releases page for it.

## Reporting bugs

Open a GitHub issue with:

- Operating system and version
- Which game (its Steam app id), and roughly its size
- Which network interfaces were involved
- Console/error output if there was a crash. Never paste a password, Steam Guard code or token: NetFuse never needs one to diagnose a problem.

## Ideas / feature requests

Open an issue to discuss before writing a lot of code — happy to talk through approach first, especially for anything touching the chunk, resume or Steam logic, or another launcher.
