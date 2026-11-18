/**
 * Rolling a finished agent session up into one `session_summary` event.
 *
 * This is the event that justifies the whole exercise. Everything else here
 * counts commands; this one answers the question the product actually rests on —
 * when an agent had both graft and grep available, which did it reach for, and
 * how many tokens did that save? The counters already exist: the Claude Code
 * hooks have been writing `graftReads`, `sourceReads` and `savedTokens` per
 * session into `graft/.cache/session/` since well before telemetry did. Nothing
 * new is measured here; a closed session is simply bucketed and queued.
 *
 * "Closed" is inferred from mtime by the idle sweep ({@link flushClosedSessions})
 * because Claude Code has no reliable end-of-session hook — `Stop` fires per
 * turn, and an editor that crashes fires nothing at all. A session untouched for
 * two hours is over. Cursor DOES have `sessionEnd`, so it force-closes the exact
 * conversation that just ended via {@link summarizeSession}, skipping the idle
 * gate that would otherwise ignore the file the last tool use just wrote.
 *
 * A closed session's unanswered "did it help?" (claude/learning-vote.ts) goes
 * out with it as a `none` vote, so idle sessions count toward the answer rate.
 *
 * Called from the session-start hook (the sweep) and the Cursor sessionEnd hook
 * (the force-close) — both places guaranteed to run at the right moment. A hook
 * must never touch the network (see the note atop upkeep.ts) and this doesn't:
 * it only appends to the local queue.
 */
import { statSync } from 'node:fs';
import { join } from 'node:path';
import { readSession, writeSession, sessionDir, listSessionIds } from '../claude/state.js';
import { closeVote } from '../claude/learning-vote.js';
import { countBucket, savedTokensBucket, type AgentHost } from './contract.js';
import { track } from './track.js';
import { telemetryOn } from './gate.js';

/** Untouched for this long and the session is treated as over. */
export const SESSION_IDLE_MS = 2 * 60 * 60 * 1000;

/** Never roll up more than this in one hook run — a repo with a huge backlog of
 *  session files must not slow down a session start. The rest wait for the next. */
const MAX_PER_RUN = 20;

/**
 * Roll one session up into a `session_summary`, ignoring the idle gate — for a
 * host with a real end-of-session signal (Cursor's `sessionEnd`). Returns 1 if
 * queued, 0 if already summarised or telemetry is off. Never throws.
 *
 * The event is attributed to the host stamped on the session file when there is
 * one (a session used from Cursor stays Cursor even if Claude's idle sweep is
 * what finally flushes it); `opts.host` is only the fallback for a file written
 * before host-stamping, or by a path that didn't stamp.
 */
export function summarizeSession(
  repo: string,
  id: string,
  opts: { host?: AgentHost; home?: string; env?: NodeJS.ProcessEnv } = {},
): number {
  try {
    const { host = 'claude-code', home, env } = opts;
    if (!telemetryOn(home, env)) return 0;

    const s = readSession(repo, id);
    // A "did it help?" still waiting when the session closes was never answered.
    const vote = closeVote(s);
    if (vote) track('learning_rated', { vote: 'none', learning_id: vote.learning }, { repo, host: s.host ?? host, home, env });
    if (s.summarized) {
      if (vote) writeSession(repo, id, s);
      return 0;
    }

    // An empty session — opened, nothing asked — is still a fact worth having:
    // it is the difference between "graft is installed" and "graft is used".
    track(
      'session_summary',
      {
        graft_reads_bucket: countBucket(s.graftReads ?? 0),
        source_reads_bucket: countBucket(s.sourceReads ?? 0),
        saved_tokens_bucket: savedTokensBucket(s.savedTokens ?? 0),
        // Saved vs *said*: the gap between these two is value the user never
        // heard about. Only turns whose reply was actually readable are in
        // either count (claude/tally.ts), so a host that exposes no transcript
        // reports 0/0 rather than a misleading 0-out-of-many.
        graft_turns_bucket: countBucket(s.graftTurns ?? 0),
        reported_turns_bucket: countBucket(s.reportedTurns ?? 0),
      },
      { repo, host: s.host ?? host, home, env },
    );
    writeSession(repo, id, { ...s, summarized: true });
    return 1;
  } catch {
    return 0;
  }
}

/**
 * Queue a `session_summary` for every closed, not-yet-summarised session in this
 * repo. "Closed" = untouched for {@link SESSION_IDLE_MS}. Returns how many were
 * queued (for tests). Never throws.
 */
export function flushClosedSessions(
  repo: string,
  now = Date.now(),
  home?: string,
  env?: NodeJS.ProcessEnv,
  host: AgentHost = 'claude-code',
): number {
  try {
    if (!telemetryOn(home, env)) return 0;
    const dir = sessionDir(repo);

    let queued = 0;
    for (const id of listSessionIds(repo).sort()) {
      if (queued >= MAX_PER_RUN) break;
      let mtime: number;
      try { mtime = statSync(join(dir, `${id}.json`)).mtimeMs; } catch { continue; }
      if (now - mtime < SESSION_IDLE_MS) continue;
      queued += summarizeSession(repo, id, { host, home, env });
    }
    return queued;
  } catch {
    return 0; // a session start is never worth failing over a metric
  }
}
