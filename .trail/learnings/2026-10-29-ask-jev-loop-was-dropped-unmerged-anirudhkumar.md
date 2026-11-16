---
title: ask --jev/--loop was dropped unmerged; only its TS edge fix shipped
author: Anirudhkumar-nanonets
date: 2026-10-29
branch: claude/pr553-do-or-kill-c86764
cost: { minutes: 17, tokens: 193225 }
id: l-7d5ff80c
scope: repo
status: active
src: agent
touches:
  - src/graph/extract.ts
  - test/graph-bindings.test.ts
  - src/ask/ask.ts
---

## Decided
- Branch `wip/jev-ask` (b1be58dc, 15 Oct) was split on 2026-10-29: the TypeScript extractor fix (re-exports as `imports` edges, generic supertypes in `heritageEdges` via `tsSupertypeName`, src/graph/extract.ts) shipped in #726; the rest was left unmerged.
- `trail ask --jev` (seed/walk/prune: a model picks seeds from a wide lexical net, walks the call graph, prunes) and `--loop` (model-driven grep-and-read rounds), src/ask/jev-ask.ts, jev-loop.ts, jev-client.ts, ~1,000 lines, were not merged.

## Tried and ruled out
- Shipping `--jev`/`--loop` before launch: it puts an API key and network calls on `ask`, the agent's hot path, and no benchmark result shows it beating plain `ask`. To revive it, measure first (same-model A/B), then port from b1be58dc; `sliceSpan`/`inlineSource` in src/ask/ask.ts would need exporting again.
- The branch's `X-Graft-Watch` commit (fe30ead3): its file, src/brain/watch-trail.ts, was deleted in b92c22e.

## Watch out
- To measure an extractor change, run main's src/graph/extract.ts (copied beside it as a temp file so its relative imports resolve) and the new one over a repo's `git ls-files` and compare edge counts per relation. #726 added 73 import edges on Trail-Code and 171 on assign/frontend, with calls/contains/references unchanged.
