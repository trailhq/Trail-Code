---
title: "Real Codex runs: what reaches Codex with and without trusted hooks, and how to test it"
author: Anirudhkumar-nanonets
date: 2026-10-30
branch: claude/desktop-and-codex-hosts-cde008
cost: { minutes: 29, tokens: 464333 }
id: l-106ffb6d
scope: repo
status: active
replaces: l-714667a2
src: agent
touches:
  - src/hosts/instructions.ts
  - src/notes/notes.ts
  - src/telemetry/track.ts
  - src/claude/hooks.ts
---

## Decided
- Checked on 2026-10-30 with real Codex sessions (the CLI bundled in ChatGPT.app, 0.162), a before (trail 0.26.0) and after (this branch) build, hooks untrusted and trusted. Codex runs `trail ask` from AGENTS.md either way and follows the learnings it prints.
- Untrusted hooks: Codex gets nothing about learnings except what AGENTS.md says. Asked to save a rule, the old AGENTS.md led Codex to hand-edit a teammate's learning file; the new Learnings part (`TRAIL_LEARNINGS` in src/hosts/instructions.ts) made it use `trail note`, which saved from inside the sandbox once `writeNote` stopped needing `~/.trail`.
- Trusted hooks: the session-start text, the prompt learnings and the save directive all reach Codex's model (they show in the rollout as additional_context).
- Hook events now carry the payload's host: the hook sets `TRAIL_AGENT_HOST` (src/telemetry/track.ts `HOST_ENV`) for itself and the trail commands it starts, so `hook_ms`, the prompt hook's query and `repo_seen` say `codex`, not `cli`.
- Claude Desktop's Code tab runs every hook (state shows SessionStart, prompt, PreToolUse, PostToolUse, PostToolUseFailure and Stop), but in a worktree session the project dir is the main checkout: learnings on a file edited in the worktree never matched. `learningsOnTouch` now takes the path relative to the file's own checkout.

## Watch out
- In none of the runs did Codex save a learning unasked, even when the prompt stated a team rule and the save directive was in context.
- Codex's sandbox can't write `~/.graft`, so trail commands Codex runs itself send no telemetry, whatever the host. Only hook events count Codex.
- The `model` in ~/.codex/config.toml (`gpt-5.6-sol`) is refused with a ChatGPT sign-in; leave model unset. Test trusted hooks with `codex exec --dangerously-bypass-hook-trust`. Put the test HOME outside /tmp and $TMPDIR, or the sandbox can write it and hides the ~/.trail problem.
- In a Desktop worktree session, session-start and prompt learnings still come from whatever branch the main checkout has checked out.
