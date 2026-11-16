---
title: "npm downloads must sum every name; npm's stats have whole-day zero gaps"
author: Anirudhkumar-nanonets
date: 2026-10-29
branch: claude/npm-downloads-after-rename-a84886
cost: { minutes: 11, tokens: 206402 }
id: l-67bc818b
scope: repo
status: active
src: agent
touches:
  - ".github/scripts/npm-downloads-badge.mjs"
  - ".github/workflows/npm-downloads-badge.yml"
  - README.md
---

## Decided
- The README downloads badge reads a shields endpoint JSON (gh-pages `badges/npm-downloads.json`) written daily by `.github/workflows/npm-downloads-badge.yml`, which sums npm's last-month count for every name in `PACKAGES` in `.github/scripts/npm-downloads-badge.mjs` (`@trailhq/trail-code` + `@nanonets/graft`). On a rename, add the new name and keep the old ones.
- The script lives in `.github/scripts/`, not `scripts/`, because `scripts/` ships in the npm tarball.

## Tried and ruled out
- shields' own `npm/dm` badge: one package only. Pointing it at `@trailhq/trail-code` on launch day read 0 (#615 reverted to `@nanonets/graft`, which then left out every trail-code install).
- npm's bulk endpoint (`/downloads/point/last-month/a,b`): refuses scoped packages, so it can't sum ours.

## Watch out
- npm's downloads API has whole days where every package reads 0 (2026-10-06, 10-13..15, 10-19..21). That's an npm gap, not a real drop; don't report it as one. The badge script refuses to publish a zero total for this reason.
- `graft-cli` on npm belongs to someone else (graftapp/graft). Don't count it.
- As of 2026-10-29 about 92% of monthly downloads are still on `@nanonets/graft` (93,704 vs 7,663 for 09-28..10-27).
