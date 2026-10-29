---
title: "Teammate install offer needs the hook wiring committed, not just .trail/"
author: Anirudhkumar-nanonets
date: 2026-10-15
branch: main
cost: { minutes: 129, tokens: 957765 }
touches:
  - src/ask/ask.ts
  - src/cli.ts
  - src/graph/extract.ts
  - test/graph-bindings.test.ts
  - ".github/copilot-instructions.md"
  - AGENTS.md
  - GEMINI.md
  - data/.web-token
  - data/share-link.txt
  - src/ask/jev-ask.ts
---

## Decided
- A teammate without trail only gets learnings and the install offer through the committed hooks. `.claude/settings.json` runs `node .claude/helpers/trail-hooks.cjs <event>`. When the shim finds no trail install, only `session-start` does anything: `offerTrail()` lists the newest 12 files in `.trail/learnings/` and adds the credit-then-offer-once instructions as additionalContext.
- The minimum to commit for that flow is `.trail/learnings/`, `.claude/settings.json` and `.claude/helpers/trail-hooks.cjs`. `trail-statusline.cjs` comes along because init writes `statusLine` into the same settings.json. The skill, `.mcp.json` and `.ignore` are optional.

## Tried and ruled out
- Committing only `.trail/`: Claude Code never reads it on its own, so nobody without trail is nudged. Every `trail init` also edits the tracked `.claude/settings.json` and `.mcp.json` (src/claude/init.ts:38), and those edits leak into unrelated PRs.

## Watch out
- NanoNets/assign's .gitignore has `.claude/*` with negations only for settings.json, hooks/ and skills/, so `.claude/helpers/` is ignored and the shim never gets committed. Add `!.claude/helpers/`. trail init doesn't detect this yet.
- The shim treats `@nanonets/graft` on PATH as trail (PKGS/BINS), and `~/.trail/install.json` points it at the last init's build. To demo "no trail" on one Mac, uninstall both packages and move `~/.trail` aside.
- Saying yes to the offer installs whatever is on npm, which may be older than main.
