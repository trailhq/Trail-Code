---
title: "trail's hook rewrite after an upgrade wipes any hook that calls its shim unless the rewrite exempts it"
author: Anirudhkumar-nanonets
date: 2026-11-16
branch: fix/share-sync-hook-survives-upgrade
id: l-6bbfddcd
scope: repo
status: active
src: agent
touches:
  - src/hosts/config-write.ts
  - src/claude/settings-merge.ts
  - src/upkeep.ts
  - src/cloud/share-hook.ts
  - src/claude/hooks.ts
  - test/share-hook.test.ts
---

## Decided
- After an upgrade, the first Claude Code session in each set-up repo rewrites trail's user-level hooks in `~/.claude/settings.json`. It treats every entry that calls trail's shim as trail's own and replaces the whole set. share-session's keep-sending hook calls the same shim, so it was silently removed. The rewrite now exempts that one entry; only `--stop` and `--delete` take it out.
- Any future user-level hook that calls the shim because a person opted in needs the same exemption, or the first session after the next upgrade removes it.

## Tried and ruled out
- Changing the shared "is this trail's entry" check to leave the share-sync hook out. Every hook installer uses that check (Codex, Cursor, the repo settings merges), so the exemption sits only in the user-level rewrite.

## Watch out
- When `trail share-session` prints "put its hook back", the hook had been removed: this bug, on versions before the fix.
- trail's own session-start hook also starts the sync, so a missing share-sync hook only stops syncing where trail's user-level hooks aren't installed.
- A sync that looks stalled usually means no new Claude Code session has started yet: it sends a session again only after it grew and sat idle for 10 minutes, and only from a session start.

In the code: src/hosts/config-write.ts `isGraftEntry` and `isShareSyncEntry`; src/claude/settings-merge.ts `mergeGraftHooks`; src/upkeep.ts (rewires when the repo's wiring stamp version differs from the running one); src/cloud/share-hook.ts; src/claude/hooks.ts `main` (the share-sync and session-start events both call `maybeShareSyncInBackground`); test/share-hook.test.ts.
