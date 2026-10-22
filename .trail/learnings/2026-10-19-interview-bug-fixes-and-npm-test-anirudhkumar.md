---
title: "Interview bug fixes, and npm test can wipe your trail hooks"
author: Anirudhkumar-nanonets
date: 2026-10-19
branch: fix/trail-interview-bugs
touches:
  - src/claude/format.ts
  - src/claude/hooks.ts
  - src/cli.ts
  - src/mcp/tools.ts
  - src/notes/git-facts.ts
  - src/notes/notes.ts
  - src/notes/session-cost.ts
  - src/search/grep-cli.ts
  - test/trail-home.test.ts
  - test/trail-note-ask.test.ts
---

## Decided
- Home folder: `trail init` refuses ~ (src/init-guard.ts). Other non-git folders still work, but init prints that learnings stay on this machine instead of "commit .claude/settings.json and .trail/" (git status fails outside git, so every path looked changed).
- Learnings reach Claude on file touch: the PostToolUse hooks (tool-savings for Read/Bash, post-edit for Edit/Write) call `learningsOnTouch` → `notesOnTouch` in src/claude/format.ts, matched on each learning's `touches`, once a session via `injectedNotes`, two per call at most, standing learnings and trail's own commands skipped. Proven in a real Sonnet `claude -p` run on the migration repo.
- A learning's `touches` come from the session transcript (edited, then named in the body, then Read) when there is one; the working tree is only the fallback. Before, every note listed whatever untracked files sat in the repo (AGENTS.md, data/.web-token).
- Stop hook: a turn also counts as digging when trail's answers in it stood in for 30k+ tokens (NOTE_WORTHY_TOKENS); trail answers most questions in 1-2 calls, so the 3-call rule never fired on exploratory turns.
- Empty `trail grep` names git-ignored code it didn't search (src/search/ignored-code.ts) instead of "All indexed code was searched".

## Tried and ruled out
- Refusing every non-git folder in init: trail supports non-git folders on purpose (repoPlace has place.git) and tmpRepo-based init tests rely on it.
- "Trail skill not loaded on Sonnet": not reproduced. Sonnet and Opus both list the skill, and Sonnet ran `trail ask` first in 3 of 3 runs. Neither model invokes the Skill; the session-start hook carries the instructions.

## Watch out
- Run the suite with a scratch HOME: `HOME=<scratch> USERPROFILE=<scratch> DO_NOT_TRACK=1 npm test`. A plain `npm test` on 2026-10-19 deleted ~/.claude/helpers/graft-hooks.cjs, ~/.claude/skills/trail and the hooks block in ~/.claude/settings.json within seconds (likely graft-to-trail, hosts-trail or upkeep-hooks tests). With a scratch HOME, 3 of those tests fail on main too.
- `learnings_committed` IS on main (src/claude/hooks.ts, since #585). The 2026-10-19 learnings that say otherwise were checked against a local main 14 commits behind; `git fetch` before grepping main.
- To run a real Claude session against a local build without touching the installed one: `TRAIL_HOME=<scratch>` with install.json `{"claudeDist": "<build>/dist/claude"}`; the hook shims pick `remembered()` first at equal versions.
