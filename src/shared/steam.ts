// What the window is told about Steam: who is logged in, what they own, and what an app is made
// of. Nothing here is a secret — never a password, token, code or depot key (see main/steam).

/** What a Steam download or request says when it needs a login: the window offers one. */
export const STEAM_LOGIN_REQUIRED = 'Log in to Steam to continue.'

export type SteamOs = 'windows' | 'macos' | 'linux'
export type SteamArch = '32' | '64'

export interface SteamBranch {
  name: string
  buildId: string
  description?: string
  /** A password-protected (private) branch: listed, but NetFuse doesn't download those. */
  passwordRequired: boolean
  /** Seconds since the epoch. */
  updatedAt?: number
}

export interface SteamDepotManifest {
  /** The manifest's id, in decimal. */
  gid: string
  /** Bytes on disk, when appinfo says. */
  size?: number
  /** Bytes to download, when appinfo says. */
  download?: number
}

export interface SteamDepot {
  depotId: number
  name: string
  /** The systems it is for; empty means every one. */
  oslist: SteamOs[]
  osarch?: SteamArch
  /** The language it is for; undefined means every one. */
  language?: string
  lowViolence: boolean
  /** It belongs to this DLC: installed only with the DLC owned. */
  dlcAppId?: number
  /** Its content comes from another app's depot (a shared redistributable, usually). */
  sharedFrom?: number
  /** Steam installs it once for every game that uses it (a redistributable). */
  sharedInstall: boolean
  /** By branch name. */
  manifests: Record<string, SteamDepotManifest>
  /** Branches whose manifest id is encrypted with the branch password. */
  encryptedBranches: string[]
  /** The account holds a license for it; set by the library, not appinfo. */
  owned: boolean
  /** That license is borrowed through Steam Family Sharing. */
  borrowed?: boolean
}

export interface SteamAppDetails {
  appId: number
  name: string
  type: string
  /** The folder Steam would install it in, as appinfo names it. */
  installDir: string
  branches: SteamBranch[]
  depots: SteamDepot[]
  /** Every language it can be installed in, sorted: those of its language depots, and those its
   * other depots are in (its base languages, usually English). */
  languages: string[]
  /** The depot its Workshop items' files are in (see main/steam/workshop.ts). */
  workshopDepot: number
}

export interface SteamOwnedApp {
  appId: number
  name: string
  /** As appinfo has it, lower-cased: game, application, tool, demo, dlc, … */
  type: string
  /** The license is borrowed through Steam Family Sharing. */
  borrowed: boolean
  /** It has a Steam Workshop, which the Workshop tab lists. */
  workshop: boolean
}

/** What the user chose for an app: the default depots follow from it (see defaultDepots). */
export interface SteamSelection {
  branch: string
  os: SteamOs
  arch: SteamArch
  language: string
  lowViolence?: boolean
}

/** Where logging in to Steam has got to. Never carries a password, code or token. */
export type SteamLoginState =
  | {
      status: 'logged-out'
      /** Why the last attempt, or the stored login, didn't work. */
      error?: string
      /** Whether a login can be remembered on this computer (it needs the system keychain). */
      canRemember: boolean
    }
  | { status: 'connecting' }
  | {
      status: 'awaiting-code'
      /** Where the code comes from: the account's email, or the Steam Mobile App. */
      via: 'email' | 'device'
      emailDomain?: string
      /** The mobile app can approve the login instead of a code being typed. */
      canConfirm: boolean
      error?: string
    }
  | { status: 'awaiting-confirmation'; via: 'email' | 'device' }
  | {
      status: 'awaiting-qr'
      /** The QR code's modules, row by row (true is dark). */
      qr: boolean[][]
      /** Scanned: the user is approving it on their phone. */
      scanned: boolean
    }
  | { status: 'logged-in'; accountName: string; remembered: boolean }

export type SteamLoginRequest =
  | { method: 'credentials'; accountName: string; password: string; remember: boolean }
  | { method: 'qr'; remember: boolean }

export interface SteamPrepareRequest {
  appId: number
  branch: string
  depotIds: number[]
  destinationDir: string
  /** Install into `destinationDir/<folder>` that already exists: what is there and correct is
   * kept, and only what's missing or different is fetched. */
  adopt: boolean
}

/** How a game's Workshop is listed, in Steam's own orders. */
export type WorkshopSort = 'popular' | 'subscribed' | 'recent' | 'updated'

export interface WorkshopQuery {
  appId: number
  sort: WorkshopSort
  /** Words to look for: the items come in order of how well they match, whatever `sort`. */
  search?: string
  /** Where the page before ended (WorkshopPage.nextCursor); absent for the first. */
  cursor?: string
}

/** A Workshop item, as the Workshop tab lists it. */
export interface WorkshopItem {
  /** Steam's id for it: a 64-bit number, in decimal. */
  publishedFileId: string
  /** The game it is for. */
  appId: number
  title: string
  /** A few sentences, as plain text. */
  description: string
  /** Bytes, as Steam lists it. */
  size: number
  /** Seconds since the epoch. */
  updatedAt: number
  subscriptions: number
  tags: string[]
  /** Its files are on Steam's content servers, where NetFuse fetches them from. An item kept in
   * Steam's old Workshop storage isn't. */
  downloadable: boolean
}

export interface WorkshopPage {
  items: WorkshopItem[]
  /** How many match, as Steam counts them. */
  total: number
  /** Where the next page starts; absent after the last. */
  nextCursor?: string
}

/** A Workshop item to download into a folder of the user's choosing. */
export interface WorkshopPrepareRequest {
  appId: number
  publishedFileId: string
  destinationDir: string
  /** Update `destinationDir/<folder>` that already exists, as SteamPrepareRequest.adopt does. */
  adopt: boolean
}

/** A Steam library on this computer, as a folder to save a game to. */
export interface SteamLibraryFolder {
  /** Where the library keeps its games: <library>/steamapps/common. */
  path: string
  /** Free on its drive; null when it can't be told. */
  freeBytes: number | null
  /** The game asked about is already in it, in the folder Steam would use. */
  hasGame: boolean
}

/** A download worked out and ready to start: startDownload takes its id. */
export interface SteamPlan {
  planId: string
  appId: number
  appName: string
  /** The install folder's name, in destinationDir. */
  folderName: string
  destinationDir: string
  fileCount: number
  /** What is fetched: compressed and encrypted, as content servers send it. */
  downloadBytes: number
  /** What the install takes on disk. */
  installBytes: number
  /** Free on the destination's drive; null when it can't be told. */
  freeBytes: number | null
  /** Bytes already on disk and correct (installing over an existing folder). */
  presentBytes: number
  warnings: string[]
}

export interface SteamPrepareProgress {
  appId: number
  step: 'manifests' | 'checking'
  done: number
  total: number
}
