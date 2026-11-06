---
title: trail summary one-line shortens the hook blocks; full stays the default
author: Anirudhkumar-nanonets
date: 2026-10-29
branch: claude/one-line-sources-summary-cfaca7
cost: { minutes: 13, tokens: 213298 }
id: l-b6e6fd7b
scope: repo
status: active
src: agent
touches:
  - src/claude/summary-view.ts
  - "src/claude/format.ts#notesForPrompt"
  - "src/claude/format.ts#notesOnTouch"
  - "src/claude/format.ts#formatBlastRadius"
---

## Decided
- The 2026-10-28 ask to keep the "sources-diff summary" to one line was read as the two multi-line blocks trail's hooks add and Claude Code also shows the person: the learnings under a prompt/edit/command (`notesForPrompt`, `notesOnTouch` in src/claude/format.ts, 4-5 lines per learning) and the blast radius after an edit (`formatBlastRadius`, 9-10 lines). `trail summary one-line` turns each into one line; it is kept as `summary` in `~/.trail/settings.json` (src/claude/summary-view.ts), and `TRAIL_SUMMARY` overrides it per shell or per repo through `.claude/settings.json` env.
- Full stays the default: the inline decided/ruled-out/watch-out leads are how a learning reaches Claude without Claude choosing to open a file, and one report a week before launch isn't enough to change what every user's Claude gets.

## Tried and ruled out
- Showing the person one line while Claude keeps the full block: Claude Code renders the hook's additionalContext to the person too (it has a renderer for `hook_additional_context`), so the two can't be split; the systemMessage channel is only what the person sees.
- Putting the key in `TrailSkillSettings` (src/skills/settings.ts): a test pins who imports its setters, so summary-view.ts writes its own key and keeps every other key on write.

## Watch out
- notesForPrompt/notesOnTouch/formatBlastRadius read the view from `~/.trail/settings.json` by default, so a test that runs without a scratch HOME/TRAIL_HOME picks up the developer's own setting; pass the view argument in tests.
