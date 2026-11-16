---
title: "Keep-sending tells a session grew by its file size, because its last-written time can move with nothing written"
author: Anirudhkumar-nanonets
date: 2026-11-13
branch: fix/share-sync-only-grown
id: l-c818dffb
scope: repo
status: active
src: agent
touches:
  - src/cli.ts
  - src/cloud/share-bundle.ts
  - src/cloud/share-sync-state.ts
  - src/cloud/share-sync.ts
  - test/share-session.test.ts
  - test/share-sync.test.ts
---

## Decided
- Keep-sending sends a session again only when its transcript file's size differs from the size it had when last sent. Claude Code only appends to a transcript, so a session that grew is longer; one that didn't change keeps its size whatever happens to its time.
- Sizes live in `~/.trail/share/sync.json` under `sizes`, beside the old `sessions` map of last-written times. That map stays, so an older trail on the same laptop still reads the state.
- A `sync.json` written before sizes were kept moves over without a re-send: a session whose time hasn't moved since it went gets its size written down as it is. One whose time has moved goes once more under the old rule, then by its size.

## Tried and ruled out
- Comparing last-written times, the first version: on 13 Nov one laptop re-sent 239 sessions (113 MB), and 232 of them were byte-identical to the copies sent on 6 Nov. Something on that Mac set session files' modified time to exactly 7 days before the moment it touched them, in batches, so each looked newer than the time recorded. It wasn't trail (its only utimes call is on its own session state and keeps the original time), the Claude hooks or plugins, or cron.
- Hashing every transcript on each run: it reads hundreds of MB at every session start, where the size is one stat.

## Watch out
- To tell a reset time from a real write, compare a transcript's change time (ctime) with its modified time: ctime minus mtime of exactly 7 days was the sign here.

In the code: src/cloud/share-sync.ts `grown`, `learnSizes`, `sentAs`; src/cloud/share-sync-state.ts `SyncState.sizes`; the first send seeds sizes in src/cli.ts from the manifest's `size` (src/cloud/share-bundle.ts `BundleItem.size`).
