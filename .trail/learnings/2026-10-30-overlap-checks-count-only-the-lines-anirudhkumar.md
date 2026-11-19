---
title: "Overlap checks count only the lines an edit changed, and a function's doc comment is part of it"
author: Anirudhkumar-nanonets
date: 2026-10-30
branch: claude/overlap-warnings-go-live-b60dde
cost: { minutes: 14, tokens: 778179 }
id: l-287c8038
scope: repo
status: active
src: agent
touches:
  - TELEMETRY.md
  - src/claude/hooks.ts
  - src/notes/home.ts
  - src/telemetry/contract.ts
  - test/telemetry-contract.test.ts
  - test/trail-learning-on-touch.test.ts
  - src/notes/edit-overlap.ts
  - test/trail-edit-overlap.test.ts
  - src/telemetry/track.ts
---

## Decided
An overlap check counts only the lines an edit actually changed, and a comment block directly above a function is part of that function. Found in a live test in a Claude Desktop worktree session (30 Oct): Claude, asked to add a comment at the top of a Go function a teammate's open branch changes, put a doc comment above `func` and anchored its Edit on the `}` closing the struct above. The edit's new text covered the struct's last line through the `func` line, the smallest symbol it touched was the 7-line struct, and no warning fired.

## Tried and ruled out
Counting every symbol an edit's range touches instead of the smallest: it would have warned about the struct above too, which nobody changed in that way; anchor lines would keep naming the neighbour of every edit.

## Watch out
Claude's Edit almost always repeats a line or two it doesn't change, to make `old_string` unique. Go doc comments and JSDoc sit outside the span tree-sitter gives a function, so without the comment rule an edit to only the comment lands in no symbol.

In the code: `anchors` and `editedLines` in src/notes/edit-overlap.ts drop the lines `new_string` keeps from `old_string` at either end (a deletion between kept lines marks the two, as `changedLines` does); `withComment` in `symbolsIn` moves each symbol's start up over the comment lines directly above it, so `landedIn` and `addedTo` both see it.
