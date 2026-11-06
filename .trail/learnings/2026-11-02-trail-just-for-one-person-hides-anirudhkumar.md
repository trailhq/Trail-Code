---
title: "Trail just for one person hides .trail/ from git for that clone instead of moving trail's files out of the repo"
author: Anirudhkumar-nanonets
date: 2026-11-02
branch: claude/trail-just-for-me-d020f2
cost: { minutes: 43, tokens: 534965 }
id: l-7640cf04
scope: repo
status: active
src: agent
touches:
  - README.md
  - TELEMETRY.md
  - src/claude/hooks.ts
  - src/claude/init.ts
  - src/claude/settings-merge.ts
  - src/cli.ts
  - src/cloud/nudge.ts
  - src/notes/just-me.ts
  - src/notes/notes.ts
  - src/telemetry/contract.ts
---

## Decided
- `trail init` asks who trail is for in a git repo whose `.trail/` isn't committed yet, on a terminal only. Just me is what enter picks, because nothing should change in the repo until the person says so. Agent runs, `--yes`, `--pair` and `--connect` don't ask and stay team, so the onboarding page and the website's setup prompt behave as before.
- Just me keeps `.trail/` in place and lists it in the clone's own `.git/info/exclude`, because the map dir, `repoWiredForTrail` and the status line all key off that folder, and moving them out would touch every reader. Only learnings move: `writeNote` saves a repo learning in ~/.trail while the mark is on, since learnings should outlive a fresh clone and stay private until the person shares.
- `trail init --team` turns it off. Learnings saved while on just me stay personal; nothing is moved into `.trail/learnings/` for the person.

## Tried and ruled out
- Keeping the mark inside the repo's `.trail/`: a worktree or second clone wouldn't know the answer. The mark is per repo key in ~/.trail.

## Watch out
- A file git already tracks (an existing AGENTS.md another agent writes to) can't be hidden, so init names it in a warning.
- The look-back review screen still labels rows "for your team" in a just-me repo though they save personal.
- Any other branch adding a key to `init_completed` conflicts on the `EVENTS` line, the `VALUES` entry, the TELEMETRY.md row and the `track` call: keep both keys, in one `VALUES` entry.

In the code: src/notes/just-me.ts (isJustMe, setJustMe, JUST_ME_DIRECTIVE); runTrailInit and dropTrailShared, keepOutOfGit and letGitSee in src/claude/init.ts; askJustMe and trailCommitted in src/cli.ts; cloudLines in src/cloud/nudge.ts; uncommittedDirective in src/claude/hooks.ts.
