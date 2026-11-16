---
title: "Trail's Stop ask goes out as Stop feedback on Claude Code 2.1.163 and later, and as a block everywhere else"
author: Anirudhkumar-nanonets
date: 2026-11-16
branch: claude/elastic-lalande-660557
cost: { minutes: 12, tokens: 296121 }
id: l-70b23f3a
scope: repo
status: active
src: agent
touches:
  - src/claude/hook-io.ts
  - src/claude/note-signals.ts
  - src/claude/stop.ts
  - test/claude-hooks-skills.test.ts
  - test/claude-stop.test.ts
  - test/trail-note-ask.test.ts
---

## Decided
- Claude Code labels every Stop `decision: block` (and every exit 2) as an error: the terminal shows "Stop hook error: <reason>" in red plus a "Stop hook error occurred · ctrl+o to see" notice, and the model reads "Stop hook blocking error from command …". Teammates read trail's save ask as trail crashing.
- Since Claude Code 2.1.163 (its changelog), a Stop hook's `hookSpecificOutput: {hookEventName: "Stop", additionalContext}` keeps the turn going exactly like a block, shown as "Stop hook feedback: …" with no notice. So trail sends a Stop block that way whenever it can confirm the version, for the save ask and the skills offer alike.
- The Stop payload carries no version. Every transcript line does (`"version"`), so trail reads the last one from the transcript's last 256 KB. Unknown counts as old.

## Tried and ruled out
- Sending additionalContext to every host: builds before 2.1.163 would drop the ask, and Codex, Copilot CLI and Cursor share the same Stop writer and act on the block.
- A live `claude -p` run with a test Stop hook: the CLI's own login had expired on the machine, so the behaviour was read from the 2.1.317 binary instead (its Stop loop, transcript writer and renderers).

## Watch out
- The Stop after an additionalContext continuation still has `stop_hook_active: true`, and Claude Code's 8-in-a-row cap counts both forms.
- Under `--bare` (CLAUDE_CODE_SIMPLE=1) Claude Code ends the turn on a Stop's additionalContext instead of continuing. Bare runs skip settings hooks anyway, but trail keeps the block there.
- The ask no longer leaves an isMeta "Stop hook feedback" user line. It leaves an attachment `{type: "hook_additional_context", hookEvent: "Stop", content: [...]}`. Anything that reads the transcript for the ask must take both forms.

In the code: `stopTakesContext`, `transcriptVersion` and `STOP_CONTEXT_SINCE` in src/claude/stop.ts; `emitHook`'s `stopContext` option in src/claude/hook-io.ts; `stopFeedback` and `askAnswer` in src/claude/note-signals.ts.
