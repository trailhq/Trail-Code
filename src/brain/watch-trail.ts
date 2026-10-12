/**
 * `graft trail watch`: wait until Trail has something for this repo, then say so
 * once.
 *
 * Trail suggests changes to a repository's CLAUDE.md and its other context files
 * while it reads the history, and a person reviews and accepts them in the
 * browser. Until now the only way for a coding agent to notice either was a loop
 * the agent wrote for itself — a setup prompt told Claude to save a
 * `graft-watcher.sh` that ran `graft trail pull --dry-run` every minute and
 * grepped the text. That loop parsed sentences written for people, broke on
 * every rewording, and printed a screenful per tick into a session that only
 * ever needed one line at the end.
 *
 * So this is that loop, done properly: it reads the same numbers the dry run
 * prints by calling the functions the pull itself is built on (`gatherPull`),
 * stays silent while nothing has changed, and ends with ONE block an agent can
 * relay as it stands — suggestions are waiting for review, accepted changes are
 * ready to pull, or it gave up waiting. `--json` is the same block for a script.
 *
 * The same read, capped at a few seconds, is what the session-start hook uses
 * to mention a trail that has something waiting (see `trailContextLine`).
 */
import type { BrainLink } from "./link.js";
import { gatherPull, type Gathered } from "./pull.js";
import { reviewUrl } from "./signup.js";
import { countBucket, durationBucket, type TRAIL_WATCH_REASONS } from "../telemetry/contract.js";
import { track } from "../telemetry/track.js";

/** One accepted change's file, and the sections it touches. */
export interface PendingFile {
  /** Repo-relative, forward slashes. */
  path: string;
  /** The headings of the sections the changes edit or add, in order, once
   *  each. Empty for a change that carries the whole file (a new Cursor rule,
   *  a skill), which has no section to name. */
  headings: string[];
}

/** What Trail holds for this checkout at one moment. */
export interface TrailSnapshot {
  /** Suggestions for the wired agents' files, every one Trail has made. Null
   *  when the counts could not be read this time. */
  suggested: number | null;
  /** Accepted changes a pull would still have to write: Trail's accepted list,
   *  less whatever is already in the files here. */
  accepted: number;
  /** The files those accepted changes land in. */
  files: PendingFile[];
  /** The accepted changes' ids, sorted — what "has not changed" is judged on,
   *  so one change accepted and another un-accepted in the same minute is still
   *  a change even though the count held. */
  ids: string[];
  reviewUrl: string;
}

export type SnapshotResult =
  | { ok: true; snapshot: TrailSnapshot }
  | {
      ok: false;
      error: string;
      /** True when waiting cannot help: Trail answered and refused (a revoked
       *  or wrong token). False for anything the next tick may not hit. */
      fatal: boolean;
    };

/**
 * The accepted changes a pull would still write, file by file, out of a planned
 * pull. Changes already in the file are left out: the pull only tells Trail
 * about those, so they are nothing to wait for. Changes the pull would skip (the
 * file moved on since Trail read it) stay in — they are accepted and not
 * written, and the pull is where someone hears why.
 */
export function pendingFrom(g: Gathered): { accepted: number; files: PendingFile[]; ids: string[] } {
  const files: PendingFile[] = [];
  const ids: string[] = [];
  for (const { plan } of g.planned) {
    const changes = [...plan.written, ...plan.skipped.map((s) => s.change)];
    if (changes.length === 0) continue;
    const headings: string[] = [];
    for (const c of changes) {
      ids.push(c.id);
      const h = (c.kind === "edit" || c.kind === "add") && c.heading ? c.heading.trim() : "";
      if (h && !headings.includes(h)) headings.push(h);
    }
    // Two entries for one path (the root CLAUDE.md is fetched on its own route)
    // are one file to a reader.
    const same = files.find((f) => f.path === plan.path);
    if (!same) files.push({ path: plan.path, headings });
    else for (const h of headings) if (!same.headings.includes(h)) same.headings.push(h);
  }
  return { accepted: ids.length, files, ids: ids.sort() };
}

/** 401 and 403 are a token Trail no longer takes; nothing else is final. */
const FATAL_STATUS = new Set([401, 403]);

/**
 * One read of what Trail holds for this checkout. Never throws: every failure
 * comes back as a result, marked fatal only when waiting cannot fix it.
 */
export async function readTrailSnapshot(
  repo: string,
  link: BrainLink,
  wired: string[],
  fetchImpl: typeof fetch = fetch,
): Promise<SnapshotResult> {
  try {
    const g = await gatherPull(repo, link, wired, fetchImpl);
    if (g.errors.length > 0) {
      return {
        ok: false,
        error: g.errors.map((e) => e.message).join("; "),
        fatal: g.errors.some((e) => e.status !== undefined && FATAL_STATUS.has(e.status)),
      };
    }
    const pending = pendingFrom(g);
    return {
      ok: true,
      snapshot: { suggested: g.suggested ? g.suggested.count : null, ...pending, reviewUrl: reviewUrl(link.brainId) },
    };
  } catch (e) {
    return { ok: false, error: `could not read the trail: ${e instanceof Error ? e.message : e}`, fatal: false };
  }
}

/* -------------------------------------------------------------------------- */
/* the watch                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Why the watch ended. `suggestions`: there are suggestions and none accepted —
 * someone has reviewing to do. `accepted`: accepted changes, holding still.
 * `timeout`: neither, after `--timeout`. `refused`: Trail turned the token
 * away. `no_trail`: nothing attached to watch.
 */
export type WatchExitReason = (typeof TRAIL_WATCH_REASONS)[number];

export interface WatchTrailResult {
  reason: WatchExitReason;
  /** Last known counts; null suggested when they were never read. */
  suggested: number | null;
  accepted: number;
  files: PendingFile[];
  reviewUrl: string;
  waitedMs: number;
  /** For `refused`: Trail's own words. */
  error?: string;
  /** False when not one read succeeded, so a timeout can say it never got through. */
  everRead: boolean;
}

export interface WatchTrailOptions {
  wired: string[];
  /** Between reads. Default a minute: Trail's build adds suggestions over
   *  minutes and a person reviews them over longer, so anything shorter is
   *  requests nobody is waiting on. */
  intervalMs?: number;
  /** How long the accepted set must hold still before it is reported. Someone
   *  accepting changes one at a time is mid-review; reporting the first would
   *  send the agent off to pull while they are still clicking. */
  settleMs?: number;
  timeoutMs?: number;
  /** Keep waiting while suggestions are only waiting for review. */
  acceptedOnly?: boolean;
  fetchImpl?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Every read, for `--verbose`. */
  onTick?: (r: SnapshotResult) => void;
}

export const WATCH_DEFAULTS = { intervalMs: 10_000, settleMs: 10_000, timeoutMs: 60 * 60_000 } as const;

/**
 * Read Trail every interval until one of three things is true, and return which.
 *
 *  - Suggestions and nothing accepted (unless `acceptedOnly`): the person has
 *    reviewing to do, and saying so now is the point — waiting on them to
 *    accept something first would hold the agent for as long as they take.
 *  - Accepted changes that have not changed for `settleMs`.
 *  - `timeoutMs` passed.
 *
 * A read that fails for a reason the next one may not hit (the network, a 5xx)
 * is simply retried on the next tick; only a refused token ends the watch early.
 */
export async function watchTrail(repo: string, link: BrainLink, opts: WatchTrailOptions): Promise<WatchTrailResult> {
  const intervalMs = opts.intervalMs ?? WATCH_DEFAULTS.intervalMs;
  const settleMs = opts.settleMs ?? WATCH_DEFAULTS.settleMs;
  const timeoutMs = opts.timeoutMs ?? WATCH_DEFAULTS.timeoutMs;
  const now = opts.now ?? Date.now;
  // Not unref'd: between reads this timer is the only thing the process is
  // waiting on, and an unref'd one would let it exit mid-watch with nothing
  // printed — the same trap watch.ts documents for the build watcher.
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  // Every request carries X-Graft-Watch, which is how Trail knows something is
  // watching this trail right now and can tell the page that Claude Code will
  // ask before pulling, instead of telling the person to run the pull. A manual
  // pull and the session-start check do not send it.
  const fetchImpl = withWatchHeader(opts.fetchImpl ?? fetch);

  const startedAt = now();
  const deadline = startedAt + timeoutMs;
  let last: TrailSnapshot | null = null;
  let lastSuggested: number | null = null;
  // The accepted set as last seen, and since when it has looked like that.
  let heldKey: string | null = null;
  let heldSince = startedAt;

  const result = (reason: WatchExitReason, extra: Partial<WatchTrailResult> = {}): WatchTrailResult => ({
    reason,
    suggested: lastSuggested,
    accepted: last?.accepted ?? 0,
    files: last?.files ?? [],
    reviewUrl: reviewUrl(link.brainId),
    waitedMs: now() - startedAt,
    everRead: last !== null,
    ...extra,
  });

  for (;;) {
    const r = await readTrailSnapshot(repo, link, opts.wired, fetchImpl);
    opts.onTick?.(r);
    let wakeAt = now() + intervalMs;
    if (r.ok) {
      const s = r.snapshot;
      last = s;
      // A counts request that failed this time is not "no suggestions": keep
      // the last number rather than let one blip read as zero.
      if (s.suggested !== null) lastSuggested = s.suggested;
      const key = s.ids.join("\n");
      if (key !== heldKey) {
        heldKey = key;
        heldSince = now();
      }
      if (s.accepted > 0) {
        if (now() - heldSince >= settleMs) return result("accepted");
        // Wake when the set would have settled, not a whole interval later.
        wakeAt = Math.min(wakeAt, heldSince + settleMs);
      } else if (!opts.acceptedOnly && (s.suggested ?? 0) > 0) {
        return result("suggestions");
      }
    } else if (r.fatal) {
      return result("refused", { error: r.error });
    }
    if (now() >= deadline) return result("timeout");
    await sleep(Math.max(0, Math.min(wakeAt, deadline) - now()));
  }
}

/* -------------------------------------------------------------------------- */
/* what it says                                                               */
/* -------------------------------------------------------------------------- */

const fmt = (n: number) => n.toLocaleString("en-US");
const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

/** `CLAUDE.md (Commands, Testing), web/CLAUDE.md (SEO metadata)`. */
export function filesSummary(files: PendingFile[]): string {
  return files.map((f) => (f.headings.length ? `${f.path} (${f.headings.join(", ")})` : f.path)).join(", ");
}

/** `60 minutes`, `1 minute`, `30 seconds`. */
function span(ms: number): string {
  if (ms >= 60_000) {
    const m = Math.round(ms / 60_000);
    return `${m} ${plural(m, "minute", "minutes")}`;
  }
  const s = Math.max(1, Math.round(ms / 1000));
  return `${s} ${plural(s, "second", "seconds")}`;
}

/**
 * The one block the watch prints when it ends — written to be relayed as it
 * stands, so every ending names the next step.
 *
 * `timeoutMs` is the configured timeout, which is what "still waiting after"
 * should say rather than the few seconds past it the last read took.
 */
export function watchExitLines(r: WatchTrailResult, timeoutMs: number): string[] {
  switch (r.reason) {
    case "suggestions": {
      const n = r.suggested ?? 0;
      return [`● ${fmt(n)} ${plural(n, "suggestion is", "suggestions are")} waiting for review`, `  review: ${r.reviewUrl}`];
    }
    case "accepted": {
      const where = filesSummary(r.files);
      return [
        `✓ ${fmt(r.accepted)} accepted ${plural(r.accepted, "change is", "changes are")} ready${where ? `: ${where}` : ""}`,
        `  run graft trail pull to write ${plural(r.accepted, "it", "them")}`,
      ];
    }
    case "timeout": {
      if (!r.everRead) return [`· still waiting after ${span(timeoutMs)}: could not reach Trail`];
      const lines = [`· still waiting after ${span(timeoutMs)}: ${fmt(r.suggested ?? 0)} suggested, ${fmt(r.accepted)} accepted`];
      if ((r.suggested ?? 0) > 0) lines.push(`  review: ${r.reviewUrl}`);
      return lines;
    }
    case "refused":
      return [`✗ ${r.error ?? "Trail refused the request"}`, "  the trail's token may have been revoked — attach it again with graft trail connect"];
    case "no_trail":
      return ["✗ this repo has no trail yet — run graft trail push first"];
  }
}

/** The same ending, for a script. Counts are exact here: this goes to the
 *  caller's own terminal, not over the wire. */
export function watchExitJson(r: WatchTrailResult): Record<string, unknown> {
  return {
    reason: r.reason,
    suggested: r.suggested,
    accepted: r.accepted,
    files: r.files,
    review_url: r.reason === "no_trail" ? null : r.reviewUrl,
    waited_s: Math.round(r.waitedMs / 1000),
    ...(r.error ? { error: r.error } : {}),
  };
}

/** Exit code: 0 when there is something to act on, 2 for a timeout (distinct,
 *  so a script can tell "nothing yet" from "broken"), 1 for everything else. */
export function watchExitCode(r: WatchTrailResult): number {
  if (r.reason === "suggestions" || r.reason === "accepted") return 0;
  if (r.reason === "timeout") return 2;
  return 1;
}

/**
 * The `trail_watch_exit` event. Counts as buckets and the reason as a member of
 * a fixed set, like every other event — see TELEMETRY.md.
 */
export function trackWatchExit(repo: string, r: WatchTrailResult): void {
  track(
    "trail_watch_exit",
    {
      reason: r.reason,
      suggested_bucket: countBucket(r.suggested ?? 0),
      accepted_bucket: countBucket(r.accepted),
      duration_bucket: durationBucket(r.waitedMs),
    },
    { repo },
  );
}

/* -------------------------------------------------------------------------- */
/* the session-start line                                                     */
/* -------------------------------------------------------------------------- */

/** `CLAUDE.md: Commands, Testing; web/CLAUDE.md: SEO metadata` — the inline
 *  form, which sits inside parentheses in a sentence. */
function filesInline(files: PendingFile[]): string {
  return files.map((f) => (f.headings.length ? `${f.path}: ${f.headings.join(", ")}` : f.path)).join("; ");
}

/**
 * The line the session-start hook adds when the trail has something waiting,
 * or null when it has nothing worth a session's attention. Addressed to the
 * agent, which is who reads a hook's context: what is waiting, and what to ask
 * the person.
 *
 * Accepted changes are always mentioned: they are one command away from done,
 * and they stop being mentioned the moment that command runs.
 *
 * Suggestions are not like that. Trail's count is every suggestion it has ever
 * made for these files, whatever became of it, so it only ever grows — and a
 * line repeating "12 suggestions are waiting" at the start of every session,
 * long after all twelve were reviewed, is a nag the agent learns to ignore
 * along with everything else in the opening context. So suggestions are
 * mentioned only when the count has grown past `lastSeen`, the count this
 * repo's hook saw the time before, and then only the difference. With no count
 * seen before, they are mentioned once, in full.
 */
export function trailContextLine(s: TrailSnapshot, lastSeen?: number): string | null {
  if (s.accepted > 0) {
    const where = filesInline(s.files);
    return `Trail: ${fmt(s.accepted)} accepted ${plural(s.accepted, "change is", "changes are")} waiting${where ? ` (${where})` : ""}. Ask the user whether to run graft trail pull.`;
  }
  const n = s.suggested ?? 0;
  if (n <= 0) return null;
  if (lastSeen === undefined) {
    return `Trail: ${fmt(n)} ${plural(n, "suggestion is", "suggestions are")} waiting for review at ${s.reviewUrl}.`;
  }
  const d = n - lastSeen;
  if (d <= 0) return null;
  return `Trail: ${fmt(d)} new ${plural(d, "suggestion since your last session is", "suggestions since your last session are")} waiting for review at ${s.reviewUrl}.`;
}

/** `fetch` with X-Graft-Watch: 1 added to every request's headers. */
export function withWatchHeader(inner: typeof fetch): typeof fetch {
  return ((input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    headers.set("x-graft-watch", "1");
    return inner(input, { ...init, headers });
  }) as typeof fetch;
}
