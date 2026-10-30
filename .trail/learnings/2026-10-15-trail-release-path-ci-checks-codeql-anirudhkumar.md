---
title: "Trail release path: CI checks, CodeQL and what publishes"
author: Anirudhkumar-nanonets
date: 2026-10-15
branch: main
cost: { minutes: 113, tokens: 927495 }
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
- Merging to main publishes nothing to npm. The `publish` check is blast-pages (the PR's blast-radius page). A release is manual: bump the version, `npm run build`, `node scripts/pack-trail.mjs`, then `npm publish build/trail --access public`. A colleague publishes; never publish yourself.
- To try main before a release, run `npm install -g ./build/trail` from a worktree at origin/main. The global install is a symlink into that folder, so keep the folder until the real release.
- trailhq/Trail-Code PRs are squash-merged.

## Tried and ruled out
- CodeQL's two actions on different versions. `github/codeql-action/init` and `/analyze` must be pinned to the same version, or `analyze` fails with "Loaded a configuration file for version X, but running version Y". Dependabot bumped only analyze (#457) and broke main from 30 Sep until #611 and #613 pinned init to v4.38.1.
- Stripping HTML comments with a single `.replace(/<!--[\s\S]*?-->/g, "")`. CodeQL flags it as high (js/incomplete-multi-character-sanitization) because `<!<!---->--` leaves `<!--` behind. The rule skips a replace whose result loops back into itself, and skips anchored regexes. So repeat until stable, then drop an unclosed `<!--` to the end (`dropHtmlComments` in src/notes/pr-reviews.ts).

## Watch out
- Telemetry can't single out a repo: `repo_id` is a random UUID per checkout, with no name or remote. `learning_reused` fires only from `trail ask`, so a credit given through the hook shim to a teammate without trail isn't logged. Measure a rollout like assign's from git instead: learnings on dev, and PR open-to-merge time.
- `trail init` reads sessions from every worktree git lists for the repo, so a fresh worktree still sees the main checkout's past sessions.
