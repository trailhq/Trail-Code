---
title: "Hooks in a Desktop worktree session see the main checkout as the project, so per-file paths miss"
author: Anirudhkumar-nanonets
date: 2026-10-30
branch: claude/overlap-warnings-go-live-b60dde
cost: { minutes: 6, tokens: 24540 }
id: l-4581e26a
scope: repo
status: active
src: agent
touches:
  - TELEMETRY.md
  - src/claude/hooks.ts
  - src/claude/overlap-telemetry.ts
  - src/claude/state.ts
  - src/notes/edit-overlap.ts
  - src/telemetry/contract.ts
  - test/trail-edit-overlap.test.ts
  - test/trail-overlap-telemetry.test.ts
---

## Decided
- In a Claude Desktop worktree session, `CLAUDE_PROJECT_DIR` (and so `projectDir()` in src/claude/hooks.ts) is the main checkout, while Claude edits the copy under `.claude/worktrees/<name>/`. Hook state (session files, stats.json) goes under the main checkout's `.trail/cache`.
- `editOverlap` now works out the repo from the edited file's own folder (`checkoutRoot(dirname(path))`) and reads the branch list from the project's checkout, which the session start refreshes. Worktrees share remote refs, so it's the same list. A file in another repo finds none of those branches there, since `git show <ref>:<path>` fails.

## Tried and ruled out
- Using the file's checkout only when its `repoPlace` key matched the project's: for a repo whose remote isn't a recognised URL, the key comes from the path, and git records a worktree's main checkout by its real path (`/private/var/...` vs `/var/...` on macOS), so the keys differed and the check fell back to the old behaviour.
- Running trail's hook script by hand to debug it: trail's own guard blocks that. Reading where the hook wrote its state (stats.json `lastFile`, the session file) showed which folder it took as the project.

## Watch out
- Any hook that gets a repo path with `relative(dir, path)` has the same blind spot: it yields `.claude/worktrees/<name>/src/...`, which never matches a path in a branch or a learning's `touches`. `learningsOnTouch` in src/claude/hooks.ts does this and wasn't fixed here.
