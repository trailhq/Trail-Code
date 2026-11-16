---
title: "In a Desktop worktree session, touch learnings come from both the main checkout and the worktree, and the main checkout's copy wins"
author: Anirudhkumar-nanonets
date: 2026-11-16
branch: claude/overlap-warnings-go-live-b60dde
cost: { minutes: 1, tokens: 2615 }
id: l-60f6d5d7
scope: repo
status: active
replaces: l-86c8e19d
src: agent
touches:
  - "src/claude/hooks.ts#learningsOnTouch"
  - "src/notes/home.ts#otherCheckout"
  - test/trail-learning-on-touch.test.ts
---

## Decided
- In a Claude Desktop worktree session the project (`CLAUDE_PROJECT_DIR`) is the main checkout and Claude works on the copy under `.claude/worktrees/<name>/`. Learnings on file touch now read both checkouts: the main checkout's (an uncommitted learning saved there still reaches the worktree session) and the worktree's own (a learning on the worktree's branch counts too).
- A learning in both checkouts (same file name) is taken from the main checkout. The session-start and prompt hooks read it from there, and the session remembers what it showed by the learning's path, so taking the worktree's copy would show it twice.
- The file is named from its own checkout through `otherCheckout(project, file)`, which reads the git files rather than running git, and compares the shared git dirs by the OS's real path so Windows short names don't hide a worktree.

## Tried and ruled out
- Main's version (#733): learnings from the main checkout only. A learning saved on the worktree's branch never reached Claude while it edited that branch.
- #738's first version: learnings from the worktree only. An uncommitted learning in the main checkout stopped reaching the session, and one in both would be shown twice.
- Main's same-repo check (`git rev-parse --git-common-dir` in each folder): it spawned git twice per touch outside the project and did the same job as `otherCheckout`, so the merge dropped it.

## Watch out
- `notesOnTouch` still gets the project dir for its stale check (`markStale`), so a learning about a file that exists only in the worktree can show as stale there. That should pass the file's checkout; it's left as a follow-up because it changes behaviour.

In the code:
- src/claude/hooks.ts `touchLearnings(dir, repo)` and `learningsOnTouch`
- test/trail-learning-on-touch.test.ts: the two worktree tests (an uncommitted learning in the main checkout; a learning on the worktree's branch, shown once)
