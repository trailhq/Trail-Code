---
title: "The stale-learning check judges touches only; names in a learning's text were nearly all false hits"
author: Anirudhkumar-nanonets
date: 2026-10-29
branch: claude/flag-stale-learnings-99579b
cost: { minutes: 24, tokens: 329816 }
id: l-d70a9e57
scope: repo
status: active
src: agent
touches:
  - src/notes/stale.ts
  - src/notes/notes.ts
  - src/notes/team-check.ts
  - src/telemetry/contract.ts
---

## Decided
- A learning "may be stale" when one of its `touches:` entries is gone (src/notes/stale.ts): a file the checkout no longer has, or a `file#Symbol` whose name no code-map symbol has (a moved symbol still counts). Trail Cloud's "Stale-learning cleanup" check follows the same rule; change both together.
- Files are checked on disk, not in the code map: loading .trail/cache/.graph/wiring.json costs about 0.4s on this repo, too much for a hook. The map is read only for a symbol touch, and `markStale` runs only on the learnings about to be shown.

## Tried and ruled out
- Judging backticked names in a learning's body (`fooBar`, `foo()`) against code-map symbols: on 2026-10-29 it flagged 10 of 38 learnings across Trail-Code and assign, and 9 of those names were still in the code (interface properties like `costUsd`, module variables like `livePair`, Node built-ins like `execFileSync`). The code map lists functions, classes and types, never properties or variables.

## Watch out
- `trail note` records only files in `touches:`, so a learning that names a function only in its text is flagged only once the file goes. Recording `file#Symbol` for backticked names the graph knows (as `codeAnchors` in src/notes/team-check.ts already does for init) would let the check catch a deleted function.
- `learning_reused` was removed from the code in #658 (2026-10-23), but older installs still send it: 106,783 events from 771 people in the 7 days to 2026-10-29. Current versions signal reuse with `notes` (and now `stale`) on `query`.
