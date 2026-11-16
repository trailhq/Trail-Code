---
title: "trail's status line steps aside for one the person or team already set"
author: Anirudhkumar-nanonets
date: 2026-11-02
branch: claude/keep-repo-in-tab-title-53d77c
cost: { minutes: 35, tokens: 358056 }
id: l-b6585b5a
scope: repo
status: active
src: agent
touches:
  - README.md
  - TELEMETRY.md
  - src/claude/format.ts
  - src/claude/init.ts
  - src/claude/settings-merge.ts
  - src/claude/statusline.ts
  - src/cli.ts
  - src/telemetry/contract.ts
  - test/claude-format.test.ts
  - test/telemetry-contract.test.ts
---

## Decided
- trail adds its Claude Code status line only when neither `~/.claude/settings.json` nor the repo's `.claude/settings.json` has one that isn't trail's. Claude Code ranks `.claude/settings.local.json` above both, so trail's line there silently hid the person's own, often the one naming the folder the terminal is in, and people with several tabs open lost track of which repo each was.
- When trail's line is the only one, it starts with the folder name (`◤ web_app · trail · …`), so tabs in different repos read differently.
- A rerun, or the rewire after an upgrade, takes back the line an older init wrote.

## Tried and ruled out
- Telling people to pass `--no-statusline` to keep their own line (the old README advice): nobody finds it until the line is already gone.

## Watch out
- Claude run with `--setting-sources project,local` while `~/.claude` has a status line now shows none, because trail steps aside for a line Claude won't load there.
- `init_completed.statusline` (`trail`/`theirs`/`off`) counts how often each happens.
- Real Claude Code screens can be captured headless for before/after pages: a Python pty plus the pyte emulator, `CLAUDE_CONFIG_DIR` set to a scratch home's `.claude` with `.claude.json` pre-seeded (`hasCompletedOnboarding`, per-project `hasTrustDialogAccepted`), and a parent session's `CLAUDE_CODE_*` variables unset. The status line renders without signing in.

In the code: `mergeTrailLocal` and its `theirs` option in src/claude/settings-merge.ts, `runTrailInit` in src/claude/init.ts, `renderStatusline` in src/claude/format.ts.
