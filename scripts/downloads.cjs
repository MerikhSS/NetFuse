/*
 * What a GitHub Release's notes say about each file we ship (see release-notes.mjs). The tests load
 * it with require() too.
 *
 * Everything is derived from the release's file names (see electron-builder.yml for how they're
 * made), so a file that isn't recognised — update metadata, blockmaps, a snap — is simply left
 * out, and a new build shows up as soon as its name says what it is.
 */
;(function (root) {
  'use strict'

  var OS_ORDER = ['mac', 'win', 'linux']
  var OS_LABEL = { mac: 'macOS', win: 'Windows', linux: 'Linux' }

  // What an installer that isn't code-signed (Windows) makes the OS say on first launch, and the
  // way past it. `code` in backticks, **button names** in stars.
  var FIRST_LAUNCH = {
    win: {
      system: 'Windows',
      warning: 'Windows protected your PC',
      fix: 'The installer just isn’t code-signed yet. Click **More info**, then **Run anyway**.',
      command: null,
      aside: 'If your browser warns that the file isn’t commonly downloaded, choose **Keep** first.'
    }
  }

  // Listed under each OS's downloads. `code` spans are wrapped in backticks.
  var NOTES = {
    mac: [
      'Not sure which Mac you have? Apple menu → About This Mac: “Chip: Apple M…” is Apple silicon, “Processor: Intel…” is Intel.'
    ],
    win: [
      'Not sure which PC you have? Settings → System → About: “System type” says x64-based or ARM-based. Most PCs are x64.'
    ],
    linux: [
      'AppImage: `chmod +x netfuse-*.AppImage`, then run it. Recent Ubuntu needs FUSE 2 first: `sudo apt install libfuse2t64` (older releases call it `libfuse2`) — or use the .deb, which needs nothing extra.',
      '.deb: `sudo apt install ./netfuse_*.deb`.',
      '.rpm (Fedora / RHEL): `sudo dnf install ./netfuse-*.rpm`.',
      '.tar.gz (Arch, or anywhere without FUSE): `tar xzf netfuse-*.tar.gz`, then run `./netfuse` inside the extracted folder.',
      'Don’t open the AppImage with Disks (it isn’t a disk image — an “image is smaller than the target device” message means it was opened there). Make it executable and run it as above.',
      'Using more than one network needs Linux kernel 5.7 or newer (any current distro); on older kernels NetFuse can only use the default network.'
    ]
  }

  /** Says what a release file is, from its name; null for anything we don't offer as a download. */
  function describe(name) {
    var n = String(name).toLowerCase()
    var arch = /(arm64|aarch64)/.test(n) ? 'arm64' : /(x86_64|x64|amd64)/.test(n) ? 'x64' : 'any'

    if (/\.dmg$/.test(n)) {
      if (arch === 'arm64') return mk('mac', arch, 'dmg', 'Apple silicon', 'M1 and later · .dmg', 0)
      if (arch === 'x64') return mk('mac', arch, 'dmg', 'Intel', 'Intel Macs · .dmg', 1)
      return mk('mac', arch, 'dmg', 'macOS', '.dmg', 2)
    }
    if (/\.exe$/.test(n)) {
      // Installers up to 0.2.0 held both architectures, with none in their name.
      if (arch === 'any') {
        return mk('win', arch, 'exe', 'Windows 10 and 11', 'Installer · x64 and ARM64', 0)
      }
      if (arch === 'x64') {
        return mk('win', arch, 'exe', 'Windows · x64', 'Installer · Intel and AMD PCs', 1)
      }
      return mk('win', arch, 'exe', 'Windows on ARM', 'Installer · ARM PCs', 2)
    }
    if (/\.appimage$/.test(n)) {
      return mk(
        'linux',
        arch,
        'appimage',
        'AppImage' + archSuffix(arch),
        'Runs on any distro, no install',
        arch === 'arm64' ? 3 : 0
      )
    }
    if (/\.deb$/.test(n)) {
      return mk(
        'linux',
        arch,
        'deb',
        'Debian / Ubuntu' + archSuffix(arch),
        '.deb package · Debian, Ubuntu, Mint',
        arch === 'arm64' ? 4 : 1
      )
    }
    if (/\.rpm$/.test(n)) {
      return mk(
        'linux',
        arch,
        'rpm',
        'Fedora / RHEL' + archSuffix(arch),
        '.rpm package · Fedora, RHEL, openSUSE',
        arch === 'arm64' ? 5 : 2
      )
    }
    if (/\.tar\.gz$/.test(n)) {
      return mk(
        'linux',
        arch,
        'tarball',
        'Archive' + archSuffix(arch),
        '.tar.gz · extract and run, no FUSE',
        arch === 'arm64' ? 7 : 6
      )
    }
    return null
  }

  function archSuffix(arch) {
    return arch === 'arm64' ? ' · ARM64' : arch === 'x64' ? ' · x86_64' : ''
  }

  function mk(os, arch, kind, title, detail, sort) {
    return { os: os, arch: arch, kind: kind, title: title, detail: detail, sort: sort }
  }

  function formatSize(bytes) {
    if (!bytes) return ''
    var mb = bytes / 1048576
    return mb >= 1024 ? (mb / 1024).toFixed(2) + ' GB' : mb.toFixed(mb >= 100 ? 0 : 1) + ' MB'
  }

  /**
   * The downloads table for a GitHub Release's notes, by OS, with what each OS needs to know.
   * `files` is [{ name, size, url }].
   */
  function markdown(files) {
    var assets = files
      .map(function (f) {
        var d = describe(f.name)
        if (!d) return null
        d.sizeText = formatSize(f.size)
        d.url = f.url
        return d
      })
      .filter(Boolean)
    var out = ['## Downloads', '']
    OS_ORDER.forEach(function (os) {
      var rows = assets
        .filter(function (a) {
          return a.os === os
        })
        .sort(function (a, b) {
          return a.sort - b.sort
        })
      if (!rows.length) return
      out.push('**' + OS_LABEL[os] + '**', '', '| Download | For | Size |', '|---|---|---|')
      rows.forEach(function (r) {
        out.push('| [' + r.title + '](' + r.url + ') | ' + r.detail + ' | ' + r.sizeText + ' |')
      })
      out.push('')
      var launch = FIRST_LAUNCH[os]
      if (launch) out.push('**' + launch.warning + '?** ' + launch.fix.replace(/\*\*/g, ''), '')
      NOTES[os].forEach(function (note) {
        out.push('- ' + note)
      })
      out.push('')
    })
    return out.join('\n').trimEnd()
  }

  root.NetFuseDownloads = {
    describe: describe,
    markdown: markdown,
    formatSize: formatSize
  }
})(module.exports)
