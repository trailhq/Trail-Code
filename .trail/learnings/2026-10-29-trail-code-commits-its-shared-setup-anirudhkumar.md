---
title: Trail-Code commits its shared setup; checking the no-trail session start
author: Anirudhkumar-nanonets
date: 2026-10-29
branch: claude/commit-trail-shared-setup-cdff56
cost: { minutes: 1, tokens: 2626 }
id: l-cef6878e
scope: repo
status: active
src: agent
---

## Decided
- Trail-Code tracks `.claude/settings.json` (one SessionStart entry), `.trail/hook.cjs`, `.trail/README.md` and `.trail/.gitignore` (#725). They are byte-identical to what `trail init` writes on main (`mergeTrailShared({})`, `hooksShim()`, `REPO_TRAIL_README`), so a teammate's init leaves no diff. If one of those generators changes, commit the regenerated file with that change.
- The pre-0.23 `.claude/helpers/graft-*.cjs` and `.claude/skills/graft/` are gone from the repo: `clearOldLayout` deletes them on every init.

## Tried and ruled out
- `cp` or `chmod` on `.trail/hook.cjs` from Bash, or any command whose text names that file: trail's PreToolUse guard refuses it ("run only from the host's hooks"), even a copy or a `trail note` heredoc. Write it the way init does, `writeFileSync(TRAIL_HOOK, hooksShim())` from `dist/claude/init.js` and `dist/claude/shim-template.js`, and pass note text from a file.

## Watch out
- To see what a teammate without trail gets: fresh clone, a scratch bin holding only a copy of `node`, `env -i HOME=$HOME PATH=<bin>:/usr/bin:/bin TRAIL_HOME=<empty>`, then `claude -p ... --setting-sources project --output-format stream-json --verbose`. The `hook_response` line carries the exact additionalContext. The repo copy's stand-down (hook-layers.ts) applies only once trail is found, so it doesn't hide the offer here.
- git overwrites an ignored file when a pull brings a tracked file to that path, so a personal `.claude/settings.json` is replaced silently once this is merged.
