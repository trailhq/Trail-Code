---
title: Trail telemetry timestamp is the send time; event time is occurred_at
author: Anirudhkumar-nanonets
date: 2026-10-29
branch: claude/telemetry-send-time-e70fe1
cost: { minutes: 14, tokens: 158925 }
id: l-3d21398f
scope: repo
status: active
src: agent
touches:
  - src/telemetry/send.ts
  - src/telemetry/track.ts
  - TELEMETRY.md
  - test/telemetry-send.test.ts
---

## Decided
- `buildBatch` in src/telemetry/send.ts sets PostHog's `timestamp` to the moment the batch is sent and moves the event's own time (the queued `timestamp` in ~/.graft/telemetry-queue.ndjson) into the `occurred_at` property. Asked for in a DM on 2026-10-26 so the PostHog→BigQuery sync can read only new rows instead of re-reading 7 days: with the event's own time, the once-a-day send kept back-filling days already loaded.
- Swapped rather than added a second field, because the request was for `timestamp` itself to be the send time. The queue format is unchanged, so events queued by an older trail and sent by a newer one get `occurred_at` too.

## Tried and ruled out
- Measuring arrival lag as `created_at - timestamp` in PostHog Postgres (Metabase db 11, `posthog_event`): `created_at` equals `timestamp` on every trail row (0.0 s across ~496k events, 2026-10-27..29). db 11 copies the time; it doesn't record arrival. After this change the lag is `timestamp - (properties->>'occurred_at')::timestamptz`.
- Wide scans of `posthog_event` without a `"timestamp"` range filter (e.g. `max(id)`, `created_at` ranges) time out through /api/dataset; filter on `"timestamp"` first.

## Watch out
- Any chart that buckets trail events by day now buckets by send day. Use `coalesce((properties->>'occurred_at')::timestamptz, "timestamp")`; trail 0.28.0 and older send no `occurred_at`.
