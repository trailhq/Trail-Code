/**
 * Getting the queue off the machine without any command ever waiting for it.
 *
 * Deliberately the same shape as `maybeRefreshInBackground` in `upkeep.ts`,
 * which has been doing this for the npm registry check since 0.7: check a
 * timestamp, write the timestamp BEFORE spawning so a child that dies cannot
 * make every subsequent command spawn another one, then `spawn` detached and
 * `unref`. The parent returns immediately and never learns the outcome.
 *
 * Once a day, not once a command. Events are cheap to hold and the questions we
 * are asking ("how many repos activated this week") do not get better answers
 * from lower latency.
 */
import { spawn } from 'node:child_process';
import { statSync } from 'node:fs';
import { graftCliPath } from '../claude/paths.js';
import { drain, queuePath, requeue } from './queue.js';
import { patchState, readState } from './identity.js';
import { sendBatch, type SendResult } from './send.js';
import { telemetryOn } from './gate.js';

/** Matches `UPDATE_TTL_MS`: a day is the natural period for both. */
export const FLUSH_TTL_MS = 24 * 60 * 60 * 1000;

function queueHasEvents(home?: string): boolean {
  try { return statSync(queuePath(home)).size > 0; } catch { return false; }
}

export function needsFlush(flushedAt: number | undefined, now = Date.now()): boolean {
  return typeof flushedAt !== 'number' || now - flushedAt >= FLUSH_TTL_MS;
}

/**
 * Spawn the flush if the queue has something in it and a day has passed. Returns
 * whether a child was started, for tests. Never waits, never throws.
 */
export function maybeFlushInBackground(home?: string, now = Date.now()): boolean {
  try {
    if (!telemetryOn(home)) return false;
    if (!queueHasEvents(home)) return false;
    if (!needsFlush(readState(home)?.flushedAt, now)) return false;
    patchState({ flushedAt: now }, home); // before the spawn, so a dying child costs one attempt
    // patchState tolerates write failures; only spawn if the daily limit was saved.
    if (readState(home)?.flushedAt !== now) return false;
    const child = spawn(process.execPath, [graftCliPath(), '_telemetry-flush'], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.unref();
    return true;
  } catch {
    return false; // no spawn available (sandbox, ENOMEM) — try again tomorrow
  }
}

/**
 * Whether a failed send is worth keeping the batch for.
 *
 * A 5xx or a transport failure is ours to retry — a week offline should not be
 * a week of lost events. A 4xx is not: a bad key or a malformed batch will fail
 * identically forever, and retrying it would pin the queue at its cap until it
 * starts dropping the events that WOULD have sent.
 */
export function shouldRequeue(res: SendResult): boolean {
  if (res.ok) return false;
  return res.status === undefined || res.status >= 500;
}

/** The `graft _telemetry-flush` body, running in the detached child. */
export async function runFlush(home?: string): Promise<void> {
  try {
    if (!telemetryOn(home)) return;
    const events = drain(home);
    if (events.length === 0) return;
    if (shouldRequeue(await sendBatch(events))) requeue(events, home);
  } catch { /* a failed flush is a non-event by design */ }
}
