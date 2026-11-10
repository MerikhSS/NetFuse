/*
 * What's new in each version: the top of its GitHub Release's notes (scripts/release-notes.mjs).
 * A version tag with no entry here doesn't build (.github/workflows/release.yml), so add the
 * entry in the same PR as the version bump, newest first.
 *
 * `kind` is one of new, faster, improved or fixed; `text` may wrap `code` in backticks.
 */
;(function (root) {
  'use strict'

  root.NetFuseChangelog = [
    {
      version: 'v0.5.0',
      items: [
        {
          kind: 'new',
          title: 'Workshops of games you don’t own on Steam',
          text: 'Have a game on GOG or Epic instead? Turn on “Games you don’t own” in the Workshop, and NetFuse lists the games whose Workshop Steam lets anyone download, through Steam’s anonymous account, as SteamCMD’s “login anonymous” does: Garry’s Mod, RimWorld, Stellaris, Terraria, Project Zomboid and many more. Steam keeps some games’ Workshops to their owners, and those aren’t listed.'
        }
      ]
    },
    {
      version: 'v0.4.0',
      items: [
        {
          kind: 'new',
          title: 'The Steam Workshop',
          text: 'A new Workshop tab lists the Workshop of every game you own that has one. Browse it by most popular, most subscribed, most recent or recently updated, or search it, and download mods, maps and more into a folder you pick, over every network at once. A game’s page has a Workshop button too. NetFuse doesn’t subscribe to items in Steam, so point the game at the folder the way it takes mods. Some older items, still in Steam’s old storage, are listed but can’t be downloaded.'
        }
      ]
    },
    {
      version: 'v0.3.2',
      items: [
        {
          kind: 'improved',
          title: 'Depots by name',
          text: 'A game’s page names each depot instead of giving its number: a DLC’s after the DLC (“Stellaris: Season 08 - Expansion Pass” rather than “Depot 2863190”), a shared one after its redistributable, and the game’s own after the game.'
        }
      ]
    },
    {
      version: 'v0.3.1',
      items: [
        {
          kind: 'fixed',
          title: 'Games with links on Windows',
          text: 'On Windows, a game whose files include links (shortcuts to other files in it) failed just as it finished, saying a file was in the way of a link. It now installs.'
        }
      ]
    },
    {
      version: 'v0.3.0',
      items: [
        {
          kind: 'improved',
          title: 'Half the download on Windows',
          text: 'There’s now an installer for each kind of PC: 118 MB for most PCs and 113 MB for ARM ones, instead of 240 MB for both together. The app is smaller on every system too.'
        },
        {
          kind: 'improved',
          title: 'Installing to another drive',
          text: 'Choosing a drive such as D:\\ in the installer now installs into a NetFuse folder on it, with no folder to make yourself.'
        }
      ]
    },
    {
      version: 'v0.2.0',
      items: [
        {
          kind: 'new',
          title: 'Help with an iPhone on Windows',
          text: 'Plug in an iPhone that Windows can’t use as a network yet, and NetFuse says what it takes, with a button to Apple Devices, Apple’s free app that brings the driver. It goes away by itself once the iPhone is a network, and Never show again turns it off.'
        }
      ]
    },
    {
      version: 'v0.1.0',
      items: [
        {
          kind: 'new',
          title: 'Your Steam library, over every network at once',
          text: 'Log in to Steam and NetFuse shows the games your account owns. Pick one and it downloads over Wi-Fi, Ethernet and a tethered phone together, each network pinned to its own connections.'
        },
        {
          kind: 'new',
          title: 'Installs where Steam would',
          text: 'Auto-detect finds your Steam libraries, and a game that is already partly there is checked and only what is missing is fetched.'
        },
        {
          kind: 'new',
          title: 'Safe to stop',
          text: 'Pause, quit or lose power: every chunk is verified before it is written, and the download carries on from where it was.'
        }
      ]
    }
  ]
})(module.exports)
