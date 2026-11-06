---
title: "Init finding few past sessions is usually Claude Code's 30-day transcript cleanup, not discovery"
author: Rushabhnagda
date: 2026-11-05
branch: claude/init-aha-ending-d219fe
cost: { minutes: 55, tokens: 301347 }
id: l-62b68de9
scope: repo
status: active
src: agent
touches:
  - src/init/first-minute.ts
  - test/init-first-minute.test.ts
  - TELEMETRY.md
  - src/cli-epilogue.ts
  - src/cli.ts
  - src/cloud/onboarding.ts
  - src/init/run.ts
  - src/notes/session-cost.ts
  - src/init/sessions.ts
  - src/init/transcript.ts
---

## Watch out
- `trail init` finding only a couple of past sessions for a repo is usually what's on disk, not a discovery miss. Claude Code deletes transcripts after `cleanupPeriodDays`, which defaults to 30. On Rushabh's laptop (2026-11-04), the oldest of 232 transcripts was last written 36 days ago, and the main checkout's `~/.claude/projects/<slug>/` folder held only `memory/`.
- Check before changing discovery. Run `discoverSessions(repo, home)` and read `skipped` by `why`. Then compare with the desktop app's own session records: `~/Library/Application Support/Claude/claude-code-sessions/*/*/local_*.json` has `cwd` and `cliSessionId` per Code session. Both said 2 sessions there, and discovery found both.

## Tried and ruled out
- "Worktree sessions are stored under other project folders and missed": worktrees under `.claude/worktrees/` match through `within(cwd, [top])` even after they're deleted. There were no deleted-worktree transcripts to find.
- "Desktop app sessions are dropped as headless": their `entrypoint` is `claude-desktop`. Only `sdk*` entrypoints count as headless.
- Counting sessions from a sibling folder (an orchestrating session in `~/work/todos`) that mention the repo's paths: their mentions are messages and tool results. Their tool calls in the repo were 6% and 0.2%, far under the 30% share discovery asks of an ancestor session.

In the code: `discoverSessions`, `scratch` and `ANCESTOR_SHARE` in src/init/sessions.ts; the headless check in `scanTranscript`, src/init/transcript.ts.
