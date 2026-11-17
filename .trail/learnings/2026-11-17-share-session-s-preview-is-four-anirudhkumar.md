---
title: "share-session's preview is four short sections, then one line that says what to type: y, n, or folder numbers to leave out"
author: Anirudhkumar-nanonets
date: 2026-11-17
branch: fix/share-ask-offers-leave-out
cost: { minutes: 42, tokens: 740869 }
id: l-9cb501d1
scope: repo
status: active
replaces: l-69e4953a
src: agent
touches:
  - src/cloud/share-bundle.ts
  - src/cli.ts
  - test/share-bundle.test.ts
---

## Decided
- The preview stays four headed sections: what's sent, from these folders, removed before sending, after you say yes. Its last line is where the copy is. A flat list of about 15 rows made a teammate miss the question entirely (16 Nov).
- After it comes one line saying what to type and what each answer does, then a bare `→` prompt: "Type y to send it all, n to send nothing, or folder numbers to leave out (like 2 3)." Enter still sends nothing.
- Folder numbers are offered whenever more than one folder is still in. With only "→ Send it? [y/N]", Aarsh (17 Nov) didn't know folders could be kept back, though typing numbers still worked.
- Leaving out can happen more than once: the preview is shown again with what's left, and the line asks about "the rest". The example numbers never name every folder still in, and a folder already left out can't be picked again.

## Tried and ruled out
- "→ Send it? [y/N, or folder numbers to leave out]": two questions in one line. The user (17 Nov) asked for a line that says what to enter instead.
- Dropping the folder option from the question (16 Nov): people couldn't find it.
- "Not sent" as the heading of the removed list: too terse. The heading is "Removed before sending".

## Watch out
- Review copy changes in a real terminal: run `node --import tsx src/bin/trail.ts share-session --once` under `script` with a throwaway HOME (a `~/.trail/cloud.json` pointing at a local stand-in that answers `/api/cli/shared-sessions/allowed` and the POST). Type the answers after the prompt shows: piped input ends first and reads as no.

In the code: `sendAsk` and `parseLeaveOut` in src/cloud/share-bundle.ts; the answer loop in `shareWholeClaude` in src/cli.ts.
