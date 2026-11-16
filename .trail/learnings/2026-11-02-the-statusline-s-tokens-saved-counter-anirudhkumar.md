---
title: "The statusline's tokens-saved counter counts learnings the hooks hand over, not only trail call output"
author: Anirudhkumar-nanonets
date: 2026-11-02
branch: claude/savings-counter-long-sessions-9c5908
cost: { minutes: 10, tokens: 217288 }
id: l-d04e98d3
scope: repo
status: active
src: agent
touches:
  - src/claude/session-metrics.ts
  - src/claude/hooks.ts
  - src/claude/prompt-hook.ts
  - test/hook-savings.test.ts
---

## Decided
- A learning the prompt hook or the file-touch hook puts in front of the agent adds its `[trail] learnings saved ≈ N` line to the session's `savedTokens`, the same line `trail ask` prints and the tool-savings hook already counted. Each learning reaches a session once (`injectedNotes`), so each is counted once by the hooks.
- Why: past a session's first hour the agent mostly edits, tests, runs `trail check` and `trail note`, none of which prints a savings line, while the hooks keep bringing learnings. The statusline sat on the number from the first few `trail ask` calls for hours or days.

## Tried and ruled out
- A cap on how much transcript is read, a cache keyed on something that stops changing, a total computed once: none of these. Replaying 24 long transcripts, the stored `savedTokens` equalled the sum of savings lines in tool results exactly in 21. Of the other three, one ran trail in subagents (their transcripts are separate files under `<session>/subagents/`) and two each lost one trail call's savings, for a reason not found. The counter was right about what it counted; it just never counted the hook copies.
- A transcript replay double counts forked sessions (a fork's file repeats the parent's history with the new session id). Leave them out of any comparison.

## Watch out
- A learning shown by a hook and again in a `trail ask` answer counts twice, as two asks returning the same learning always did.
- In a replay, count `hook_additional_context` attachments only: the same text also lands as `hook_success`.

In the code: `addHookSavings` (src/claude/session-metrics.ts), called from `handlePrompt` (src/claude/prompt-hook.ts) and `learningsOnTouch` (src/claude/hooks.ts); test/hook-savings.test.ts.
