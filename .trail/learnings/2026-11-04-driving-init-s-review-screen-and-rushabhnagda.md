---
title: "Driving init's review screen and y/n prompts under screen needs a literal carriage return"
author: Rushabhnagda
date: 2026-11-04
branch: claude/init-aha-ending-d219fe
cost: { minutes: 29, tokens: 436975 }
id: l-53228467
scope: repo
status: active
src: agent
touches:
  - src/cloud/onboarding.ts
  - src/init/first-minute.ts
  - test/init-first-minute.test.ts
  - src/skills/person.ts
  - src/learn/sessions.ts
  - src/init/review-tty.ts
  - src/init/run.ts
  - src/cli.ts
---

## Watch out
- Shrish's recipe (a detached `screen` under `env -i`) gets init counted as a person, so the past-session read and the review screen run. Sending keys with `screen -S <name> -p 0 -X stuff` works for letters (`j`, `y`, `n`), but Enter only lands as a literal CR: `stuff "$(printf '\015')"`. Both `stuff "^M"` and `stuff $'\r'` left the review screen waiting with no error.
- `width 120` in the screenrc didn't take; the review screen wrapped at 80 columns in the log. `screen -X hardcopy <file>` shows the current screen when the log is a mess of redraws.
- Give each demo run its own TRAIL_HOME: the past-session read leaves a mark per remote there (`session-learnings.json`), and a second init on any clone of the same remote skips the read.

## Decided
- For demo runs, leave `gh` off PATH (a bin folder with only node, git and claude symlinked) so the PR-review read stops at no_gh and only the session read calls the model. Pass `--agents claude --no-global` so nothing is written outside the clone and TRAIL_HOME.

In the code: `personAtTerminal` in src/skills/person.ts; `beginSessionRead`'s mark in src/learn/sessions.ts; the review screen's keys in src/init/review-tty.ts; init's y/n in src/init/first-minute.ts `readAnswer`.
