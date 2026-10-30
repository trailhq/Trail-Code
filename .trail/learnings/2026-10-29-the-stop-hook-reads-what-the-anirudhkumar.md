---
title: "The Stop hook reads what the person typed through the shared transcript filter, and counts its asks in note_asked"
author: Anirudhkumar-nanonets
date: 2026-10-29
branch: claude/fix-save-learning-prompts-84888d
cost: { minutes: 1, tokens: 7385 }
id: l-523d6adc
scope: repo
status: active
src: agent
touches:
  - src/claude/note-signals.ts
  - src/trace/claude.ts
  - src/claude/skills-wiring.ts
  - test/trail-words.test.ts
  - src/skills/risk.ts
  - src/claude/stop.ts
  - src/cloud/diff.ts
  - src/telemetry/contract.ts
---

## Decided
- The save ask's `typed()` (src/claude/note-signals.ts) calls `typedText` from src/trace/claude.ts, the filter every other learning path uses. Its own copy dropped any message starting with `<`, and Claude Desktop puts a `<system-reminder>` status block before every message the person types, so in Desktop sessions no correction or option pick was ever seen.
- `ownText` (src/trace/claude.ts) opens an artifact comment ("[Artifact comment sent to Claude]" … `=== BEGIN ARTIFACT COMMENT <token> ===`) to its quoted lines; before, the whole harness wrapper counted as typed.
- New event `note_asked` {kind, saved: repo|personal|no}, sent from `askForNote` on the stop after an ask (`stop_hook_active`). `askAnswer` checks the last "Stop hook feedback" line is trail's ask (it contains the ask's closing text), so another hook's block isn't counted.

## Tried and ruled out
- A property on `hook_ms` for the Stop hook: it is sent only when learned skills are enabled (src/claude/skills-wiring.ts), so most stops would go uncounted.
- A property on `note_saved` alone: it gives the saves but not how many corrections were asked about, so no share.

## Watch out
- Agent-facing text (session start, skill, asks) must not say "memory", "notes" or "rules": test/trail-words.test.ts bans them. Say "your own copy".
- `shellEdit` treats a write it can't name as a repo edit. A leading `cd` outside the repo, or full paths that all point outside it, now mean no edit; a bare `python3 - <<EOF … open(p,'w')` from the repo still counts.
- Writing a learning through a heredoc that mentions the skills switch words trips the pre-bash guard (src/skills/risk.ts); pipe the body from a file.

In the code: src/claude/note-signals.ts (`typed`, `CORRECTION_RULE`, `shellEdit`, `askAnswer`, `PERSONAL`), src/trace/claude.ts (`ownText`), src/claude/stop.ts (`askForNote`), src/cloud/diff.ts (`branchAddsLearning`), src/telemetry/contract.ts.
