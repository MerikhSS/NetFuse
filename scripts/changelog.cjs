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
