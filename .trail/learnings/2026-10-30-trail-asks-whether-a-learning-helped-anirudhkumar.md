---
title: "Trail asks whether a learning helped as yes or no in words, not thumbs"
author: Anirudhkumar-nanonets
date: 2026-10-30
branch: claude/learning-helped-feedback-e9a0c2
cost: { minutes: 1, tokens: 2448 }
id: l-38bfa5ee
scope: repo
status: active
src: agent
touches:
  - src/claude/learning-vote.ts
---

## Decided
- The once-a-session question on the credit line reads "did it help? yes/no", and a next message starting with the word yes or no is the vote (thumbs and +1/-1 still count). Anirudh decided this on 2026-10-30: nobody types a thumbs emoji in a terminal, so thumbs mostly measured how hard it is to answer.

## Tried and ruled out
- "did it help? 👍/👎": needs the emoji picker; most people would answer in words and land as no vote.
- Clickable yes/no: trail only adds text to Claude's reply and Claude Code gives hooks no buttons there. Claude's own multiple-choice question would be clickable but stops the turn until answered, which the vote was built to avoid.

## Watch out
- Count only the whole words yes and no, never a bare y or n: trail's own "Commit it with this change? (y/n)" can end the same reply, and that y is not a vote.

In the code:
- src/claude/learning-vote.ts: VOTE_ASK, askedForVote (looks for the yes/no question on the 📝 line), voteOf.
