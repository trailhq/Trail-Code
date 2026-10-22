/**
 * The shapes the trace layer folds a session into: runs of tool work that
 * serve one typed ask, their calls, the checks that prove a job worked, and
 * the per-session state the skills hooks keep under the `skills` key of
 * `~/.trail/sessions/<id>.json`.
 *
 * Types only (a type import of skills/types.ts for the fold ops). Typed text never appears here: a run carries job words from a
 * fixed vocabulary, parameter values of known shapes, counts, hashes of typed
 * lines, and the commands that ran (secret-checked).
 */

import type { FoldOp } from '../skills/types.js';

export type JobClass = 'release' | 'ship' | 'pr-green' | 'sweep' | 'run-local' | 'report' | 'tests';

export interface JobMatch {
  job: JobClass;
  /** Canonical vocabulary words that matched, e.g. ['push', 'beta', 'ff', 'prod']. Never raw text. */
  words: string[];
}

/** Parameter values of known shapes found in a typed ask. Values only, never the text around them. */
export type PromptParams = Partial<Record<'version' | 'sha' | 'pr' | 'port' | 'branch' | 'date', string>>;

/** What a Bash call is, decided at fold time from its raw command (4.1). */
export type CallKind = 'step' | 'look' | 'plumbing' | 'work';

export interface RunCall {
  /** tool_use id */
  id: string;
  at: string;
  /** The command after redactSecrets (4.10). null when it held a secret that could not be named, or ran over 2,000 characters (then `parts` holds it piece by piece, D58c). */
  cmd: string | null;
  /** For a call with `parts`, the worst of its pieces' (refused over named). */
  secret?: 'named' | 'refused';
  /** Repo key of the effective folder (4.1); null outside git. */
  key: string | null;
  /** Effective folder (4.1), relative to that checkout's root ('' = root); null outside git. A sheet stores null for calls in another repo than the run's. */
  cwd: string | null;
  /** tool_input.run_in_background === true, or the command ends in a top-level `&`. */
  bg: boolean;
  /** !ok from the trace: is_error, or failure text in head or tail. */
  failed: boolean;
  /** The host's own error flag only. */
  isError: boolean;
  /** errorLine(result), cleanLine(.., 160). */
  errorLine?: string;
  /** Last 200 chars of the result, cleanLine'd. Kept for check-family calls, polls, `git rev-parse`, `git push` and publish calls only. */
  tail?: string;
  check?: CheckHit;
  /** Raw command over 2,000 chars: never kept whole; its pieces are in `parts` (D58c). */
  truncated?: boolean;
  /** isMultiLine(raw command). */
  multiLine?: boolean;
  kind: CallKind;
  /** Byte offsets of the tool_use line and the tool_result line, for the gate (4.9). -1 / null when unknown. */
  src: { use: number; result: number | null };
  /** The outcome came from a PostToolUse(Failure) mark because the transcript had no result yet (3.4). A later transcript result replaces it. */
  fromMark?: true;
  /** Only when the raw command ran over 2,000 characters (then `cmd` is null and `truncated` set): its top-level pieces in order (D58c). */
  parts?: RunCallPart[];
  /**
   * Not a Bash call: a deployment status tool over MCP (D59b, `mcp__claude_ai_Vercel__get_deployment`). Then `cmd` is
   * null, `kind` is 'look', `key`/`cwd` are null, and `check` is the deploy check its result gave. Never a step,
   * never counted in `commands` or `failedCount`.
   */
  tool?: string;
  /**
   * D116 item 5: the call only fed keystrokes into a login (`... | script -q /dev/null npm login`): the service it logs
   * in to. Then `cmd` is the login alone (`npm login`): what was fed is never kept, and compile drops the step.
   */
  loginFeed?: string;
}

/**
 * One top-level piece of a call over 2,000 characters (D58c), as `splitTop` cuts it: a subshell, a loop or an `if`
 * is one piece, a heredoc body belongs to the piece that opened it. The call's `id` and `src` are every piece's
 * `from` (the save gate re-reads that one transcript line).
 */
export interface RunCallPart {
  /** Word for word what ran, after redactSecrets; null when it held a secret that could not be named, or is `long`. */
  cmd: string | null;
  /** The top-level separator after it; '' for the last. A newline reads as ';'. */
  sep: '&&' | '||' | ';' | '|' | '&' | '';
  /** 4.1 kinds for the piece alone; always 'work' when `long`. */
  kind: CallKind;
  secret?: 'named' | 'refused';
  /** The piece ran over 2,000 characters (a heredoc body, an inline edit): a work marker, never a step, never kept. */
  long?: true;
}

/** `push`: a `git push` whose output shows the remote ref moved (D56a); a step, like `tests` and `query`. */
export type CheckFamily = 'tests' | 'npm-view' | 'deploy' | 'gh-checks' | 'ls-remote' | 'query' | 'push';

export interface CheckHit {
  family: CheckFamily;
  passed: boolean;
  facts: {
    version?: string; sha?: string; state?: string; pr?: string;
    branch?: string; remote?: string; pkg?: string; passedCount?: number;
  };
}

export type RunEnd = 'done' | 'failure' | 'question' | 'open';

export interface RunState {
  id: string;                   // 'r-1027-3f9a'
  epoch: number;
  startedAt: string;
  lastAt: string;
  /** Repo key that most of the run's commands ran in (4.1). */
  repoKey: string;
  /** D93: the top of the checkout `repoKey` names, as the fold found it; absent when no call ran in it. */
  checkout?: string;
  /** gitBranch of its first step call; null when unknown. */
  branch: string | null;
  job: JobClass | null;
  jobWords: string[];
  promptParams: PromptParams;
  /** Words both in the typed ask and in the kept commands (moment 1 cue words when job is null). */
  sharedWords: string[];
  typedCount: number;
  toolCalls: number;            // every tool call except Trail's own commands
  edits: number;                // Edit, Write, MultiEdit, NotebookEdit
  commands: number;             // Bash calls, all of them (calls[] may hold fewer)
  failedCount: number;          // failed Bash calls
  stepCalls: number;            // Bash calls of kind 'step', ok or not
  /** Open run only, newest last, at most 200. Emptied when the run closes, after its sheet is written. */
  calls: RunCall[];
  closed: boolean;
  /** Recomputed at every Stop while the run is open (4.2), kept when it closes. */
  end: RunEnd;
  /** Set when a run block was injected for this run (not "from scratch"). */
  skillId?: string;
  /** The run a compaction cut before it checked out, whose job this run continues (D59a). The agent started it with no typed ask. */
  carriedFrom?: string;
  /**
   * D116 item 3: a go-ahead continued this run after a turn the agent ended in failure; this many calls had run then.
   * Only a check at or after that call can check the run out.
   */
  failedTurn?: number;
  sheet: 'none' | 'draft' | 'checked';
  checkIndex: number | null;
  poolNoted: boolean;
}

/** ~/.trail/runs/<id>.json. What compile copies from. */
export interface RunSheet {
  v: 1;
  id: string;
  session: string;              // sha256(sessionId).slice(0, 12)
  repoKey: string;
  /** D93: the checkout the run ran in (RunState.checkout). The save gate's halves read it, never their own cwd. */
  checkout?: string;
  branch: string | null;
  host: string;
  tier: 'A' | 'B' | 'C' | 'D';
  epoch: number;
  startedAt: string;
  endedAt: string;
  job: JobClass | null;
  jobWords: string[];
  sharedWords: string[];
  promptParams: PromptParams;
  calls: RunCall[];
  /** Index into calls of the passing check that made it a checked success, or null. */
  checkIndex: number | null;
  checked: boolean;
  end: RunEnd;
  counts: { commands: number; failed: number; toolCalls: number; edits: number };
  /** Absolute paths of helper scripts the run executed from scratch folders (4.5 step 7). */
  helpers: string[];
  /** The skill whose block drove this run, or null. */
  skillId: string | null;
  /** The run (and sheet) before the compaction that this one continues (D59a); its calls are the job's first part. */
  carriedFrom?: string;
  /** Set only by `joinCarriedSheet`: the earlier parts joined in, oldest first, and how many calls each brought (they come first). */
  joined?: Array<{ id: string; calls: number }>;
}

/** Phase 2: 'retire', the retire proposal's and drift's retire (4.10, classifyFor); 1a's classifyAnswer never gives it. */
export type TypedAnswer = 'yes' | 'no' | 'show' | 'correction' | 'retire' | 'other';

export type GatedKind = 'publish' | 'push-prod' | 'deploy' | 'merge' | 'migrate' | 'prune' | 'login';

export interface SkillInjection {
  injId: string;                // 'i-' + 6 hex
  skillId: string;
  name: string;
  epoch: number;
  at: string;
  cue: 'job' | 'name' | 'check' | 'compact';
  params: Record<string, string>;
  /** Steps with params filled, in order (step n = index + 1). [] for a check cue. */
  steps: string[];
  gated: Array<{ step: number; kind: GatedKind }>;
  check: string | null;
  /**
   * D66: the skill's `metadata.check-tool` (e.g. 'get_deployment') when its check is a deploy status read over MCP,
   * not a command. Credit then takes the check from that tool's result (READY passes). Absent for a command check.
   */
  checkTool?: string | null;
  /**
   * D106: the version a version check should show (the skill's `check-shows` is a `{version}` param, filled with a
   * literal version). Credit passes the check only when it shows this version. Absent otherwise.
   */
  checkVersion?: string;
  /**
   * The ready probes (their text, from the skill's `ready` line) that failed when the block came in. Credit puts
   * their forms in the use line; they never count against the skill (g4 open issue 4, D71 d). Absent when none failed.
   */
  readyFailed?: string[];
  /** Set by the fold: the run of the first typed event at or after `at` minus 5 s. */
  runId: string | null;
  /** Its gated ask applies (3.3). Ends per 3.1 step 3, 3.2 step 7 and 3.5 step 5. */
  live: boolean;
}

export type OfferChannel = 'stop' | 'notice' | 'post-tool';

export interface PendingOffer {
  offerId: string;
  moment: OfferMoment;
  runId: string;
  name: string;                 // proposed skill name
  key: string;                  // '<repoKey>|job:<class>'; 1b: '<repoKey>|wall:<cls>|<program>', '<skillId>|correction'
  /**
   * The 2 lines (4.12). 1b: null only for a 'correction' offer, rebuilt from the transcript (P17); every reader goes
   * through offerLinesOf (b4, R12). Until then each 1a reader treats null as no offer: never shown, answered or saved.
   */
  lines: [string, string] | null;
  channel: OfferChannel;
  shownAt: string | null;       // emitted (stop, notice), or seen in the reply (post-tool)
  showMe: boolean;              // 'show me' already answered once
  /** Set by the prompt hook from the UserPromptSubmit payload: the person's yes, as a hash. */
  yes: { at: string; typedSha: string } | null;
  /** Set by the fold: the first typed events after shownAt (at most 2: a 'show' then the answer). */
  typedAfter: Array<{ offset: number; sha: string; answer: TypedAnswer }>;
  /** g5 review: `skillSha` of the skill the offer counted (offerDue). The gate saves only that skill on its yes. */
  skillSha?: string;
  /** D101: how often the job worked out from scratch (line 1's count), for Trail's own reason in the Stop and post-tool text. */
  seen?: { n: number; unit: 'day' | 'time' };
}

export interface CreditState {
  useId: string;
  injId: string;
  skillId: string;
  epoch: number;
  runId: string | null;
  stepsRan: number[];
  failedStep: number | null;
  check: 'passed' | 'failed' | 'none';
  calls: number;
  failed: number;
  flushed: boolean;
  promptsAfter: number;         // typed prompts since flush, for the 2-prompt correction window
}

/** The `skills` key of ~/.trail/sessions/<id>.json. The `trace` key beside it is the catch-up cursor (0.1). */
export interface SkillSessionState {
  v: 1;
  sessionHash: string;
  host: string;
  tier: 'A' | 'B' | 'C' | 'D';
  /** GateCtx.learn when this state was made (0 rule 2). */
  learn: boolean;
  /** Repo keys in scope for recall: the cwd's key, plus child checkouts when cwd is not in git (3.1). */
  scopeKeys: string[];
  epoch: number;
  /** SessionStart(compact) bumped the epoch before the fold met the compaction line (4.1). */
  pendingBoundary: boolean;
  /** At most 20, open run last. */
  runs: RunState[];
  pendingOffer: PendingOffer | null;
  /** The one offer of this session is spent (an offer, an asked save, or the shim's install line, D27). */
  offerUsed: boolean;
  offerUsedBy: 'offer' | 'asked' | 'install-line' | null;
  /** typed: set by the fold when it meets the typed line with this typedSha at or after `at` minus 5 s. */
  saveRequest: { runId: string; at: string; typedSha: string; scope: 'this repo' | 'every repo' | 'repo' | 'team';
                 typed: { offset: number; sha: string } | null;
                 /** D73: `skillSha` of the skill compiled when the person asked. The gate saves only that skill; missing: refused. */
                 skillSha?: string;
                 /** The name Trail gave that skill (the add it told the agent to run). The gate keeps it under this name, or
                  *  a numbered one when it was taken since; missing: refused. */
                 name?: string } | null;
  /** All epochs this session, newest last, at most 20. */
  injected: SkillInjection[];
  /** Newest last, at most 10. */
  credit: CreditState[];
  /** The first call that wrote Trail's or the host's files (4.1), as '<tool> <path or program>'. Never cleared. */
  tampered: string | null;
  /**
   * The run the last compaction cut mid-job, before it checked out (D59a): the next run the agent starts with no
   * typed ask continues its job. Spent by that run; cleared by any typed line.
   */
  cut?: string;
  /**
   * D116 item 3: how the agent's last reply ended (4.3: failure first, then a question, else done), from the fold's
   * last assistant text before a typed line or a call; cleared by a call, a typed line and a compaction. Never text.
   */
  replyEnd?: 'failure' | 'question' | 'done';
  updatedAt: string;
  /**
   * What was already folded, so a block of history the transcript repeats, or a transcript read again from
   * the top, folds once (D56d): 10 hex of sha256 per tool_use id, typed line and compaction line, concatenated,
   * oldest first, at most 6,000. Never an id in the clear.
   */
  seen?: string;
}

/* -------------------------------------------------------------------------- */
/* Phase 1b (design 1.0). Fields 1b adds to a 1a interface sit in a second     */
/* declaration of it, which TypeScript merges with the first. They are         */
/* optional: a session or state file written by 1a doesn't have them, and an   */
/* absent one reads as null (or 0, {}).                                        */
/* -------------------------------------------------------------------------- */

/** The wall catalog's classes (spec 12). Closed: equal to telemetry's wall_hit.class values, in the catalog's order. */
export type WallClass =
  | 'timeout-missing' | 'zsh-no-match' | 'git-https-auth' | 'docker-rootless'
  | 'npm-e401-eotp' | 'claude-not-logged-in' | 'enospc';

/** What changed between a failing call and the retry that worked (4.12). */
export type FixDeltaKind = 'env' | 'flag' | 'wrapper' | 'enable-step';

export interface FixDelta {
  kind: FixDeltaKind;
  /** env: the variable name; flag: the flag; wrapper: the program put in front; enable-step: that call's program. */
  name: string;
  /** The text as it ran, secret-checked and relativized ($HOME, repo-relative). Never a typed word. */
  text: string;
  /** The tool_use id that carried it. */
  callId: string;
}

export interface RepairEvent {
  cls: WallClass;
  program: string;
  failCallId: string;
  /** The retry that worked. */
  fixCallId: string;
  /** Non-empty, else it is not a repair. */
  delta: FixDelta[];
  epoch: number;
  runId: string | null;
  at: string;
}

/** Phase 2: moment 5 'update', moment 6 'drift', and the retire proposal 'retire' (4.7 to 4.10). */
export type OfferMoment = 'repeated' | 'repaired' | 'correction' | 'update' | 'drift' | 'retire';

export interface RunCall {
  /** Set by run-calls.ts makeCall (b2, R8): matchWall(result text, command, failed). Kept in run sheets as a class name only. */
  wall?: WallClass;
  /** The run's Edit/Write tool calls before this one, when any (b2 review): an edit between a failure and its retry may be the fix, so no repair. */
  editsBefore?: number;
}

export interface RunState {
  /** Filled at run close (4.12): at most 5 per run. The wall hits themselves are RunCall.wall. */
  repairs?: RepairEvent[];
}

export interface PendingOffer {
  /** b4: the repo the offer is for (its `offers.jsonl` line's `repo`). A correction's key names the skill, not the repo. */
  repo?: string;
  /** Moment 3. as 'lesson': lessonSha is the sha256 of the lesson text line 2 shows (R26). */
  repair?: { cls: WallClass; program: string; nth: number; firstAt: string;
             as: 'skill' | 'lesson'; delta: FixDelta[]; lessonSha?: string };
  /** Moment 4: the person's correction line (offset and sha), the first new step that worked after it, the lesson as offered. */
  correction?: { skillId: string; useId: string; typed: { offset: number; sha: string }; fixCallId: string | null; lessonSha: string;
                 /** b4: the fix command as the lesson holds it (params put back, relativized, risk-checked), or null: the agent's
                  *  command, never the person's words, so line 2 is rebuilt from the typed line and this (P17). */
                 fix?: string | null };
}

export interface SkillInjection {
  /** 8 hex of sha256 of the asks phrase that fired a 'job' cue; null for name, check, compact. Never the phrase (D71 b, R30). */
  phraseSha?: string | null;
}

export interface CreditState {
  /** Copied from the injection. */
  phraseSha?: string | null;
  /** creditWindow sets sha; the fold fills offset from an origin-human typed line only. */
  corrected?: { offset: number | null; sha: string } | null;
}

export interface SkillSessionState {
  lessonWatch?: { skillId: string; useId: string; typedSha: string; at: string } | null;
  /** The correction that withdrew this session's offer: only the moment-4 offer for that same correction may use the freed slot (P18, R40). */
  withdrewFor?: { typedSha: string } | null;
  /** Lines of sessions/<id>.denied.jsonl Stop has counted (3.5 step 5). */
  deniedSeen?: number;
}

/* -------------------------------------------------------------------------- */
/* Phase 2 (design 1.0, c0). Fields phase 2 adds to a 1a interface sit in a    */
/* further declaration of it, and are optional: a session file written by 1a   */
/* or 1b reads unchanged, an absent one reads as null.                         */
/* -------------------------------------------------------------------------- */

/** The facts of a Codex rollout's first line (`session_meta`, 4.15), read once. No text but `cwd`. c6's `codexMeta` returns it. */
export interface CodexMeta {
  id: string;
  originator: string | null;
  source: string | null;
  cliVersion: string | null;
  cwd: string | null;
  historyMode: 'legacy' | 'paginated' | null;
}

export interface PendingOffer {
  /** Moments 5 and 6 (4.7, 4.8): the change shown, pinned to the file it was computed from and to the text it would write. */
  fold?: { op: FoldOp | 'replace'; skillId: string; baseHash: string; proposalSha: string; handEdited: boolean;
           splitName?: string; lessonIds?: string[]; version: number };
  /** The retire proposal and drift (4.9): the skill a 'retire' answer retires. */
  retire?: { skillId: string; name: string };
}

export interface SkillSessionState {
  /** c7: Codex only. The rollout's first line, read once (4.17), and the keyed hashes (HMAC with its own key file,
   *  state/typed-key, D138 (3); 16 hex, last 20) of prompts the prompt hook saw (P30, R7). Never a prompt. */
  codex?: { meta: CodexMeta | null; typedShas: string[] };
  /** c8 (4.9): not-followed firings the prompt hook's settle wrote, for the next Stop's retire proposal. At most 4. */
  firedLater?: Array<{ skillId: string; name: string; followed: boolean; runId: string; at: string }>;
}

/** Phase 2 c8 (D137): a gated step this session couldn't ask for was denied and handed to the person to run. */
export interface SkillInjection {
  /** The gated steps handed to the person (from the gate file's marks): credit counts each as handed, not failed. */
  handed?: Array<{ n: number; at: string }>;
}
export interface RunState {
  /** The newest hand-off of one of its block's gated steps: the person's next ask of the job continues this run. */
  handedAt?: string;
}
