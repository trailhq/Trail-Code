---
title: "A Claude.ai memory export reaches init as a file, and init's copy can't say memory"
author: Anirudhkumar-nanonets
date: 2026-10-29
branch: claude/init-imports-claude-memory-fad046
cost: { minutes: 1, tokens: 2043 }
id: l-c628c30b
scope: repo
status: active
src: agent
touches:
  - src/notes/claude-export.ts
  - src/init/run.ts
  - test/skills-words-1b.test.ts
  - src/cli.ts
  - test/skills-contracts-1b.test.ts
---

## Decided
- Claude.ai keeps its memory on claude.ai, with no file on the laptop, so `trail init --claude-memory <file>` (or `-` for stdin) reads the text Claude.ai writes out when asked for its memories (src/notes/claude-export.ts). No model reads it: facts are list items or sentences, offered only when they name code, never under a "Personal" heading.
- Its facts are offered just for the person (row kind `claudeai` in src/init/run.ts); `r` on init's screen moves one into the repo. With no screen (an agent ran init, or stdin was the export) they're kept just for the person, never relayed.
- Offered-once is keyed by the fact's words (`claude.ai:<hash>`), not a date, so a fresh export of the same memories offers nothing again.

## Tried and ruled out
- Pasting the export into init's own terminal until Ctrl-D: that ends stdin, and the review screen needs the same TTY's raw keys right after. A file or a pipe avoids it.

## Watch out
- test/skills-words-1b.test.ts bans "memory", "memories", "notes", "rules" and "remember" in every string under src/init/ and in INIT_COPY, so init's copy says "what Claude.ai knows about you". Strings in src/cli.ts and src/notes/ aren't in that scope.
- Adding an InitKind also needs test/skills-contracts-1b.test.ts:146 updated, and a `Record<InitKind, …>` entry in candidates.ts and review-screen.ts.
