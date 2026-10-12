/**
 * The telemetry contract: the complete, machine-enforced list of what graft may
 * send. `TELEMETRY.md` is the same list in prose, and the two are kept in
 * lockstep — an event or property that is not in this file cannot be sent, and
 * one that is not in `TELEMETRY.md` must not be added here.
 *
 * Why an allowlist rather than a review rule: every telemetry incident in the
 * tools we studied came from a call site quietly adding a property nobody
 * audited. `track()` (track.ts) drops unknown events and unknown keys instead of
 * trusting its callers, so a future `track('query', { path })` sends `query`
 * with no `path` rather than leaking one. The blast radius of a careless call
 * site is "we lose a metric", never "we received someone's source tree".
 *
 * The other half of that guarantee is the value side: every number crosses as a
 * BUCKET and every string as a member of a fixed union. A raw file count plus a
 * language set starts to fingerprint a specific repo; `"100-500"` does not. A
 * raw error message is a path, a symbol, and sometimes a snippet of code; an
 * enum member is not.
 *
 * This module is pure — no I/O, no config, no clock. It is the file a reviewer
 * (or a suspicious user, since the repo is public) reads to verify the claim.
 */

/* -------------------------------------------------------------------------- */
/* the event → allowed-property-keys map                                      */
/* -------------------------------------------------------------------------- */

/**
 * The contract itself. Common properties (see {@link COMMON_KEYS}) are stamped
 * centrally by `track()` and are deliberately not repeated per event.
 */
export const EVENTS: Record<string, ReadonlySet<string>> = {
  /** Once per machine per version, from the npm postinstall hook. The real
   *  denominator: a machine that installs graft and never runs a command emits
   *  this event and no other, so it is the only place the "installed, never
   *  used" leak is visible at all. Version-scoped rather than once-ever so an
   *  upgrade counts; distinct install ids still give unique machines.
   *  `global` separates `npm i -g graft` from a project dependency, which is
   *  roughly the difference between a person and a lockfile. */
  install: new Set<string>(['global']),
  /** Once per machine, the first time a command actually runs. Paired with
   *  `install`, the gap between the two is the top of the funnel. */
  first_run: new Set<string>(),
  /** `graft init` completed. Tells us which agents people actually wire, and
   *  how many decline telemetry at the picker. */
  init_completed: new Set<string>(['agents', 'consent']),
  /** A build finished. The activation event — an install that never reaches one
   *  of these is the funnel leak we most want to see. */
  build_completed: new Set<string>(['files_bucket', 'langs', 'mode', 'duration_bucket', 'incremental']),
  /** A build threw. `stage`/`code` are enums; the message never travels. */
  build_failed: new Set<string>(['stage', 'code']),
  /** One query, from any surface. The DAU backbone and the dead-command detector. */
  query: new Set<string>(['command', 'surface', 'hit']),
  /** `graft trail push` in a repo with no brain, sending the user to Trail to
   *  make one. Queued the moment the link is printed, so a signup somebody
   *  walked away from is still counted — the settle below never fires for those,
   *  and abandonment is exactly the thing a terminal handoff loses silently. */
  brain_signup_opened: new Set<string>(['mode']),
  /** That handoff reaching an end. `outcome` is a closed set, so the reason a
   *  signup failed travels as a category and never as the error's own words. */
  brain_signup_settled: new Set<string>(['outcome', 'mode', 'duration_bucket']),
  /** `graft trail pull` reaching an end: whether accepted Trail suggestions
   *  made it into this checkout. `kinds` is which kinds of context file were
   *  written (a fixed set, sorted); every count is a bucket. Paths, headings and
   *  the changes' text never travel. The adoption number for Trail's context
   *  files: how many people actually take a suggestion home. */
  trail_pulled: new Set<string>(['outcome', 'kinds', 'files_bucket', 'changes_bucket', 'skipped_bucket', 'suggested_bucket']),
  /** `graft trail watch` ending. `reason` is a closed set (TRAIL_WATCH_REASONS);
   *  the counts it ended on and how long it waited are buckets. Whether the
   *  watcher that replaced the agent-written polling loop actually ends on
   *  something worth relaying, or mostly times out. */
  trail_watch_exit: new Set<string>(['reason', 'suggested_bucket', 'accepted_bucket', 'duration_bucket']),
  /** The session-start hook's background `graft trail push`: `started`, or
   *  `skipped` with a `reason` from a closed set (TRAIL_AUTOPUSH_SKIPS). Only for
   *  a repo with a trail attached — every other repo sends nothing. */
  trail_autopush: new Set<string>(['outcome', 'reason']),
  /** One closed agent session, summarised. `graft_reads` vs `source_reads` is
   *  the single number that says whether an agent prefers graft to grep; the two
   *  `*_turns` buckets are the follow-up question — of the turns that used graft,
   *  how many told the user what it saved. Both are counts of turns, never text. */
  session_summary: new Set<string>([
    'graft_reads_bucket', 'source_reads_bucket', 'saved_tokens_bucket',
    'graft_turns_bucket', 'reported_turns_bucket',
  ]),
};

/** Stamped on every event by `track()`; not listed per event above. */
export const COMMON_KEYS = [
  'app_version',
  'os',
  'arch',
  'node_major',
  'ci',
  'agent_host',
  'repo_id',
] as const;

/* -------------------------------------------------------------------------- */
/* the value enums                                                            */
/* -------------------------------------------------------------------------- */

/** Which surface issued a query. `hook` is Claude Code's prompt hook, which
 *  queries on the user's behalf without them typing a command. */
export type Surface = 'cli' | 'mcp' | 'hook';

/** Which editor/agent graft is running under. Derived from the surface and the
 *  wiring on disk — never from a hostname, a username, or an env var's value. */
export type AgentHost = 'claude-code' | 'cursor' | 'mcp' | 'cli';

/**
 * The commands worth counting. A command absent here is simply not reported —
 * `track()` drops the event rather than sending a free-form string, which is
 * what keeps a future `graft <something-user-named>` from becoming a data leak.
 */
export const TRACKED_COMMANDS = [
  'ask', 'grep', 'callers', 'skeleton', 'map', 'check', 'blast', 'viz',
] as const;
export type TrackedCommand = (typeof TRACKED_COMMANDS)[number];

export function isTrackedCommand(name: string): name is TrackedCommand {
  return (TRACKED_COMMANDS as readonly string[]).includes(name);
}

/**
 * How a `graft trail push` signup ended.
 *
 * Five categories and nothing else, because the alternative — the error string
 * the CLI already prints — carries a repo slug and a URL. `timed_out` and
 * `no_tty` are deliberately apart: one is a person who opened the browser and
 * did not finish, the other is a machine that was never able to open one, and
 * treating them alike would read as a product problem where there is only a
 * remote shell. `stopped` is Ctrl-C while waiting: a person changing their
 * mind, not a browser that never came back.
 */
export const BRAIN_SIGNUP_OUTCOMES = ['linked', 'timed_out', 'no_tty', 'bad_callback', 'stopped'] as const;
export type BrainSignupOutcome = (typeof BRAIN_SIGNUP_OUTCOMES)[number];

/**
 * How a `graft trail pull` ended. `written`: at least one file changed.
 * `already_present`: everything accepted was already in the files.
 * `nothing_accepted`: Trail had nothing accepted for this repo's agents.
 * `skipped`: accepted changes existed but none could be applied (the local
 * file moved on). `error`: Trail could not be read or a file not written.
 * `dry_run`: `--dry-run`, nothing written.
 */
export const TRAIL_PULL_OUTCOMES = ['written', 'already_present', 'nothing_accepted', 'skipped', 'error', 'dry_run'] as const;
export type TrailPullOutcome = (typeof TRAIL_PULL_OUTCOMES)[number];

/** How `graft trail watch` ended — see WatchExitReason in brain/watch-trail.ts. */
export const TRAIL_WATCH_REASONS = ['suggestions', 'accepted', 'timeout', 'refused', 'no_trail'] as const;

/** Why a background push did not start. `no_trail` is never sent. */
export const TRAIL_AUTOPUSH_SKIPS = ['disabled', 'no_head', 'head_unchanged', 'throttled', 'spawn_failed'] as const;

/** The context-file kinds `trail_pulled.kinds` may name; anything else is dropped. */
export const CONTEXT_FILE_KINDS = ['claude_md', 'folder_claude_md', 'agents_md', 'cursor_rule', 'skill'] as const;

/** Where a failing build died. Coarse on purpose: enough to route a bug, not
 *  enough to describe anyone's repo. */
export const BUILD_STAGES = ['walk', 'extract', 'graph', 'summarize', 'synthesize', 'write'] as const;
export type BuildStage = (typeof BUILD_STAGES)[number];

/**
 * The failure taxonomy. Anything unrecognised becomes `E_UNKNOWN` — the point of
 * a closed set is that an unclassified error contributes a count and nothing
 * else, so no message text can ride along inside a "code".
 */
export const ERROR_CODES = [
  'E_UNKNOWN', 'E_PARSE', 'E_TIMEOUT', 'E_LLM', 'E_AUTH', 'E_RATE_LIMIT',
  'E_NETWORK', 'E_DISK', 'E_PERMISSION', 'E_OOM', 'E_LOCK',
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

/**
 * Map a thrown value to a code without letting its text through. Only fixed
 * substrings are matched, and only a member of {@link ERROR_CODES} is returned —
 * the error's own message is never the return value, not even in part.
 */
export function errorCode(err: unknown): ErrorCode {
  const code = (err as { code?: unknown } | null)?.code;
  if (typeof code === 'string') {
    if (code === 'ENOSPC' || code === 'EDQUOT') return 'E_DISK';
    if (code === 'EACCES' || code === 'EPERM') return 'E_PERMISSION';
    if (code === 'ENOMEM') return 'E_OOM';
    if (code === 'ETIMEDOUT' || code === 'ESOCKETTIMEDOUT') return 'E_TIMEOUT';
    if (code === 'ENOTFOUND' || code === 'ECONNREFUSED' || code === 'ECONNRESET') return 'E_NETWORK';
  }
  const status = (err as { status?: unknown } | null)?.status;
  if (typeof status === 'number') {
    if (status === 401 || status === 403) return 'E_AUTH';
    if (status === 429) return 'E_RATE_LIMIT';
    if (status >= 500) return 'E_LLM';
  }
  const msg = err instanceof Error ? err.message.toLowerCase() : '';
  if (msg.includes('timeout') || msg.includes('timed out')) return 'E_TIMEOUT';
  if (msg.includes('parse') || msg.includes('syntax')) return 'E_PARSE';
  if (msg.includes('lock')) return 'E_LOCK';
  return 'E_UNKNOWN';
}

/* -------------------------------------------------------------------------- */
/* buckets — every number crosses the wire as a label                         */
/* -------------------------------------------------------------------------- */

/** Repo scale. Exact counts fingerprint a repo; these five labels answer the
 *  only question we have ("toy, service, or monorepo?"). */
export function filesBucket(n: number): string {
  if (n <= 0) return '0';
  if (n < 50) return '1-49';
  if (n < 200) return '50-199';
  if (n < 1000) return '200-999';
  if (n < 5000) return '1000-4999';
  return '5000+';
}

/** Wall-clock for a build. Coarse enough that it says "fast/slow", not "this
 *  exact machine on this exact tree". */
export function durationBucket(ms: number): string {
  const s = ms / 1000;
  if (s < 1) return '<1s';
  if (s < 5) return '1-5s';
  if (s < 30) return '5-30s';
  if (s < 120) return '30s-2m';
  if (s < 600) return '2-10m';
  return '10m+';
}

/** Generic small-count bucket, for the per-session read counters. */
export function countBucket(n: number): string {
  if (n <= 0) return '0';
  if (n < 5) return '1-4';
  if (n < 20) return '5-19';
  if (n < 50) return '20-49';
  if (n < 200) return '50-199';
  return '200+';
}

/** Estimated tokens saved in one session — the README's central claim, in the
 *  only resolution we need to defend it. */
export function savedTokensBucket(n: number): string {
  if (n <= 0) return '0';
  if (n < 1000) return '<1k';
  if (n < 5000) return '1-5k';
  if (n < 20000) return '5-20k';
  if (n < 100000) return '20-100k';
  return '100k+';
}

/**
 * Languages, normalised, filtered to a safe shape, and capped.
 *
 * Sorted so `["go","ts"]` and `["ts","go"]` aggregate as one value, deduped, and
 * cut to eight — a repo with a very long tail of languages is itself a
 * distinguishing fact, and the tail answers no question we have.
 *
 * The character filter is the part that matters. This is the only property in
 * the contract that is not drawn from a closed set defined in this file: the
 * values come from the parser registry, several modules away, via
 * `languageLabelOf() ?? container.name ?? generic.name ?? "unknown"`. That is
 * safe today, but it means the no-free-text guarantee would rest on a promise
 * made elsewhere — and a future generic extractor naming itself after the
 * extension it matched would quietly turn this into a channel for file
 * metadata. Anything outside `[a-z0-9+#._-]`, or longer than 24 characters, is
 * therefore dropped here rather than trusted.
 */
export function langsValue(langs: readonly string[]): string {
  const clean = langs
    .map((l) => l.toLowerCase().trim())
    .filter((l) => l.length > 0 && l.length <= 24 && /^[a-z0-9+#._-]+$/.test(l));
  return [...new Set(clean)].sort().slice(0, 8).join(',');
}
