---
title: "The MCP Registry listing reads the npm package, so the repo keeps the graft package name"
author: Shrish
date: 2026-10-30
branch: feat/mcp-directory-listing
cost: { minutes: 27, tokens: 274615 }
id: l-5a79b41c
scope: repo
status: active
replaces: l-8e6ab5f6
src: agent
touches:
  - package.json
  - scripts/pack-trail.mjs
  - server.json
  - ".github/scripts/npm-downloads-badge.mjs"
  - ".github/workflows/npm-downloads-badge.yml"
  - README.md
---

## Decided
- Trail Code is listed in the official MCP Registry as io.github.trailhq/trail-code. The registry accepts the entry only when the npm package it names carries a matching mcpName, so only @trailhq/trail-code carries it, added where the trail package is laid out.
- Shrish decided (2026-10-30) the repo's package.json keeps the @nanonets/graft name. No directory needs the rename: the registry reads npm, Cursor Directory reads .mcp.json, the rest are submitted by hand.

## Tried and ruled out
- Renaming the repo's package to @trailhq/trail-code: 4 tests broke, because they assume this checkout runs as graft.
- One package with both the trail and graft commands: installing both packages would clash on the graft command.
- Publishing after the plain GitHub device login: the registry refused with 403, because that login can't read the org role and only allows io.github.<your-user>/*.

## Watch out
- Publishing under io.github.trailhq/ needs a trailhq owner signed in with a classic GitHub token that has read:org, or a GitHub Actions run (OIDC). The registry's sign-in lasts minutes, so run the login and the publish in one line.
- The entry must pass the `mcp` argument (bare `npx @trailhq/trail-code` starts the CLI), and its description must be 100 characters or less.
- The entry names a fixed npm version; bump both versions and publish it again when a release should be what directories show.

In the code:
- scripts/pack-trail.mjs sets mcpName; server.json is the entry; .mcp.json is for Cursor Directory.
- `mcp-publisher validate`; `mcp-publisher login github --token <read:org token> && mcp-publisher publish`.
