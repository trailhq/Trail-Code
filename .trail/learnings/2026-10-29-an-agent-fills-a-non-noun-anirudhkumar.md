---
title: "An agent fills a non-noun kind in init's relay with 'skill', so each kind must be a noun"
author: Anirudhkumar-nanonets
date: 2026-10-29
branch: claude/init-offer-says-what-it-does-86e280
cost: { minutes: 1, tokens: 3914 }
id: l-679ad763
scope: repo
status: active
src: agent
touches:
  - src/init/review-screen.ts
  - src/trace/walls.ts
  - src/skills/cli-skills-report-1b.ts
  - src/init/handover.ts
---

## Decided
- Every kind in `relayItemLine` (src/init/review-screen.ts) is a noun phrase. An always-follow offer reads `(always-follow learning)` and carries what it makes Claude do, from the wall's `does` sentence (src/trace/walls.ts). The relay opens with FROM_TRAIL ("the tool this person installed to keep commands that worked as skills"), so when the kind was the bare mark `always follow`, Claude supplied its own noun and called it "a skill" (2026-10-29: a first-time user couldn't tell what no-timeout did).
- `cold_start` carries exact per-kind counts: `offered_*` on found/relayed/cancelled, `kept_*` on outcome kept (both the terminal screen and the keep command an agent runs).

## Tried and ruled out
- Reusing `guardrailDoes` (src/skills/cli-skills-report-1b.ts): it describes the PreToolUse enforcement, not what Claude does.
- Rewording FROM_TRAIL: every directive shares it and many tests pin it; a noun for the kind was enough.

## Watch out
- The handover (src/init/handover.ts `pendingAsItem`) rebuilds items with `description: ''`, so anything the relayed line shows must come from stable fields like `guardrail.cls`, never from `description`.
- Before this change the agent's keep command sent `cold_start {source: keep, outcome: kept}` with no count or kind, so the relay path's keep rate before 2026-10-29 can only be read as keep runs per relayed list.
