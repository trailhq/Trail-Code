---
title: "The MCP Registry listing reads the npm package, so the repo keeps the graft package name"
author: Shrish
date: 2026-10-29
branch: feat/mcp-directory-listing
cost: { minutes: 51, tokens: 345870 }
id: l-8e6ab5f6
scope: repo
status: active
src: agent
touches:
  - package.json
  - scripts/pack-trail.mjs
  - server.json
  - scripts/pack-graft.mjs
  - test/graft-to-trail.test.ts
---

## Decided
- Trail Code is listed in the official MCP Registry as io.github.trailhq/trail-code. The registry only accepts the entry when the npm package it names carries a matching mcpName, so only @trailhq/trail-code carries it. It is added where the trail package is laid out, not in the repo's package.json.
- Shrish decided (2026-10-30) the repo's package.json keeps the @nanonets/graft name. Echoic's listing checklist asked for the rename, but no directory needs it: the registry reads npm, Cursor Directory reads .mcp.json, and the rest are submitted by hand.

## Tried and ruled out
- Renaming the repo's package to @trailhq/trail-code and laying out graft from it instead: 4 tests broke, because they assume this checkout runs as graft (the postinstall nudge, the upgrade advice under npx, the graft-to-trail move).
- One package with both the trail and graft commands, as the checklist suggested: anyone with both packages installed would get a clash on the graft command.

## Watch out
- The registry entry must pass the `mcp` argument: bare `npx @trailhq/trail-code` starts the CLI, not the MCP server. Its description must be 100 characters or less.
- The entry names a fixed npm version and does not follow npm by itself. Bump both version fields and publish it again when a release should be what directories show.
- Publishing under io.github.trailhq/ needs `mcp-publisher login github` by a trailhq org member.

In the code:
- scripts/pack-trail.mjs sets mcpName; server.json is the registry entry; .mcp.json at the root is for Cursor Directory.
- Check the entry with `mcp-publisher validate`, publish with `mcp-publisher publish`.
