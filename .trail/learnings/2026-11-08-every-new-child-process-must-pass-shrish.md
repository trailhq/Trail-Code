---
title: "Every new child process must pass windowsHide, and a test now enforces it"
author: Shrish
date: 2026-11-08
branch: fix/windows-hide-followup
cost: { minutes: 47, tokens: 255512 }
id: l-a0a24e42
scope: repo
status: active
src: agent
touches:
  - src/cli-meta.ts
  - src/cloud/share-session.ts
  - src/notes/pr-reviews.ts
  - src/app/checkout.ts
  - src/blast/blast-cli.ts
  - src/blast/diff.ts
  - src/blast/owners.ts
  - src/check/learning-edits.ts
  - src/claude/build-progress.ts
  - src/cli.ts
---

## Decided
Every git/gh/npm child process started from src/ passes `windowsHide: true`, unless it hands the child the person's terminal. Without it, Windows flashes a console window on each call (one per edit from hooks). #683 added a scanner test that fails on any call missing it.

## Watch out
A PR that adds a spawn/exec call will fail that test even if the PR is about something else. Three calls (npm in the self-upgrade path, git config in share-session, git log in pr-reviews) slipped in while #683 was open and had to be fixed in a follow-up.
Fork PRs that need main merged into them can't be pushed with a gh token lacking the `workflow` scope once main has a newer workflow file; merge the PR and fix in a follow-up, or refresh the token with the workflow scope.

In the code: test/child-process-windowshide.test.ts (allowlist of exceptions with reasons), src/cli-meta.ts npmRun, src/cloud/share-session.ts whoIAm, src/notes/pr-reviews.ts revertCommits.
