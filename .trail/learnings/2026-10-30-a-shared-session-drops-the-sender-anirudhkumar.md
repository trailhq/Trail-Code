---
title: "A shared session drops the sender's name, email and home folder, emails first"
author: Anirudhkumar-nanonets
date: 2026-10-30
branch: feat/share-session
id: l-8e56eed4
scope: repo
status: active
src: agent
touches:
  - src/cloud/share-session.ts
---

## Decided
- A shared session is scrubbed of the sender after secrets are redacted: the home folder becomes `~`, every email becomes `[email]`, and the person's login, git name, git email name and Trail sign-in name become `[you]` where they stand as their own word.
- Emails are replaced before names. Otherwise the name part is swapped first and leaves `[you]@company.com`, which the email pattern no longer matches.
- Object keys are scrubbed too, because Claude Code keys some maps in the transcript by file path (`/Users/<login>/…`).

## Watch out
- Only the sender's own identifiers come out. Teammates' names, the repo and the work itself can still identify someone, so don't call it "completely anonymous".

In the code: src/cloud/share-session.ts `whoIAm`, `anonymize`, `walk` (keys go through `fix`).
