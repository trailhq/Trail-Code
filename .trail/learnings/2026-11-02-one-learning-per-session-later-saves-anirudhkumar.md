---
title: "One learning per session: later saves add to the session's file, a new branch starts a new one"
author: Anirudhkumar-nanonets
date: 2026-11-02
branch: claude/one-learning-per-session-9c2df4
cost: { minutes: 7, tokens: 128960 }
id: l-683afcd0
scope: repo
status: active
src: agent
touches:
  - src/notes/session-learning.ts
  - test/trail-note-session.test.ts
  - src/cloud/nudge.ts
  - test/trail-note-gate.test.ts
---

## Decided
- `trail note` folds a later save from the same Claude session into the file that session already wrote (`sessionLearning` and `addToLearning` in src/notes/session-learning.ts), section by section, keeping its title and id. The session is `sessionKey` (src/cloud/nudge.ts): CLAUDE_CODE_SESSION_ID, else the newest transcript.
- A new PR is known by its branch: a save on another branch starts a new file, because a second PR needs its own branch while review fixes stay on the first one.
- The session-to-file map is kept on the machine in `~/.trail/repos/<repo>/session-learnings.json`, not in the learning's front matter, because learnings are committed and a session id means nothing to a teammate.

## Tried and ruled out
- Starting a new file after a `gh pr create` shows up in the transcript: a review round on the same PR would split that PR's learning in two.

## Watch out
- Tests that spawn `trail note` inherit the developer's CLAUDE_CODE_SESSION_ID. Clear it in the child env (test/trail-note-gate.test.ts does), or a second save in one test adds to the first instead of hitting the repeat check.
- `--replaces` and `--always-follow` always write a new file, and an always-follow learning never takes plain findings.
