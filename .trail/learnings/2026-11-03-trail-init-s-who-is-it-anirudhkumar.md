---
title: "trail init's who-is-it-for question defaults to the team; just me hides .trail/ from git for that clone"
author: Anirudhkumar-nanonets
date: 2026-11-03
branch: claude/trail-just-for-me-d020f2
cost: { minutes: 1, tokens: 3366 }
id: l-ff88475f
scope: repo
status: active
replaces: l-7640cf04
src: agent
touches:
  - TELEMETRY.md
  - src/notes/just-me.ts
  - src/claude/init.ts
  - src/cli.ts
  - src/cloud/nudge.ts
  - src/claude/hooks.ts
---

## Decided
- `trail init` asks who trail is for in a git repo whose `.trail/` isn't committed yet, on a terminal only. Enter picks my team (changed on 2026-11-03 from just me), because a learning reaches teammates only once `.trail/` is committed. Just me is one keypress (2) or `--just-me`. Agent runs, `--yes`, `--pair` and `--connect` don't ask and stay team.
- Just me keeps `.trail/` in place and lists it in the clone's own `.git/info/exclude`, because the map dir, `repoWiredForTrail` and the status line all key off that folder, and moving them out would touch every reader. Only learnings move: `writeNote` saves a repo learning in ~/.trail while the mark is on, so they outlive a fresh clone and stay private until the person shares.
- `trail init --team` turns it off. Learnings saved while on just me stay personal; nothing is moved into `.trail/learnings/` for the person.

## Tried and ruled out
- Enter picking just me: more repos would never commit `.trail/`, so their learnings would never reach a teammate.
- Keeping the just-me mark inside the repo's `.trail/`: a worktree or second clone wouldn't know the answer. The mark is per repo key in ~/.trail.

## Watch out
- A file git already tracks (an existing AGENTS.md another agent writes to) can't be hidden, so init names it in a warning.
- The look-back review screen still labels rows "for your team" in a just-me repo though they save personal.
- readline/promises' `question` never settles when its input ends, so `askJustMe` races it against the interface's close. In a test, type each line after the prompt, or the second line is lost.
- Another branch adding a key to `init_completed` conflicts on the `EVENTS` line, the `VALUES` entry, the TELEMETRY.md row and the `track` call: keep both keys, in one `VALUES` entry.

In the code: src/notes/just-me.ts (isJustMe, setJustMe, askJustMe, JUST_ME_DIRECTIVE); runTrailInit and dropTrailShared, keepOutOfGit and letGitSee in src/claude/init.ts; trailCommitted and the scope block in runInitCommand, src/cli.ts; cloudLines in src/cloud/nudge.ts; uncommittedDirective in src/claude/hooks.ts.
