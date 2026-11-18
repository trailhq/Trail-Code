---
title: "Without a live Claude Code run, check trail's Stop ask by replaying the real transcripts already on the machine"
author: Anirudhkumar-nanonets
date: 2026-11-18
branch: claude/elastic-lalande-660557
cost: { minutes: 8, tokens: 172177 }
id: l-14ff802f
scope: repo
status: active
src: agent
touches:
  - src/claude/note-signals.ts
  - src/claude/stop.ts
---

## Decided
When the `claude` CLI is signed out and no live Stop-hook run is possible, check how trail reads its Stop ask by replaying real Claude Code transcripts from `~/.claude/projects`: find each trail Stop block, cut the transcript where the next Stop ran, and pass that prefix to `askAnswer`. To check the newer feedback form before any build sends it, rewrite the block's "Stop hook feedback" line into a Stop `hook_additional_context` attachment and compare the answers. On 18 Nov this covered 144 real blocks from Claude Code 2.1.286 to 2.1.326 and found no difference between the two forms.

## Tried and ruled out
- Looking for the "Stop hook feedback" line after the block's attachment: no real transcript has it there, so every block looked unanswered.
- Treating the next Stop as a Stop attachment: a Stop hook that prints nothing leaves no attachment, only a summary line.

## Watch out
- In real transcripts the isMeta user line "Stop hook feedback: …" comes one line before the `hook_blocking_error` attachment. After them come a `system` line with subtype `stop_hook_summary`, then the model's reply. The next Stop run shows up as another `stop_hook_summary` line.
- Not every trail Stop block is the save ask. Skills offers and older ask wording lack the ask's closing text, and `askAnswer` correctly returns null for them. That was 82 of the 144 on 18 Nov.
- Additional context from other hook events (UserPromptSubmit, PostToolUse, SessionStart, PreToolUse) is stored as `type: attachment` with `attachment.type: hook_additional_context`, `hookEvent` and a list `content`. That is the shape the Stop feedback form is read in.

In the code: `askAnswer` and `stopFeedback` in src/claude/note-signals.ts; `stopTakesContext` in src/claude/stop.ts. Run the replay with `node --import tsx` from the repo, importing `askAnswer` from src/claude/note-signals.ts.
