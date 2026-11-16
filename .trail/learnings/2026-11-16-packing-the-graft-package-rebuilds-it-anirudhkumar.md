---
title: "Packing the graft package rebuilds it even with --ignore-scripts, which drops the telemetry key unless it's still set"
author: Anirudhkumar-nanonets
date: 2026-11-16
branch: release/0.30.2
id: l-87a404a2
scope: repo
status: active
src: agent
touches:
  - scripts/stamp-telemetry-key.mjs
  - scripts/pack-trail.mjs
  - package.json
---

## Decided
- Keep `GRAFT_POSTHOG_KEY` (and `GRAFT_POSTHOG_HOST`) set in the environment for the whole pack, not just the stamp, so the rebuild `npm pack` starts stamps the key again. Then check each tarball's key length before publishing, as the release order already says.
- Publishing a `.tgz` runs none of the package's scripts, so the tarball you checked is exactly what ships.
- 0.30.2 went out as `@trailhq/trail-code` only: the publishing account had no write access to `@nanonets/graft`, and the fix (share-session) only matters in the trail package. graft stayed at 0.30.1.
- Without the key at hand, it can be read from an installed earlier release's `dist/telemetry/key.js` (`posthogKey()`, `posthogHost()`) straight into the environment, never printed.

## Watch out
- On npm 10.9.9, `npm pack --ignore-scripts` at the repo root still ran `prepare` (build, then stamp). With the key already unset, dist was rebuilt after the stamp and the graft tarball shipped an empty key, while `build/trail` (copied earlier by pack-trail) kept it. Nothing failed or warned; only the key-length check caught it.
- With 2FA set to auth-and-writes, `npm publish` waits for a browser approval and opens it only on Enter in that terminal. Give the person the printed npmjs.com/auth/cli link instead.
- The registry took about 5 minutes to list the new version after npm printed the `+ package@version` line.

In the code: scripts/stamp-telemetry-key.mjs, scripts/pack-trail.mjs, package.json `prepare` (`npm run build && node scripts/stamp-telemetry-key.mjs`).
