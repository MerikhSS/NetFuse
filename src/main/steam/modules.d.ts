// The part of steam-user NetFuse calls, typed. steam-user ships no types, and @types/steam-user
// lags behind it; declaring only what is used keeps the surface small and visible (see
// steamUserBackend.ts, the only file that loads it).

declare module 'steam-user' {
  import { EventEmitter } from 'node:events'

  interface SteamUserOptions {
    /** null: steam-user saves nothing to disk (no depot keys, machine ids or cell ids). */
    dataDirectory: string | null
    autoRelogin?: boolean
    enablePicsCache?: boolean
    changelistUpdateInterval?: number
    saveAppTickets?: boolean
    renewRefreshTokens?: boolean
  }

  interface License {
    package_id: number
    flags: number
    license_type: number
    access_token?: string | number
  }

  interface ProductInfo {
    apps: Record<string, { changenumber: number; missingToken: boolean; appinfo: unknown }>
    packages: Record<string, { changenumber: number; missingToken: boolean; packageinfo: unknown }>
    unknownApps: number[]
    unknownPackages: number[]
  }

  interface RawContentServer {
    type: string
    sourceid: number
    cell: number
    load: number
    weightedload: number
    Host: string
    vhost?: string
    https_support?: string
    allowed_app_ids?: number[]
  }

  class SteamUser extends EventEmitter {
    constructor(options?: SteamUserOptions)
    steamID: { getSteamID64(): string } | null
    licenses: License[] | null
    logOn(details: { refreshToken: string } | { anonymous: true }): void
    logOff(): void
    getProductInfo(
      apps: (number | { appid: number; access_token: string })[],
      packages: (number | { packageid: number; access_token: string })[],
      inclTokens?: boolean
    ): Promise<ProductInfo>
    getDepotDecryptionKey(appId: number, depotId: number): Promise<{ key: Buffer }>
    getManifestRequestCode(
      appId: number,
      depotId: number,
      manifestId: string,
      branchName: string,
      branchPassword?: string | null
    ): Promise<{ requestCode: string | number }>
    getContentServers(appId?: number): Promise<{ servers: RawContentServer[] }>
    getCDNAuthToken(
      appId: number,
      depotId: number,
      hostname: string
    ): Promise<{ token: string; expires: Date }>
    getPublishedFileDetails(ids: string[]): Promise<{ files: Record<string, unknown> }>
    /** Internal: sends a message, and calls back with the answer (undecoded when steam-user has
     * no type for it). Used only for service calls steam-user has no wrapper for. */
    _send(
      header: { msg: number; proto: { target_job_name: string } },
      body: Buffer,
      callback: (
        body: Buffer | { toBuffer(): Buffer },
        header?: { proto?: { eresult?: number } }
      ) => void
    ): void
  }

  export = SteamUser
}

/** steam-user's protobuf message types (protobuf.js), by name. */
declare module 'steam-user/protobufs/generated/_load.js' {
  interface ProtoMessage {
    encode(data: object): { finish(): Uint8Array }
    decode(bytes: Uint8Array): object
    toObject(message: object, options: { longs: StringConstructor }): Record<string, unknown>
  }
  const Schema: Record<string, ProtoMessage>
  export = Schema
}
