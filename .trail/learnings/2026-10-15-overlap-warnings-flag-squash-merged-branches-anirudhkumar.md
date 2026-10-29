---
title: Overlap warnings flag squash-merged branches as open work
author: Anirudhkumar-nanonets
date: 2026-10-15
branch: main
cost: { minutes: 121, tokens: 947825 }
touches:
  - src/ask/ask.ts
  - src/cli.ts
  - src/graph/extract.ts
  - test/graph-bindings.test.ts
  - ".github/copilot-instructions.md"
  - AGENTS.md
  - GEMINI.md
  - data/.web-token
  - data/share-link.txt
  - src/ask/jev-ask.ts
---

## Decided
- The overlap lines trail printed on 2026-10-15 were false alarms: fix/trail-release-prep (#595) and fix/npm12-grammars (#594) are merged and their changes are on main.
- Proposed, not yet approved: show an overlap only after Claude edits a function another open branch also changes, name that function and the branch's commit subject, and let Claude read the branch's diff and say in one line whether the two changes clash.

## Tried and ruled out
- File-level overlap from the prompt probe: it flags big shared files like src/cli.ts even when the prompt matched no code at all.

## Watch out
- Trail-Code squash-merges PRs and leaves branches on origin, so an ancestry check (`git merge-base --is-ancestor`) calls them unmerged, and `git cherry` misreports them too. Check the branch's PR state, or whether its diff is already on main.
