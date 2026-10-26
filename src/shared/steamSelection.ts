import type {
  SteamAppDetails,
  SteamArch,
  SteamDepot,
  SteamDepotManifest,
  SteamOs,
  SteamSelection
} from './steam'

// Which of an app's depots a download takes, worked out the same way in the window (to show the
// choice) and in the main process (to check it): pure, from the app's details alone.

/** The manifest a depot installs on `branch`, if it has one for it. */
export function manifestFor(depot: SteamDepot, branch: string): SteamDepotManifest | undefined {
  return depot.manifests[branch]
}

/** Why a depot can't be downloaded on `branch`, or null when it can. */
export function depotUnavailable(depot: SteamDepot, branch: string): string | null {
  if (!depot.owned) return 'Not owned by this account'
  if (depot.encryptedBranches.includes(branch) && !depot.manifests[branch]) {
    return 'Password-protected branches aren’t supported'
  }
  if (!manifestFor(depot, branch)) return 'Not part of this branch'
  return null
}

/**
 * The depots Steam itself would install for `selection`: owned, on the branch, for this system,
 * architecture and language (or for any), without low-violence versions unless asked for, and
 * without shared redistributables, which Steam installs on its own.
 */
export function defaultDepots(details: SteamAppDetails, selection: SteamSelection): number[] {
  return details.depots
    .filter((depot) => depotUnavailable(depot, selection.branch) === null)
    .filter((depot) => depot.oslist.length === 0 || depot.oslist.includes(selection.os))
    .filter((depot) => !depot.osarch || depot.osarch === selection.arch)
    .filter((depot) => !depot.language || depot.language === selection.language)
    .filter((depot) => !depot.lowViolence || selection.lowViolence === true)
    .filter((depot) => !depot.sharedInstall && depot.sharedFrom === undefined)
    .map((depot) => depot.depotId)
}

/** What Steam's language names mean, where they aren't plain English words. */
const LANGUAGE_NAMES: Record<string, string> = {
  schinese: 'Chinese (Simplified)',
  tchinese: 'Chinese (Traditional)',
  koreana: 'Korean',
  brazilian: 'Portuguese (Brazil)',
  portuguese: 'Portuguese (Portugal)',
  latam: 'Spanish (Latin America)',
  spanish: 'Spanish (Spain)'
}

/** A language as people name it: "latam" is Spanish (Latin America). */
export function languageName(language: string): string {
  return LANGUAGE_NAMES[language] ?? language[0].toUpperCase() + language.slice(1)
}

/** The language to start with: English, else whichever comes first. */
export function defaultLanguage(details: SteamAppDetails): string {
  return details.languages.includes('english') ? 'english' : (details.languages[0] ?? 'english')
}

/** A computer, as Steam names systems and architectures. */
export function steamSystem(platform: string, arch: string): { os: SteamOs; arch: SteamArch } {
  const os: SteamOs = platform === 'win32' ? 'windows' : platform === 'darwin' ? 'macos' : 'linux'
  return { os, arch: arch === 'ia32' || arch === 'arm' ? '32' : '64' }
}
