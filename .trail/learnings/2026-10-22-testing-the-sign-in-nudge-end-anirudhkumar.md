---
title: Testing the sign-in nudge end to end with headless Claude
author: Anirudhkumar-nanonets
date: 2026-10-22
branch: main
cost: { minutes: 15, tokens: 126584 }
id: l-bebcfc70
scope: repo
status: active
---

## Decided
- To check the nudge in a real Claude session without touching the machine's trail: install trail with `npm i -g --prefix <sandbox>/npm`, clone the repo into the sandbox, run `trail init --agents claude` with `HOME=<sandbox>/home`, then run `claude -p` in the clone with `TRAIL_HOME=<sandbox>/home/.trail`, `PATH=<sandbox>/npm/bin:$PATH`, `TRAIL_CLOUD=1`, `--setting-sources project,local --settings <sandbox>/home/.claude/settings.json` and `--output-format stream-json --verbose`.
- Verified on assign dev (9 learnings): Claude ran `trail ask` first, got the nudge, and ended its answer with the link word for word. POST /api/cli/handoffs/claim with the state from `cloud-nudge.json` answered 202 pending.

## Tried and ruled out
- `HOME=<sandbox>` or `CLAUDE_CONFIG_DIR=<sandbox>` for the claude run: "Not logged in". The macOS login doesn't follow either, so keep the real HOME for claude and isolate trail with TRAIL_HOME and `--setting-sources` instead.

## Watch out
- After a heavy reading turn the Stop hook asks Claude about saving a learning, so the answer with the link is followed by a second short message, and the UI shows "Stop hook error occurred". In a demo the link isn't the last thing on screen.
- assign commits trail's SessionStart hook and init adds a global one, so the trail context is injected twice.
