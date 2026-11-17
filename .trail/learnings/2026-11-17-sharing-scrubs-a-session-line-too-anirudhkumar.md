---
title: "Sharing scrubs a session line too deep to walk as plain text, and leaves out a session it can't scrub instead of stopping"
author: Anirudhkumar-nanonets
date: 2026-11-17
branch: fix/share-session-deep-nesting
cost: { minutes: 1, tokens: 1550 }
id: l-96699c8a
scope: repo
status: active
src: agent
touches:
  - src/cloud/share-session.ts
  - src/cloud/share-bundle.ts
  - src/cloud/share-sync.ts
  - src/trace/redact.ts
---

## Decided
- A session line nested more than 200 objects or arrays deep is scrubbed as plain text (`redactText`, then `anonymize`), the same way a line that isn't JSON is. Walking it with the recursive `walk`, and the `JSON.stringify` after it, ran out of stack at about 3,000 levels. That threw "Maximum call stack size exceeded" partway through scrubbing and ended the whole share with nothing sent. A teammate hit it on 17 Nov at session 29 of 83.
- A .env read nested that deep is left out (counted in `leftOut`): its values can only be found in parsed tool output, not in the raw text.
- A session the scrub still throws on never stops the run and is never sent unscrubbed. `prepareBundle` leaves it out and lists it in the manifest's `unreadable` and in SUMMARY.md. `runSync` skips it the way it skips a session that's too big, until the session grows.
- The scrub's regexes may only start where a run of their characters starts (a lookbehind): `IN_WORD`'s link-password pattern in redact.ts, and `EMAIL` in share-session.ts. Allowed to start at every letter, they re-read a long word to its end from each one, and a 1 to 2 MB word never finished.

## Tried and ruled out
- `JSON.parse` as the limit: V8 parses a line nested 12,000 deep without trouble. The overflow comes from walking the parsed value and writing it back.
- Making only `walk` iterative: `JSON.stringify` of the cleaned value recurses too, so one depth check before the walk covers both.

## Watch out
- A deep line scrubbed as text stays valid JSON unless `redactText` has to replace the whole line (`[redacted] line (…)`). Anything that reads shared bundles must accept non-JSON lines, as it already must for lines that weren't JSON to begin with.
- A new pattern in the scrub or in `secretReason` needs the same care: test it on a 1 MB run of the characters it matches.

In the code: `nestsDeeper` and `MAX_WALK_DEPTH` in src/cloud/share-session.ts; `unreadable` and `scrub` in src/cloud/share-bundle.ts; `scrub` in src/cloud/share-sync.ts; `IN_WORD` in src/trace/redact.ts. Repro: one `.jsonl` line `{"type":"user","toolUseResult":{"a":{"a":…}}}` nested 3,000 deep, run through `bundleSession`.
