---
title: "Workspace sign-in nudge: TRAIL_CLOUD flag and what uploads"
author: Anirudhkumar-nanonets
date: 2026-10-22
branch: main
cost: { minutes: 3, tokens: 103244 }
id: l-06948596
scope: repo
status: active
touches:
  - src/cloud/workspace.ts
  - src/cloud/nudge.ts
---

## Decided
- The sign-in nudge and `login`/`logout`/`workspace` are gated by one env var, `TRAIL_CLOUD=1` (`cloudEnabled`, src/cloud/workspace.ts). A machine with `~/.trail/cloud.json` keeps it on without the var. To turn it on for Claude Code, put it in `~/.claude/settings.json` `env`; shells and Cursor need `export TRAIL_CLOUD=1`. New sessions only.
- The nudge (`cloudLines`, src/cloud/nudge.ts) prints only at the end of `trail ask`, `trail note` and `trail check` text output, brand `trail`. Not on `--json`, MCP tools or hooks. It needs a git repo with a remote, trail set up there, at least one live learning, and fires once per Claude session (4h gap without a session id). The link is good for 24h.
- What uploads: only the repos ticked in the web picker. For each, every learning in `.trail/learnings/` (working tree plus teammates' pushed branches) and, from 0.24.1, git-tracked `.claude/skills/*/SKILL.md`. After connecting, ask/check usage events for those repos. Personal learnings and skills in `~/.trail` never go up.

## Tried and ruled out
- Reading main to explain 0.24.1: npm 0.24.1 was built from `release/0.24.1`, which adds onboarding/pair/skills sync and sets the default URL to https://team.trailhq.com. main still says app.trailhq.com.

## Watch out
- `noteCount` counts personal learnings too, so a repo with only personal notes can show the nudge and then upload zero.
- Registering the link (before sign-in) already sends the picker list: every repo trail knows on the machine (key, name, learning count) plus the git author name.
- Testing the nudge spawns a detached `_trail-claim` child that polls for 20 min. Use a scratch `TRAIL_HOME`, a dead `TRAIL_URL` and `DO_NOT_TRACK=1`, then kill the child.
