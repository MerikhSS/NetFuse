import { randomUUID } from 'node:crypto'
import { lstat, open, statfs } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import type { SteamPlan, SteamPrepareProgress, SteamPrepareRequest } from '../../shared/steam'
import { HttpStatusError } from '../download/httpStatus'
import { sanitizeFileName } from '../download/paths'
import type { NetworkMonitor } from '../network/interfaces'
import type { Limits } from '../network/limits'
import { StreamConnection } from '../network/routes'
import { testKnobs } from '../testKnobs'
import type { SteamAccount } from './account'
import { depotUnavailable, isBranchName, manifestFor } from './appInfo'
import { matchesChunk } from './chunkCodec'
import { fetchBody } from './chunkFetch'
import { buildLayout, UnsafeLayoutError, type SteamLayout } from './layout'
import type { SteamLibrary } from './library'
import { decryptManifestNames, readManifest, type Manifest } from './manifest'
import { redactedMessage } from './redact'
import { manifestUrl, rankServers, ServerPool, TokenCache } from './servers'

// From what the user picked (an app, a branch, depots, a folder) to a download ready to start:
// every depot's manifest fetched over one of the user's networks (pinned and counted through
// Limits like every other byte NetFuse receives), decrypted, and turned into the install's layout,
// every path checked before anything is written. Installing over an existing folder also checks
// what is already there, chunk by chunk, so only what is missing or different is fetched.
//
// A plan waits here, in memory, for startDownload to take it; nothing secret is in it (depot keys
// are asked for again when the download runs).

const PLANS_KEPT = 4
const PLAN_TTL_MS = 30 * 60_000
/** A zipped manifest this big is no manifest (the largest real ones are tens of megabytes). */
const MAX_MANIFEST_DOWNLOAD = 256 * 1024 * 1024
/** Content servers a manifest is tried from, on each network, before giving up. */
const MANIFEST_SERVERS = 4
/** Windows' traditional limit: longer paths work for NetFuse, but not for every program. */
const WINDOWS_PATH_LIMIT = 260

export interface PreparedDepot {
  depotId: number
  manifestId: string
  name: string
}

/** A download ready to start, as startDownload takes it. */
export interface PreparedDownload {
  plan: SteamPlan
  request: SteamPrepareRequest
  branch: string
  buildId?: string
  depots: PreparedDepot[]
  /** As read and decrypted: what the download saves, to work its layout out again later. */
  manifests: Manifest[]
  layout: SteamLayout
  /** The layout units to fetch, in order: every one, bar those already on disk and correct
   * (installing over an existing folder). */
  units: Uint32Array
  folderName: string
  /** The files checked, as they were: start refuses a plan whose files changed since. */
  checked: { path: string; size: number; mtimeMs: number }[]
  createdAt: number
}

export interface PlannerServices {
  account: SteamAccount
  library: SteamLibrary
  networks: NetworkMonitor
  limits: Limits
  progress: (progress: SteamPrepareProgress) => void
}

function checkRequest(request: SteamPrepareRequest): void {
  const ids = request.depotIds
  if (
    !Number.isInteger(request.appId) ||
    request.appId <= 0 ||
    !isBranchName(request.branch) ||
    !Array.isArray(ids) ||
    ids.length === 0 ||
    ids.length > 256 ||
    !ids.every((id) => Number.isInteger(id) && id > 0) ||
    new Set(ids).size !== ids.length ||
    typeof request.destinationDir !== 'string' ||
    !isAbsolute(request.destinationDir)
  ) {
    throw new Error('Choose what to download again.')
  }
}

async function freeSpace(dir: string): Promise<number | null> {
  try {
    const stats = await statfs(dir)
    return stats.bavail * stats.bsize
  } catch {
    return null
  }
}

export class SteamPlanner {
  private readonly plans = new Map<string, PreparedDownload>()

  constructor(private readonly services: PlannerServices) {}

  /** Takes a plan for starting: it can only be started once. */
  take(planId: string): PreparedDownload | undefined {
    this.expire(Date.now())
    const plan = this.plans.get(planId)
    this.plans.delete(planId)
    return plan
  }

  private expire(now: number): void {
    for (const [id, plan] of this.plans) {
      if (now - plan.createdAt > PLAN_TTL_MS) this.plans.delete(id)
    }
    while (this.plans.size > PLANS_KEPT) this.plans.delete(this.plans.keys().next().value!)
  }

  async prepare(request: SteamPrepareRequest): Promise<SteamPlan> {
    checkRequest(request)
    const { account, library } = this.services
    try {
      const session = await account.current()
      const details = await library.appDetails(request.appId)
      const branch = details.branches.find((entry) => entry.name === request.branch)
      if (!branch && request.branch !== 'public') throw new Error('This app has no such branch.')
      if (branch?.passwordRequired) {
        throw new Error('Password-protected branches aren’t supported.')
      }
      // In appinfo's order: where two depots ship the same file, the later one's is installed.
      const chosen = details.depots.filter((depot) => request.depotIds.includes(depot.depotId))
      if (chosen.length !== request.depotIds.length) {
        throw new Error('A chosen depot isn’t part of this app.')
      }
      for (const depot of chosen) {
        const reason = depotUnavailable(depot, request.branch)
        if (reason) throw new Error(`${depot.name}: ${reason}`)
      }

      const folderName = sanitizeFileName(details.installDir || details.name)

      const servers = new ServerPool(
        rankServers(await session.contentServers(request.appId), request.appId)
      )
      const tokens = new TokenCache((depotId, host) =>
        session.cdnAuthToken(request.appId, depotId, host)
      )
      const manifests: Manifest[] = []
      for (const [index, depot] of chosen.entries()) {
        this.services.progress({
          appId: request.appId,
          step: 'manifests',
          done: index,
          total: chosen.length
        })
        const manifestId = manifestFor(depot, request.branch)!.gid
        const key = await session.depotKey(request.appId, depot.depotId)
        const code = await session.manifestRequestCode(
          request.appId,
          depot.depotId,
          manifestId,
          request.branch
        )
        const zipped = await this.fetchManifest(servers, tokens, depot.depotId, manifestId, code)
        const manifest = readManifest(zipped)
        if (manifest.depotId !== depot.depotId || manifest.manifestId !== manifestId) {
          throw new Error(`Steam sent the wrong manifest for ${depot.name}.`)
        }
        decryptManifestNames(manifest, key)
        manifests.push(manifest)
      }
      const layout = buildLayout(manifests)

      const folder = join(request.destinationDir, folderName)
      let present: Uint8Array | null = null
      let checked: PreparedDownload['checked'] = []
      let presentBytes = 0
      if (request.adopt) {
        const existing = await lstat(folder).catch(() => null)
        if (!existing?.isDirectory())
          throw new Error(`There is no folder named ${folderName} to install into.`)
        const found = await this.checkExisting(request.appId, layout, folder)
        present = found.present
        checked = found.checked
        presentBytes = found.presentBytes
        if (present.every((value) => value === 1)) {
          throw new Error('Everything in this folder is already up to date.')
        }
      }

      const warnings: string[] = []
      if (process.platform === 'win32') {
        const longest = Math.max(...layout.files.map((file) => join(folder, file.path).length))
        if (longest > WINDOWS_PATH_LIMIT) {
          warnings.push('Some paths in this game are longer than some Windows programs can open.')
        }
        if (layout.files.some((file) => file.kind === 'symlink')) {
          warnings.push(
            'This game has symbolic links, which Windows lets NetFuse create only with Developer Mode on.'
          )
        }
      }
      const downloadBytes = layout.units.reduce(
        (sum, unit, index) => (present?.[index] ? sum : sum + unit.compressedSize),
        0
      )
      const plan: SteamPlan = {
        planId: randomUUID(),
        appId: request.appId,
        appName: details.name,
        folderName,
        destinationDir: request.destinationDir,
        fileCount: layout.files.filter((file) => file.kind !== 'directory').length,
        downloadBytes,
        installBytes: layout.installBytes,
        freeBytes: await freeSpace(request.destinationDir),
        presentBytes,
        warnings
      }
      const now = Date.now()
      this.plans.set(plan.planId, {
        plan,
        request,
        branch: request.branch,
        buildId: branch?.buildId,
        depots: chosen.map((depot) => ({
          depotId: depot.depotId,
          manifestId: manifestFor(depot, request.branch)!.gid,
          name: depot.name
        })),
        manifests,
        layout,
        units: Uint32Array.from([...layout.units.keys()].filter((index) => !present?.[index])),
        folderName,
        checked,
        createdAt: now
      })
      this.expire(now)
      return plan
    } catch (error) {
      // Messages from the network and the libraries may carry tokens or request codes.
      if (error instanceof UnsafeLayoutError) throw error
      throw new Error(redactedMessage(error))
    }
  }

  /** A depot's manifest from the first server, on the first network, that sends it. */
  private async fetchManifest(
    servers: ServerPool,
    tokens: TokenCache,
    depotId: number,
    manifestId: string,
    requestCode: string
  ): Promise<Buffer> {
    const { networks, limits } = this.services
    const available = (await networks.refresh()).filter((network) => network.addresses.length > 0)
    let lastError: unknown = new Error('No network is connected.')
    for (const network of available) {
      const connection = new StreamConnection(() => networks.find(network.id), {
        timeoutMs: testKnobs.stallTimeoutMs,
        connectTimeoutMs: testKnobs.connectTimeoutMs
      })
      try {
        for (let slot = 0; slot < Math.min(MANIFEST_SERVERS, servers.servers.length); slot++) {
          const server = servers.pick(network.id, 0, slot, Date.now())
          // Most servers want no token; one that turns the request down gets one, once.
          for (let withToken = 0; withToken < 2; withToken++) {
            try {
              const token = withToken
                ? await tokens.get(depotId, server.vhost, Date.now())
                : undefined
              return await fetchBody({
                connection,
                url: manifestUrl(server, depotId, manifestId, requestCode, token),
                vhost: server.vhost,
                maxBytes: MAX_MANIFEST_DOWNLOAD,
                stallMs: testKnobs.stallTimeoutMs,
                signal: new AbortController().signal,
                throttle: (bytes) => limits.take(network.id, bytes)
              })
            } catch (error) {
              lastError = error
              const refused = error instanceof HttpStatusError && [401, 403].includes(error.status)
              if (!refused) break
            }
          }
        }
      } finally {
        connection.close()
      }
    }
    throw lastError
  }

  /**
   * What of `layout` is already in `folder`, correct: every chunk is read back and checked
   * against its id. A unit counts as present only if every place it is written to has it. A
   * link where the layout has a folder is refused outright: writing through it could reach
   * anywhere.
   */
  private async checkExisting(
    appId: number,
    layout: SteamLayout,
    folder: string
  ): Promise<{ present: Uint8Array; checked: PreparedDownload['checked']; presentBytes: number }> {
    const directories = new Set<string>()
    for (const file of layout.files) {
      const parts = file.path.split('/')
      for (
        let end = 1;
        end < (file.kind === 'directory' ? parts.length + 1 : parts.length);
        end++
      ) {
        directories.add(parts.slice(0, end).join('/'))
      }
    }
    for (const directory of directories) {
      const info = await lstat(join(folder, ...directory.split('/'))).catch(() => null)
      if (info && !info.isDirectory()) {
        throw new UnsafeLayoutError(
          `${directory} in this folder isn't a folder, but the game needs one there.`
        )
      }
    }

    // Each file's targets, so each file is opened once.
    const targetsByFile = new Map<number, { unit: number; offset: number }[]>()
    layout.units.forEach((unit, index) => {
      for (const target of unit.targets) {
        let list = targetsByFile.get(target.file)
        if (!list) targetsByFile.set(target.file, (list = []))
        list.push({ unit: index, offset: target.offset })
      }
    })
    // 0: not checked yet, 1: every target so far matches, 2: some target doesn't.
    const state = new Uint8Array(layout.units.length)
    const checked: PreparedDownload['checked'] = []
    const total = layout.installBytes
    let done = 0
    let reported = 0
    for (const [index, file] of layout.files.entries()) {
      if (file.kind !== 'file') continue
      const path = join(folder, ...file.path.split('/'))
      const info = await lstat(path).catch(() => null)
      const targets = targetsByFile.get(index) ?? []
      if (!info?.isFile()) {
        for (const target of targets) state[target.unit] = 2
        done += file.size
        continue
      }
      checked.push({ path, size: info.size, mtimeMs: info.mtimeMs })
      const handle = await open(path, 'r')
      try {
        for (const target of targets) {
          const unit = layout.units[target.unit]
          if (state[target.unit] === 2) continue
          const buffer = Buffer.allocUnsafe(unit.size)
          const { bytesRead } =
            target.offset + unit.size <= info.size
              ? await handle.read(buffer, 0, unit.size, target.offset)
              : { bytesRead: 0 }
          const matches =
            bytesRead === unit.size && matchesChunk(buffer, Buffer.from(unit.sha, 'hex'))
          state[target.unit] = matches ? 1 : 2
          done += unit.size
          if (done - reported > total / 100) {
            reported = done
            this.services.progress({ appId, step: 'checking', done, total })
          }
        }
      } finally {
        await handle.close()
      }
    }
    const present = state.map((value) => (value === 1 ? 1 : 0))
    let presentBytes = 0
    present.forEach((value, index) => {
      if (value) presentBytes += layout.units[index].size * layout.units[index].targets.length
    })
    return { present, checked, presentBytes }
  }
}
