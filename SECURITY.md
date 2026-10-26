# Security policy

## Reporting a vulnerability

Please don't open a public issue for a security problem. Report it privately through GitHub instead: open the [Security tab](https://github.com/MerikhSS/NetFuse/security) and click **Report a vulnerability**. Only the maintainer can see the report.

A useful report includes:

- what an attacker can do, and what they need first (a crafted manifest or content server, code already running on the computer)
- the steps or a small test that shows it, and the NetFuse version and operating system
- a suggested fix, if you have one

## What to expect

NetFuse is maintained by one person, so these are aims rather than promises:

- a reply within a week
- an assessment, and a planned fix or an explanation, within a few weeks
- a new release once it's fixed, which reaches users through automatic updates

The advisory is published once the fix has been released, with credit to you unless you'd rather stay anonymous. Please keep the details private until then.

## Supported versions

Only the latest release gets security fixes. NetFuse updates itself, so most people are already on it.

## Scope

In scope:

- the NetFuse app for macOS, Windows, and Linux, including its Steam login, download and update code
- how it keeps the Steam login (the refresh token, sealed with the system keychain) and anything that could leak it, a password or a Steam Guard code
- the release workflows and build setup in this repository

Out of scope:

- problems in a dependency that NetFuse doesn't expose (please report those upstream)
- problems in Steam itself, which go to Valve
- a content server sending the wrong bytes, unless NetFuse makes it worse (every chunk is checked against its manifest before it is written, so writing a damaged one, or writing outside the install folder, is in scope)
