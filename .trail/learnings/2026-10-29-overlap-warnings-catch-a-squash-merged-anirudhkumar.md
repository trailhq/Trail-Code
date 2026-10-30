---
title: Overlap warnings catch a squash-merged branch with git log -S on the lines it added
author: Anirudhkumar-nanonets
date: 2026-10-29
branch: claude/overlap-warnings-go-live-b60dde
cost: { minutes: 30, tokens: 274804 }
id: l-7d9e9d4d
scope: repo
status: active
src: agent
touches:
  - src/notes/edit-overlap.ts
  - src/claude/overlap-telemetry.ts
  - src/claude/state.ts
  - src/claude/hooks.ts
---

## Decided
- `functionOverlaps` (src/notes/edit-overlap.ts, `landedSince`) drops a function when each of the three longest lines (12+ characters) the branch added to it was also added on the default branch since the two parted (`git log -S<line> fork..origin/main -- file`). It needs no gh, works on any host, and costs about 7 ms, only for a function both changes land in.
- Measured on Trail-Code on 2026-10-29, seen by a teammate with no branches of their own: with gh's closed-PR list, real warnings went from 48% to 84% (179 to 102); without gh, from 32% to 93% (266 to 90). None of the 86 warnings about branches with an open PR were dropped.
- `overlap_warned` and `overlap_acted` (src/claude/overlap-telemetry.ts) carry only `pr` (open/none/unknown, from the `open` list the branch cache now keeps). "Acted" means a later prompt in that session names the teammate or their branch. The function's name doesn't count: the person is editing that function anyway.

## Tried and ruled out
- Comparing the function's text on the branch with main's: it dropped only 119 of 182 warnings about merged branches, because main often changes the function again after the merge.
- Requiring each added line to still be in main's version of the function: the same miss.

## Watch out
- Without gh, merged branches fill the 30-branch cap (`MAX_BRANCHES`, newest first) and push real open branches out of the cache. `landedSince` runs per edit, so it can't bring them back.
- With gh, the false alarms left are branches with no PR that went quiet (feat/trail-all, 22 days old; wip/jev-ask). Fixing them needs a rule like "no open PR and idle for a week", using the cache's `open` list.
- A squash-merged change made only of short lines (under 12 characters) still warns: short lines never decide that a change landed.
