---
title: "share-session's preview is four short sections with the send question alone on the last line, because a long flat list made people miss it"
author: Anirudhkumar-nanonets
date: 2026-11-16
branch: feat/share-preview-cleaner-copy
id: l-69e4953a
scope: repo
status: active
src: agent
touches:
  - src/cli.ts
  - src/cloud/share-bundle.ts
  - test/share-bundle.test.ts
  - test/share-session.test.ts
---

## Decided
- A teammate ran `trail share-session`, read the preview and never answered: the old preview was about 15 flat label rows, and the question that followed it was one plain line with a three-way answer (y, n, or folder numbers). Nothing was sent until someone noticed.
- The preview is now four headed sections: what's sent, from these folders, removed before sending, after you say yes. Its last line is where the copy is, and the question that follows is only "→ Send it? [y/N]", with Enter meaning no.
- Leaving folders out is no longer offered in the question. Folders keep their numbers, because `--leave-out` (the no-terminal path an agent drives) uses them, and typing a number at the question still leaves that folder out.
- Detail that doesn't help someone decide moved out of the preview: the count of places a name was hidden, the secret kinds one by one, and the separate copy, hook and delete rows. SUMMARY.md in the copy still has the full lists.

## Tried and ruled out
- "Not sent" as the heading of the removed list: too terse. "Taken out on your laptop, never sent": reads like taking a note on your laptop. The heading is "Removed before sending".
- Keeping "or type folder numbers to leave out" in the question: it buried the yes/no again.

## Watch out
- Show copy changes in a real terminal before shipping: the person approving reads it there, not in a markdown block.

In the code: src/cloud/share-bundle.ts `bundlePreviewLines`, `SEND_ASK`, `SEND_REST_ASK`; src/cli.ts `shareWholeClaude`; test/share-bundle.test.ts and test/share-session.test.ts.
