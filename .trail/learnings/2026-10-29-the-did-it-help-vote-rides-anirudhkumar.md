---
title: "The did-it-help vote rides on the credit line, not a Stop block"
author: Anirudhkumar-nanonets
date: 2026-10-29
branch: claude/learning-helped-feedback-e9a0c2
cost: { minutes: 9, tokens: 221425 }
id: l-6f6eb49f
scope: repo
status: active
src: agent
touches:
  - src/claude/learning-vote.ts
  - src/claude/state.ts
  - test/learning-vote.test.ts
  - src/claude/format.ts
  - src/claude/stop.ts
  - src/claude/prompt-hook.ts
  - src/telemetry/contract.ts
  - src/claude/tally.ts
---

## Decided
- The "did it help? 👍/👎" ask (src/claude/learning-vote.ts) is a phrase Claude appends to its own `📝 Started from …'s learning` credit line, asked for in `notesForPrompt` / `notesOnTouch` (src/claude/format.ts) via `voteClause` until the session has asked. No extra turn, nothing blocks.
- The Stop hook (src/claude/stop.ts `turnEnd`) marks the vote pending only when `last_assistant_message` has a 📝 line carrying both 👍 and 👎. The next prompt (src/claude/prompt-hook.ts) settles it: starts with 👍/+1 → up, 👎/-1 → down, anything else → none. One `learning_rated` event a session.
- `learning_id` is checked by shape in the contract (`SHAPES` in src/telemetry/contract.ts), not trusted from the call site.

## Tried and ruled out
- Blocking the Stop to make Claude ask (the way `askForNote` does): it costs an extra assistant turn on the user's time, and the ask had to never block the work.
- Accepting a bare "y"/"yes"/"n" as a vote: trail's own "Commit it with this change? (y/n)" can sit at the end of the same reply, so a "y" is ambiguous.

## Watch out
- Only Claude Code sends `last_assistant_message` at Stop; Cursor and Copilot sessions never get a vote recorded until the transcript read (src/claude/tally.ts `fold`) learns to spot the ask too.
- `learning_id` is the top learning of the last batch shown before the ask, which can be the wrong one when two were shown and Claude credited the second.
