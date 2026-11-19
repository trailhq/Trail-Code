---
title: "Hooks in a Desktop worktree session see the main checkout as the project, so per-file paths need the file's own checkout"
author: Anirudhkumar-nanonets
date: 2026-10-30
branch: claude/overlap-warnings-go-live-b60dde
cost: { minutes: 14, tokens: 122118 }
id: l-86c8e19d
scope: repo
status: active
replaces: l-4581e26a
src: agent
touches:
  - TELEMETRY.md
  - src/claude/hooks.ts
  - src/notes/home.ts
  - src/telemetry/contract.ts
  - test/telemetry-contract.test.ts
  - test/trail-learning-on-touch.test.ts
---

## Decided
- In a Claude Desktop worktree session, `CLAUDE_PROJECT_DIR` (and so `projectDir()` in src/claude/hooks.ts) is the main checkout, while Claude edits the copy under `.claude/worktrees/<name>/`. Hook state (session files, stats.json) goes under the main checkout's `.trail/cache`.
- Per-file hooks find the file's own checkout with `otherCheckout(project, file)` (src/notes/home.ts): the checkout the file is in when it's another checkout of the same repo, else null. `editOverlap` compares branches from it, reading the branch list from the project's checkout, which the session start refreshes (worktrees share remote refs). `learningsOnTouch` names the file, and reads learnings, from it, so a learning on the worktree's branch counts.

## Tried and ruled out
- Comparing `repoPlace` keys to decide "same repo": for a repo whose remote isn't a recognised URL the key comes from the path, and git records a worktree's main checkout by its real path (`/private/var/...` vs `/var/...` on macOS), so the keys differed. `otherCheckout` compares the shared git dirs by `realpathSync` instead.
- Plain `checkoutRoot(dirname(file))` with no same-repo check: fine for overlap, since another repo's git has none of the cached branches, but `learningsOnTouch` would then read another repo's learnings for a file Claude opened there.
- Running trail's hook script by hand to debug it: trail's own guard blocks that. Reading where the hook wrote its state (stats.json `lastFile`, the session file) showed which folder it took as the project.

## Watch out
- Any other hook that gets a repo path with `relative(dir, path)` has the same blind spot: it yields `.claude/worktrees/<name>/src/...`, which never matches a path in a branch or a learning's `touches`. Bash commands are fine, since they run in the worktree.
- #731 passes `dir` to `notesOnTouch` for its stale check; once both are in, that call should pass the file's checkout.
