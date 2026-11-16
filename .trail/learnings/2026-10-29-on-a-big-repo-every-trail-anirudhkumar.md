---
title: "On a big repo, every trail process that loads the map costs over a gigabyte"
author: Anirudhkumar-nanonets
date: 2026-10-29
branch: claude/sync-crash-9a5d00
cost: { minutes: 60, tokens: 2179 }
id: l-c410f0a1
scope: repo
status: active
src: agent
touches:
  - src/util/state.ts
  - src/claude/sync-run.ts
  - src/graph/refresh.ts
  - src/graph/load.ts
---

## Decided
- The build lock (`src/util/state.ts`) is taken over only when its owner pid is gone and it is past `LOCK_STALE_MS`, or when it is past `LOCK_MAX_MS` (15 min) whoever holds it. Age alone let the next query take a first build's lock at 5 minutes (the build may run 10), and start a second full build beside it.
- `claude/sync-run.ts` writes its own pid into the lock (`claimLock`) before building: the query or Stop hook that took the lock exits at once, so its pid says nothing about whether a build is still running.
- sync-run lowers its priority (`os.setPriority`, PRIORITY_LOW); the `build` it starts inherits it. On an idle Mac an assign build took 22 s at nice 19 vs 23 s before.
- `build_completed.overlap` says another live process held this map's lock as the build started. It can't see two worktrees building at once: each has its own lock.

## Tried and ruled out
- Releasing the parsed graph in the MCP server after idle: dropping a parsed 98.6 MB wiring.json frees only ~200 MB of ~590 MB after 30 s; V8 keeps the rest without a forced GC.

## Watch out
- Measured on assign (12-core Mac, 98.6 MB wiring.json): a full build peaks at 2.15 GB, one `trail ask` after an edit at 1.29 GB, and an MCP server holds 1.24 GB after one call, for as long as the session lasts. A few Claude sessions on a big repo plus the end-of-turn build is enough to push an 8–16 GB laptop into swap; the lock fix doesn't change that.
- Running a local build (`node dist/cli.js ...`) rewrites `~/.trail/install.json` to point the global hooks at that build. Use a scratch HOME, or put it back afterwards.
