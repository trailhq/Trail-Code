---
title: "Skills tests that check what a prompt block says need the slowed deadline clock, or a busy machine drops the block"
author: Anirudhkumar-nanonets
date: 2026-11-02
branch: claude/learning-helped-feedback-e9a0c2
cost: { minutes: 20, tokens: 160372 }
id: l-0b58182d
scope: repo
status: active
src: agent
touches:
  - test/skills-session-start.test.ts
  - test/skills-prompt-fixtures.ts
  - src/claude/prompt-skills.ts
  - test/skills-prompt.test.ts
  - test/skills-prompt-attacks.test.ts
---

## Decided
Tests that call the prompt skills hook to check what a block says (not how fast it comes) pass the slowed deadline clock. On Windows CI it runs 4× slower, the same way #700 gave Windows more time. The hook has a 400 ms deadline on the wall clock. A slow shared Windows runner runs out of it, keeps no block, and an assert on the block's text then sees `undefined`.

## Tried and ruled out
- Treating a red Windows leg as caused by the PR: the J13 compaction test failed on a branch that never touched session start, and sibling branches passed Windows in the same hour.
- Running these tests locally to check the fix while many Claude sessions were running (load average ~195): skills-prompt and skills-session-start failed with or without the change. With the clock frozen they passed, which shows the deadline is the cause, not the code.

## Watch out
- About 15 other test files still call the prompt skills hook on the wall clock (skills-*, trace-multiturn, claude-hooks-1b). Any of them can flake the same way on a slow Windows runner. The fix is the same one line.
- The test of the deadline itself must keep the wall clock.

In the code: `deadlineClock` in test/skills-prompt-fixtures.ts (Date.now()/4 on win32 unless TRAIL_PERF=1); passed as `clock` in the deps of `promptSkills` (src/claude/prompt-skills.ts, PROMPT_DEADLINE_MS). Applied in test/skills-prompt.test.ts, test/skills-prompt-attacks.test.ts and test/skills-session-start.test.ts.
