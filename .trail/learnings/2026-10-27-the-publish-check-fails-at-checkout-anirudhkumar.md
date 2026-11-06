---
title: The publish check fails at checkout when a PR conflicts with main
author: Anirudhkumar-nanonets
date: 2026-10-27
branch: feat/build-map-on-first-use
cost: { minutes: 9, tokens: 44925 }
id: l-e4c46258
scope: repo
status: active
src: agent
touches:
  - src/claude/hook-io.ts
  - src/claude/hooks.ts
  - src/claude/sync-run.ts
  - src/graph/refresh.ts
  - src/util/state.ts
  - test/claude-hooks.test.ts
  - test/graph-refresh.test.ts
---

## Decided
- On trailhq/Trail-Code, a red `publish` check whose log ends in `fatal: couldn't find remote ref refs/pull/<N>/merge` is not about the code. GitHub doesn't create a PR's merge ref while the PR conflicts with main, so `actions/checkout` fails three times and gives up. Merge main into the branch (never rebase or force-push), push, and the check runs again.

## Watch out
- Every child process a hook starts to run the trail CLI now goes through `src/claude/hook-io.ts` (`graftJson`, `graftJsonWithin`). `hooks.ts` and `prompt-hook.ts` no longer have their own. An env or flag that every hook child needs belongs there, as `GRAFT_FIRST_BUILD_WAIT_MS=0` does.
