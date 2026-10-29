---
title: "The stale-learning check reads the touched file's text, not the code map, and judges touches only"
author: Anirudhkumar-nanonets
date: 2026-10-29
branch: claude/flag-stale-learnings-99579b
cost: { minutes: 30, tokens: 406072 }
id: l-3cfeb3b1
scope: repo
status: active
replaces: l-d70a9e57
src: agent
touches:
  - src/notes/stale.ts
  - src/cloud/workspace-sync.ts
  - src/notes/team-check.ts
  - src/telemetry/contract.ts
---

## Decided
- A learning "may be stale" when one of its `touches:` entries is gone (src/notes/stale.ts): a path the checkout no longer has, or a `file#Symbol` whose file's text no longer has the symbol's name as a whole word (`Type.method` → `method`). Trail Cloud has no code, so the CLI sends this list per learning at sync (`missing` on `PUT /api/cli/learnings`, `[]` = checked, left out for a teammate's branch copy) and the cloud shows what it gets. One rule, one place.
- The sync fingerprint includes `missing`, so a deleted file re-sends an unchanged learning.

## Tried and ruled out
- Looking symbols up in the code map (.trail/cache/.graph/wiring.json): about 0.4s per hook on this repo, nothing on a fresh clone, and the cloud can't state the same rule. Reading the one touched file takes ~2ms for all 29 learnings here and flags the same 3.
- Judging backticked names in a learning's body (`fooBar`, `foo()`): on 2026-10-29 it flagged 10 of 38 learnings across Trail-Code and assign, and 9 of those names were still in the code (interface properties like `costUsd`, module variables like `livePair`, Node built-ins like `execFileSync`).

## Watch out
- `trail note` records only files in `touches:`, so a learning that names a function only in its text is flagged only once the file goes. Recording `file#Symbol` for backticked names the graph knows (as `codeAnchors` in src/notes/team-check.ts already does for init) would let the check catch a deleted function.
- `learning_reused` left the code in #658 (2026-10-23); older installs still send it, so don't read it as current. The current reuse signal is `notes` (and now `stale`) on `query`.
