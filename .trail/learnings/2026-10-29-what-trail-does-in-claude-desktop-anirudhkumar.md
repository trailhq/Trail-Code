---
title: "What trail does in Claude Desktop and Codex, and why Codex needed AGENTS.md and a sandbox-safe note"
author: Anirudhkumar-nanonets
date: 2026-10-29
branch: claude/desktop-and-codex-hosts-cde008
cost: { minutes: 4, tokens: 72330 }
id: l-714667a2
scope: repo
status: active
src: agent
touches:
  - src/hosts/instructions.ts
  - src/notes/notes.ts
  - src/telemetry/track.ts
  - src/claude/hooks.ts
---

## Decided
- Claude Desktop's Code tab is Claude Code with `CLAUDE_CODE_ENTRYPOINT=claude-desktop` (and `CLAUDECODE` set). It loads `.claude/settings.json` and `~/.claude/settings.json`, so SessionStart, prompt and touch learnings and `trail note` all work there (checked live 2026-10-29). Telemetry now reports it as `agent_host: claude-desktop` (`claudeHost` in src/telemetry/track.ts); before, it was counted as `claude-code`.
- Codex (CLI, and the app that shares `~/.codex`) runs trail's hooks only after the person trusts them in `/hooks`; trail can't write that trust record. Until then AGENTS.md is the only thing Codex reads, so the trail AGENTS.md block now says where learnings are and how to save one (`TRAIL_LEARNINGS` in src/hosts/instructions.ts). Graft's block is unchanged.
- Codex hooks used to report as `claude-code` and Codex shell commands as `cli`. `telemetryHost` in src/claude/hooks.ts now passes `codex` from the payload, and `detectHost` reads Codex's shell variables.

## Watch out
- Codex's default sandbox can't write `~/.trail`. `writeNote` called `ensureRepoHome` first, so `trail note` failed with EACCES before writing the repo learning. It now falls back to `repoPlace` for a repo learning; a `--personal` one still needs `~/.trail`.
- Claude Desktop chat (the claude.ai connector) gets learnings only from trail-cloud's MCP server (`get_context`, `save_learning`). Those are saved to the workspace, not to `.trail/learnings/`, so they never count in `learnings_committed`. Nothing in this repo serves chat.
