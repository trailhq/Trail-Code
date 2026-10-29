---
title: "Init's list is written for a first-time reader: one sentence per line, who gets it said once"
author: Anirudhkumar-nanonets
date: 2026-10-29
branch: claude/init-offer-says-what-it-does-86e280
cost: { minutes: 13, tokens: 125438 }
id: l-f8b28255
scope: repo
status: active
src: agent
touches:
  - src/init/review-screen.ts
  - src/trace/walls.ts
  - test/init-fold-lessons.test.ts
  - test/init-keep-cli.test.ts
  - test/init-relay-words.test.ts
  - test/init-run.test.ts
  - test/init-screen.test.ts
  - test/init-team-rows.test.ts
  - test/init-tty.test.ts
  - test/trace-walls.test.ts
---

## Decided
- Init's list (the terminal pick list in src/init/review-screen.ts `screenLines`, and the list Claude relays, `relayItemLine`/`relayBlock`) is written for someone who has never seen Trail: one sentence per line under each item's name, never facts joined by " · " on one line (2026-10-29, after a first-time user couldn't tell what no-timeout did).
- Each item says what Claude will do (an always-follow offer's `does` in src/trace/walls.ts), then where it came from, with a subject: "Claude's commands failed with ..." (the wall's `seen`), not "Hit ...".
- Who gets a kept item is said once per section, as a heading (`INIT_COPY.forYou`, `INIT_COPY.team`), never on every item. Beside the name goes only where it applies: "(every repo)", "(this repo only)", or "(added to this repo: your team gets it once you commit)", since `w` and `r` change that per item.
- Say the noun: "always-follow learning", "learning in your own words", "skill". A bare mark like "always follow", or "this"/"it" with no noun, gets guessed at by the reader and by Claude.

## Tried and ruled out
- "just for you, in every repo": a newcomer can't tell who uses it or where. "only your Claude uses it" and "your Claude follows this" were also rejected as vague; repeating the scope on every item was rejected as noise.
- "added to this repo, committed": Trail never commits; the person does.

## Watch out
- Team rows (PR reviews, past sessions, Claude Code's own notes) come first on the screen, so the forYou heading goes above the first personal group, not at the top.
- Reusing one scratch HOME across test runs makes 3 tests in test/trail-scenario-hooks.test.ts fail, on main too; use a fresh HOME per run.
