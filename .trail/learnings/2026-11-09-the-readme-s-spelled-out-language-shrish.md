---
title: "The README's spelled-out language count makes every new-language PR conflict with every other"
author: Shrish
date: 2026-11-09
branch: docs/readme-language-count
cost: { minutes: 39, tokens: 83938 }
id: l-e43790d6
scope: repo
status: active
src: agent
touches:
  - test/mcp-server.test.ts
  - src/claude/settings-merge.ts
  - test/claude-init.test.ts
  - test/claude-settings-merge.test.ts
  - test/hosts-claude-global.test.ts
  - test/hosts-retract.test.ts
  - src/ai/llm/recover-tool.ts
  - test/llm-ops.test.ts
  - src/graph/build.ts
  - src/graph/extract-cache.ts
---

## Watch out
The README says "Twenty-four languages, plus Vue, Svelte and Astro..." in words, and lists the languages in a bullet a few lines up. Every PR that adds a language (Julia, Bash, GLSL, PowerShell landed in the same week) edits both lines, so they all conflict with each other and each needs a rebase after the previous one merges.

## Decided
When several language PRs land together, resolve their README conflicts by keeping main's count line and fix the count once in a follow-up after the batch merges, instead of rebasing each PR through CI again.

In the code: README.md, the "N languages, plus Vue..." sentence and the "symbols only" language list; src/graph/generic.ts registry rows are the source of truth for what's supported.
