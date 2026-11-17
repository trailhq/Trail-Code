---
title: "The did-it-help vote counts only a clear answer, and a session left idle counts as no answer"
author: Anirudhkumar-nanonets
date: 2026-11-17
branch: claude/learning-helped-feedback-e9a0c2
cost: { minutes: 1, tokens: 1217 }
id: l-2083ec5e
scope: repo
status: active
src: agent
touches:
  - src/claude/learning-vote.ts
  - src/claude/tally.ts
  - src/claude/stop.ts
  - src/telemetry/sessions.ts
  - test/learning-vote.test.ts
  - TELEMETRY.md
---

## Decided
- Claude adds "did it help? yes/no" to its credit line only in a reply that asks the person nothing else. If that reply, or any reply before the person answers, asks something else (a sentence ending in "?", a "(y/n)", or a question tool with answer buttons such as the Claude app's next-step box), the vote turns strict: only "it helped" or "didn't help" counts, because a bare yes probably answers the other question.
- A leading no counts only in a reply of up to four words, or one that mentions help: "no, I meant the other file" is a correction, not a vote. "No worries", "no problem" and similar never count.
- Casual words (yeah, yep, sure, nope, nah, not really) and a few other languages (haan, nahi, sí, ja) count. A bare y or n still never does.
- A vote still waiting when the idle sweep closes the session (untouched two hours, swept at the next session start in that repo folder) is sent as none, so idle sessions count toward the answer rate.

## Tried and ruled out
- Reading a yes anywhere in the message: further in, a bare yes is usually an instruction, not a vote. Only phrases built on "help" are read anywhere.
- Guessing typos ("yse") or half answers ("kind of"): either misreads real words or isn't a yes or a no.
- A separate wait time for votes: the sweep's existing two-hour rule for session_summary already defines a closed session, so the vote uses the same one.

## Watch out
- A yes typed more than two hours later, after another session started in the same folder, counts nothing: the sweep already sent none.
- Any sentence ending in "?" outside code counts as another question, rhetorical ones included. That only makes the vote strict; it never invents a vote.

In the code:
- src/claude/learning-vote.ts: voteClause, asksMore, voteOf (strict), markVoteAsked, closeVote.
- src/claude/tally.ts: asksPerson sets OpenTurn.asks from a tool_use whose input has an `ask`.
- src/telemetry/sessions.ts: summarizeSession sends the waiting vote as none.
