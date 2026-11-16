---
title: "A file whose parse failed is parsed again on the next build, never replayed from cache"
author: Shrish
date: 2026-11-09
branch: fix/strict-test-after-reparse
cost: { minutes: 4, tokens: 26578 }
id: l-e45c00b0
scope: repo
status: active
src: agent
touches:
  - test/cli-structural-failure.test.ts
  - src/graph/extract.ts
  - src/graph/resolve.ts
  - test/graph-imported-call-mcp.test.ts
  - test/graph-resolve-imported-calls.test.ts
  - test/graph-traverse-cli.test.ts
  - README.md
  - src/graph/generic.ts
  - src/graph/queries/julia.scm
  - test/generic-extract.test.ts
---

## Decided
An incremental build re-parses any file whose cached entry holds a parse error, even when the file is unchanged. The failure can belong to the run (a WASM grammar aborting after the heap ran out) rather than to the bytes, and replaying it kept a healthy file missing from the graph forever (#312, landed as #791).
The cost is that a file whose grammar always throws is re-parsed on every build. That's accepted: such files are rare, and the error is still reported each time.

## Watch out
Tests that expect "parsed: 0 of N (N replayed from cache)" after a failure are wrong now. With an injected failure only on the first run, the second build re-parses the file and succeeds, so `--strict` passes. To test `--strict` on an incremental build, keep the failure injected on the second run too. #789's test assumed replay and turned main red once both PRs merged.

In the code: src/graph/build.ts (cache reuse skips entries with `error`), test/generic-extract.test.ts (#139 case now expects parsed === 1), test/cli-structural-failure.test.ts (incremental --strict test).
