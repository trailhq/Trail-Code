---
title: A query-time rebuild in the MCP server kept ~2 GB for the whole session
author: Anirudhkumar-nanonets
date: 2026-10-29
branch: claude/trail-memory
cost: { minutes: 75, tokens: 296583 }
id: l-ab2df2b7
scope: repo
status: active
src: agent
touches:
  - src/graph/refresh.ts
  - src/graph/refresh-run.ts
  - src/graph/extract-cache.ts
  - src/graph/write.ts
  - src/ask/ask.ts
  - src/ask/index-file.ts
---

## Decided
- `ensureFreshGraph` rebuilds in a short-lived child (`src/graph/refresh-run.ts`) when the compiled script ships next to it; from source (the tests) it still builds in process. In process, the MCP server kept a rebuild's memory: 3.7 GB peak on assign (median of 3), 1.5 GB in a child.
- `wiring.json` and the extract cache are written with non-ASCII as `\uXXXX` (`asciiJson`, src/graph/write.ts). One non-ASCII character made V8 hold the whole file as a two-byte string: ~100 MB more per graph read, ~300 MB per extract-cache read.
- `ask` keeps only the query's terms (and their plural forms, as `hasTerm` checks them) from each sidecar doc; `writeAskIndex` and the extract cache are written piece by piece. All three give byte- or value-identical output.

## Tried and ruled out
- Releasing memory in the MCP server after idle: V8 gives back ~200 of ~590 MB in 30 s without a forced GC.

## Watch out
- Peak RSS moves ±200 MB from run to run with GC timing: compare medians of 3.
- Each built `dist/` has its own extractor stamp, so the first build with another copy of dist re-parses everything (23 s on assign instead of 6).
- Hook scripts can't be run by hand here (trail's PreToolUse guard): measure the commands the hooks start (`trail ask`, `trail build`, `readWiring`) instead.
