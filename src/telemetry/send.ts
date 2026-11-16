/**
 * The one network call in graft that is not an LLM request.
 *
 * A single POST of the whole queued batch to PostHog's capture endpoint, with
 * `fetch` and no SDK. `posthog-node` would be the conventional choice, but it is
 * a runtime dependency in a CLI whose install weight users notice, it wants to
 * own batching and flushing (both of which the queue already does, and does
 * differently because we are a short-lived process), and "an analytics library
 * that can see everything" is precisely the objection this whole design exists
 * to disarm. Twenty lines of `fetch` is auditable in a sitting.
 *
 * `$process_person_profile: false` on every event is what makes these ANONYMOUS
 * events in PostHog: no person profile is created, no identity is stored, and
 * the `distinct_id` is only ever the random install UUID.
 */
import { posthogKey, posthogHost } from './key.js';

/** Anything longer and the detached child is just holding a socket open. */
const SEND_TIMEOUT_MS = 8000;

export interface SendResult {
  ok: boolean;
  status?: number;
  /** Why it failed, for `graft telemetry debug` only — never itself reported. */
  error?: string;
}

/**
 * The events as PostHog wants them — everything the wire body contains EXCEPT
 * the project key.
 *
 * The key is deliberately not in here. `graft telemetry debug` prints this
 * object so a user can audit exactly what graft sends, and a command that exists
 * to be pasted into a bug report must not also paste our ingestion key into it.
 * `sendBatch` adds the key at the moment of the request and nowhere else, which
 * keeps the key entirely out of every code path that can reach a terminal.
 *
 * `timestamp` is when the batch is sent, not when the event happened; that
 * time travels as the `occurred_at` property. Events wait up to a day in the
 * queue, so with the event's own time a day already loaded in PostHog kept
 * gaining rows, and the PostHog→BigQuery sync re-read a week on every run. With
 * the send time, a loaded day is final.
 */
export function buildBatch(events: unknown[], sentAt: Date = new Date()): Record<string, unknown> {
  const timestamp = sentAt.toISOString();
  return {
    batch: events.map((e) => {
      const ev = e as { event: string; properties?: Record<string, string>; timestamp?: string; distinct_id?: string };
      return {
        event: ev.event,
        timestamp,
        properties: {
          ...(ev.properties ?? {}),
          occurred_at: ev.timestamp,
          distinct_id: ev.distinct_id,
          // Anonymous event: PostHog stores it without creating a person.
          $process_person_profile: false,
        },
      };
    }),
  };
}

/**
 * The ingest path.
 *
 * `/batch/` only, with no fallback. An earlier revision also tried `/e/`,
 * because assign's `frontend/src/lib/posthog.ts` documents `events.nanonets.com`
 * as serving the older path and answering `400 invalid_payload` to bodies it
 * will not take. Probed directly, that host returns **401** to a well-formed
 * batch with a bad key — so `/batch/` is there and does parse the body, and the
 * historical 400 was gzip from `posthog-js` in a browser, which we never send.
 *
 * The fallback was therefore a second request that could not fire, and a branch
 * production never exercises is worse than no branch. If a future host needs
 * `/e/`, point `GRAFT_POSTHOG_HOST` at it and add the path back with evidence.
 */
const INGEST_PATH = '/batch/';

export async function sendBatch(events: unknown[]): Promise<SendResult> {
  if (events.length === 0) return { ok: true };
  const key = posthogKey();
  if (!key) return { ok: false, error: 'no key' };
  try {
    const res = await fetch(`${posthogHost()}${INGEST_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      // The one place the key is ever attached: the request body itself.
      body: JSON.stringify({ api_key: key, ...buildBatch(events) }),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
    // A 4xx is our bug (a bad key, a malformed body) and retrying it forever
    // would pin the queue at its cap; only 5xx and transport errors go back on
    // the queue — see shouldRequeue in flush.ts.
    return { ok: res.ok, status: res.status };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.name : 'unknown' };
  }
}
