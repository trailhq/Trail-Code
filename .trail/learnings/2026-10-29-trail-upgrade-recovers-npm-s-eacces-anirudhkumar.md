---
title: "trail upgrade recovers npm's EACCES, ENOTEMPTY and EEXIST; postinstall output is never seen"
author: Anirudhkumar-nanonets
date: 2026-10-29
branch: claude/install-without-sudo-9b8267
cost: { minutes: 27, tokens: 301128 }
id: l-179631ab
scope: repo
status: active
src: agent
touches:
  - src/node-version.ts
  - src/bin/trail.ts
  - src/bin/graft.ts
  - scripts/postinstall.mjs
  - README.md
  - src/cli-meta.ts
  - package.json
---

## Decided
- `trail upgrade` (runUpgrade in src/cli-meta.ts) keeps npm's stderr, reads its `npm error code/path/dest` lines (parseNpmError) and recovers: ENOTEMPTY removes npm's moved-aside `.<name>-<hash>` folder and retries; EEXIST removes a bin link only when it points into a trail/graft install or at nothing; EACCES prints a home-folder npm prefix fix (noSudoFix) instead of npm's stack. Never suggest sudo: a sudo install makes every later upgrade need sudo too.
- The Node floor is 22.3, or 20.16 on Node 20 (src/node-version.ts, `engines` in package.json). That's where `process.getBuiltinModule` exists; hooks and the past-session look-back use it. On Node 18, `trail init` "works" but prints "couldn't read your past sessions this time (process.getBuiltinModule is not a function)" and saves no learnings. The bins check first and import everything else dynamically.

## Tried and ruled out
- Printing the Node warning (or any install hint) from scripts/postinstall.mjs: npm 7+ hides a successful lifecycle script's output, so nobody sees it. Even the existing "Trail installed" nudge never shows on `npm i -g`. Only the bin, README and the agent's instructions can reach the user.

## Watch out
- npm names the moved-aside folder from a sha1 of the package path (arborist's retire-path.js), so the name is the same every run: one install stopped midway breaks every later install of that package (an internal tester's ENOTEMPTY on 2026-10-22) until the folder is removed.
- `sudo npm i -g` on macOS keeps HOME, so postinstall writes ~/.graft/telemetry.json as root; the user's own trail then can't read it and mints a new install id per run, which splits `install` from `init_completed` in the setup metric.
- A plain `npm i -g` that fails with EACCES fails before any trail code runs; the fix there is the README tip, not code.
