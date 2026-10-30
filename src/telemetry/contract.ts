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

/** Init's own kinds as `cold_start` counts them: skill, guardrail (always follow), preference (learning). */
export const INIT_KINDS = ['skills', 'always_follow', 'learnings'] as const;
/** An exact count up to init's 5 items, then one label. */
const SMALL_COUNTS = ['0', '1', '2', '3', '4', '5', '6+'] as const;

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
  query: new Set<string>(['command', 'surface', 'hit', 'notes']),
  /** A trail command handing the agent a sign-in link to pass on. Queued the
   *  moment the link is printed, so a sign-in somebody walked away from is still
   *  counted — the settle below never fires for those. */
  brain_signup_opened: new Set<string>(['mode', 'command', 'wording']),
  /** That handoff reaching an end. `outcome` is a closed set, so the reason a
   *  signup failed travels as a category and never as the error's own words. */
  brain_signup_settled: new Set<string>(['outcome', 'mode', 'duration_bucket']),
  /** `trail note` saved a session note (into `~/.trail/`). Whether it carries
   *  a cost, and how many files it is about, as a bucket. The title, the text
   *  and the paths never travel. The supply side of the notes loop; the
   *  `notes` property on `query` is the demand side. */
  note_saved: new Set<string>(['has_cost', 'touches_bucket', 'scope']),
  /** Once a day per repo, from the session-start hook, for a repo trail runs
   *  in: whether `.trail/` is committed there, how many learnings it holds,
   *  as a bucket, and whether this machine shares it with a workspace. With
   *  `repo_id` and the install id this counts devs and repos touched, and
   *  repos with Trail committed. Paths and names never travel. */
  repo_seen: new Set<string>(['trail_committed', 'learnings_bucket', 'workspace']),
  /** At session start, when the learnings committed on HEAD went up since the
   *  last session in that clone: how many came in and how many there are, as
   *  buckets, and whether it's the clone's first look. Committed learnings
   *  are trail's activation. Paths and titles never travel. */
  learnings_committed: new Set<string>(['added_bucket', 'total_bucket', 'first_look']),
  /** `trail init` read the repo's past Claude sessions, the review comments
   *  on its merged PRs, or Claude Code's memory notes of it (`source`), for
   *  learnings: how it went, how many sessions or reviewed PRs there were,
   *  findings offered and saved, how many were left out for naming no code
   *  (`filtered`), and how many of those offered and saved were the team's,
   *  as buckets, how long it took, and the model. The look-back's own items
   *  offered (shown or relayed) and kept, by kind, as exact counts (init shows
   *  at most 5). The messages, the comments, the notes and the findings never travel. */
  cold_start: new Set<string>(['source', 'outcome', 'sessions_bucket', 'reviews_bucket', 'offered_bucket', 'filtered_bucket', 'picked_bucket', 'team_offered_bucket', 'team_picked_bucket', 'duration_bucket', 'model',
    ...INIT_KINDS.flatMap((k) => [`offered_${k}`, `kept_${k}`])]),
  /** One closed agent session, summarised. `graft_reads` vs `source_reads` is
   *  the single number that says whether an agent prefers graft to grep; the two
   *  `*_turns` buckets are the follow-up question — of the turns that used graft,
   *  how many told the user what it saved. Both are counts of turns, never text. */
  session_summary: new Set<string>([
    'graft_reads_bucket', 'source_reads_bucket', 'saved_tokens_bucket',
    'graft_turns_bucket', 'reported_turns_bucket',
  ]),

  /* Learned skills (spec section 20). Every value is a member of a closed set
   * in {@link VALUES}; a skill's name, its steps, a command, a prompt, a lesson
   * or a path is never one of them, so none of those can travel. */

  /** Trail offered to keep a skill (or a lesson, an update, a promotion): at which moment. */
  skill_offered: new Set<string>(['moment']),
  /** The person's answer to an offer. A withdrawn offer sends nothing. */
  skill_answer: new Set<string>(['answer']),
  /** A skill was saved: what it came from, and whose it is. */
  skill_saved: new Set<string>(['from', 'scope']),
  /** Trail changed a skill it wrote, on the person's yes or their own command (phase 2): how. */
  skill_changed: new Set<string>(['op']),
  /** A skill moved up a scope (phase 3). */
  skill_promoted: new Set<string>(['to']),
  /** A joined team repo was pulled (phase 3): how it went. */
  team_pull: new Set<string>(['outcome']),
  /** A skill the agent was given ran: whether its own check passed. */
  skill_used: new Set<string>(['outcome']),
  /** The weekly value line was said (phase 2): where it went. */
  skill_value: new Set<string>(['channel']),
  /** A skill stopped being offered to the agent as is: why. */
  skill_stale: new Set<string>(['reason']),
  /** A guardrail fired: which built-in one, and what it did. */
  guardrail: new Set<string>(['class', 'outcome']),
  /** A failing command matched a known wall: which one, and whether the person had kept a lesson for it. */
  wall_hit: new Set<string>(['class', 'had_lesson']),
  /** Learnings reached the agent because it opened, edited or named a file
   *  they list: how, and whether the file was a worktree's copy while the
   *  session's project is the main checkout. */
  learnings_on_touch: new Set<string>(['via', 'worktree']),
  /** How long one hook took, as a bucket: which hook. */
  hook_ms: new Set<string>(['event', 'bucket']),
};

/** The labels {@link hookMsBucket} returns. */
export const HOOK_MS_BUCKETS = ['<50ms', '50-100ms', '100-300ms', '300ms-1s', '1-3s', '3s+'] as const;

/**
 * The values an event's key may take, where the contract fixes them. `track()`
 * drops a value outside the set, key and all, so a call site that passes a
 * skill's name, a prompt or an error line under an allowed key sends nothing
 * for it. Every key of the skills events is listed here.
 */
export const VALUES: Record<string, Record<string, ReadonlySet<string>>> = {
  cold_start: Object.fromEntries(INIT_KINDS.flatMap((k) => [`offered_${k}`, `kept_${k}`]).map((key) => [key, new Set(SMALL_COUNTS)])),
  skill_offered: { moment: new Set(['asked', 'repeated', 'repaired', 'correction', 'update', 'drift', 'retire', 'promote']) },
  skill_answer: { answer: new Set(['yes', 'no', 'show', 'none', 'off', 'retire']) },
  skill_changed: { op: new Set(['update', 'extend', 'split', 'replace', 'retire', 'adopted', 'restore-version']) },
  skill_value: { channel: new Set(['context', 'notice', 'list']) },
  skill_saved: { from: new Set(['init', 'repeated', 'repaired', 'asked']), scope: new Set(['personal', 'repo', 'team']) },
  skill_promoted: { to: new Set(['repo', 'team']) },
  team_pull: { outcome: new Set(['updated', 'unchanged', 'diverged', 'failed']) },
  skill_used: { outcome: new Set(['checked', 'failed', 'unchecked']) },
  skill_stale: { reason: new Set(['failed', 'corrected', 'missing', 'unused', 'unfollowed']) },
  learnings_on_touch: { via: new Set(['read', 'edit', 'command']), worktree: new Set(['true', 'false']) },
  guardrail: {
    class: new Set(['no-timeout', 'prod-after-beta']),
    outcome: new Set(['hint', 'ask', 'deny', 'sure-fail', 'avoided']),
  },
  wall_hit: {
    class: new Set(['timeout-missing', 'zsh-no-match', 'git-https-auth', 'docker-rootless', 'npm-e401-eotp', 'claude-not-logged-in', 'enospc']),
    had_lesson: new Set(['true', 'false']),
  },
  hook_ms: {
    event: new Set(['session-start', 'prompt', 'pre-bash', 'pre-edit', 'tool-savings', 'post-bash', 'post-bash-fail', 'post-edit', 'post-edit-sync', 'stop']),
    bucket: new Set(HOOK_MS_BUCKETS),
  },
};

/** Whether `value` may go under `key` of `event`: always, unless {@link VALUES} fixes the key's values. */
export function allowedValue(event: string, key: string, value: string): boolean {
  if (!Object.hasOwn(VALUES, event)) return true;
  const keys = VALUES[event]!;
  return !Object.hasOwn(keys, key) || keys[key]!.has(value);
}

/** Stamped on every event by `track()`; not listed per event above. */
export const COMMON_KEYS = [
  'app_version',
  'os',
  'arch',
  'node_major',
  'ci',
  'agent_host',
  'cli_name',
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
export type AgentHost = 'claude-code' | 'cursor' | 'copilot' | 'mcp' | 'cli';

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
 * How a sign-in handoff ended.
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

/** `{prefix}_skills`, `{prefix}_always_follow`, `{prefix}_learnings`: how many of each kind, exact to 5. */
export function initKindCounts(prefix: 'offered' | 'kept', items: ReadonlyArray<{ kind: string }>): Record<string, string> {
  const n = (kind: string) => items.filter((i) => i.kind === kind).length;
  const small = (c: number) => (c > 5 ? '6+' : String(c));
  return { [`${prefix}_skills`]: small(n('skill')), [`${prefix}_always_follow`]: small(n('guardrail')), [`${prefix}_learnings`]: small(n('preference')) };
}

/** One hook's wall-clock. The budgets are 50 ms (PreToolUse) and 300 ms (the
 *  rest), so the labels split there. */
export function hookMsBucket(ms: number): (typeof HOOK_MS_BUCKETS)[number] {
  if (ms < 50) return '<50ms';
  if (ms < 100) return '50-100ms';
  if (ms < 300) return '100-300ms';
  if (ms < 1000) return '300ms-1s';
  if (ms < 3000) return '1-3s';
  return '3s+';
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
