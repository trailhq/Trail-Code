---
title: "Two-person end-to-end tests need a HOME each, a linked keychain and a local telemetry host"
author: Anirudhkumar-nanonets
date: 2026-10-30
branch: claude/overlap-warnings-go-live-b60dde
cost: { minutes: 1, tokens: 2821 }
id: l-2304ca80
scope: repo
status: active
src: agent
touches:
  - scripts/pack-trail.mjs
---

## Decided
- Two people on one Mac: each gets their own `HOME` (with `.gitconfig`), an npm `--prefix` under it holding `@trailhq/trail-code` built from the branch (`npm run build`, `node scripts/pack-trail.mjs`, `npm pack` in `build/trail`), their own clone, and `trail init -y`, which wires hooks into that HOME's `~/.claude/settings.json`. Run everything through `env -i` with PATH limited to that prefix, node, claude and `/usr/bin:/bin`. A bare git repo stands in for GitHub.
- Claude Code under a scratch HOME says "Not logged in". Linking `$HOME/Library/Keychains` to the real `~/Library/Keychains` lets `claude -p` sign in while everything else stays the person's own.
- Telemetry: the packed build has no key, so set `GRAFT_POSTHOG_KEY` to any value and `GRAFT_POSTHOG_HOST=http://127.0.0.1:<port>` with a small listener per person. Events queue in `$HOME/.graft/telemetry-queue.ndjson`. Trail sends at most once a day; `trail _telemetry-flush` sends now, and the listener receives them at `/batch/`.
- To reproduce a Desktop worktree session, run `claude -p` from the main clone and have it edit the copy under `.claude/worktrees/<name>/`.

## Tried and ruled out
- `claude -p --allowedTools A B "<prompt>"`: the variadic flag takes the prompt as another tool, giving "Input must be provided". Put the prompt right after `-p` and the tools in one comma-separated value.
- Running trail's hook script by hand to see its output: trail's guard blocks it. Read the session transcript in `$HOME/.claude/projects/` for the text the hook gave Claude.

## Watch out
- With no `gh` on PATH, every overlap event has `pr: unknown`.
- Trail's pre-bash guard can block a shell command whose quoted text happens to look like a trail command. Put long text in a file and pass it in.
