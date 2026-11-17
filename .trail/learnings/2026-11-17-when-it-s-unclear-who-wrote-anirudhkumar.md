---
title: "When it's unclear who wrote a line in Claude's transcript, trail counts it as not typed by the person"
author: Anirudhkumar-nanonets
date: 2026-11-17
branch: claude/fix-save-learning-prompts-84888d
cost: { minutes: 1, tokens: 10958 }
id: l-6b0c32a7
scope: repo
status: active
src: agent
touches:
  - "src/trace/claude.ts#candidateText"
  - "src/trace/claude.ts#ownText"
  - "src/claude/note-signals.ts#typed"
---

## Decided
- Claude Code keeps adding lines to the person's slot in its transcript that the person never typed: Desktop's status block before each message, the compaction summary, messages from other sessions, artifact comments, prompts queued while Claude was busy. The format isn't documented as stable, so expect more of these.
- trail counts a line as the person's only when it is clearly theirs, and stays quiet when unsure. A missed save ask costs one learning. A false one ("The user corrected you" quoting a compaction summary) makes people stop trusting every later ask.
- One filter decides this for every learning path. No hook keeps its own copy: the Stop hook's own copy drifted, and that caused the missed Desktop corrections and the false compaction ask.

## Tried and ruled out
- A per-hook filter tuned to what that hook needs: it fell behind each time Claude Code added a new kind of line, and nobody noticed until a false or missed ask.

## Watch out
- A missing `origin` still counts as the person, because the CLI and older transcripts don't set one. So a new harness line with no `origin` and none of the skip flags gets through until its text shape is added to the not-typed patterns. When an ask quotes words the person never wrote, add that shape there, and add the real transcript line as a test.

In the code: src/trace/claude.ts `candidateText` (the skip flags `isMeta`, `isSidechain`, `isCompactSummary`, `isVisibleInTranscriptOnly`, and `origin.kind` must be `human` or absent), `ownText` (`WRAPPED`, `NOT_TYPED`, `ARTIFACT_COMMENT`), `typedText`; src/claude/note-signals.ts `typed` calls it; tests in test/trace-typed.test.ts and test/trail-note-ask.test.ts.
