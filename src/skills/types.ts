/**
 * The shapes of learned skills: the SKILL.md metadata, compiled and parsed
 * skills, their state and ledger lines, offers, receipts, the person's
 * settings, and what a skills hook part hands back to the hook that writes.
 *
 * Types only.
 */
import type { GatedKind, JobClass, OfferChannel } from '../trace/types.js';

export type Scope = 'personal' | 'repo' | 'team';
export type SkillStatus = 'candidate' | 'active' | 'needs-fix' | 'retired';
export type SkillFrom = 'init' | 'repeated' | 'repaired' | 'asked';

/** Flat quoted strings under `metadata:` in SKILL.md. Key names are the YAML keys. */
export interface SkillMeta {
  trail: string;                // id, e.g. 's-7f3a2c'
  scope: Scope;
  applies?: string;             // personal only: repo key or 'every repo'
  job?: JobClass;
  asks: string;                 // comma-separated phrases
  'status-asks'?: string;
  params?: string;              // 'version, sha=$(git rev-parse HEAD), pkg=workflow'
  needs?: string;               // 'node, npm, git'
  ready?: string;               // ' ; '-separated allowlisted probes (4.5 step 11)
  'check-first'?: string;       // ' ; '-separated network checks for the agent
  /** D116 item 5: ' | '-separated things the person does first (a login whose keystrokes the run fed, dropped from the steps). */
  'before-you-start'?: string;
  'confirm-before'?: string;    // ' ; '-separated gated step texts (with {params})
  check?: string;
  'check-shows'?: string;       // expected output, e.g. 'success', '{version}'
  /** D59b: the check is a deploy status tool the agent calls (e.g. 'get_deployment'); `check` then says what to read, not a command. */
  'check-tool'?: string;
  version: string;              // '1'
}

export interface ParamDef {
  name: string;                 // 'version', 'sha', 'pr', 'port', 'branch', 'date', 'pkg', 'version_2', 'arg1'
  shape: 'version' | 'sha' | 'pr' | 'port' | 'branch' | 'date' | 'varied';
  /** A literal, or a `$(...)` command for sha and date. */
  default?: string;
  /** Values seen in the run(s) it came from. Shapes only; never secret-flagged. */
  seen: string[];
}

export interface SkillStep {
  n: number;                    // 1-based
  cmd: string;                  // with {params}
  gated: GatedKind | null;
  bg: boolean;                  // run it in the background
  wait: boolean;                // a folded poll loop
  /** compile only: the tool_use ids it was copied from (the gate re-reads each, 4.9). */
  from?: string[];
}

export interface CompiledSkill {
  name: string;
  title: string;                // '# ' heading text
  description: string;
  meta: SkillMeta;
  steps: SkillStep[];
  check: string;                // with {params}; '' for an asked save with no check
  checkShows: string | null;
  /** tests and query families: the check is also the last Run step (4.5 step 3). */
  checkIsStep: boolean;
  ifFails: string[];            // at most 4, each cleanLine(.., 200)
  dontUse: string;
  params: ParamDef[];
  helpers: Array<{ file: string; from: string; content: string }>;
  leftOut: { failed: number; lookOnly: number; duplicates: number; plumbing: number; work: number };
  /** D58 b: steps that ran outside the repo, left out; shown in the draft with where they ran ("in api", "outside any repo"). */
  elsewhere?: Array<{ cmd: string; where: string }>;
  /** D59a: the run a compaction cut, joined: how many compactions, when its first part began, the steps from before the last one. */
  carried?: { compactions: number; startedAt: string; steps: number[] };
  /** The run it was copied from, for the Stop use line (3.5 step 5) and `trail skills`. */
  source: { runId: string; commands: number; failed: number; at: string };
}

export interface ParsedSkill {
  name: string;
  description: string;
  meta: SkillMeta;
  steps: SkillStep[];
  check: string | null;
  checkShows: string | null;
  ifFails: string[];
  dontUse: string;
  params: ParamDef[];
  hash: string;                 // 'sha256:<hex>' of the file text
}

export interface SkillRef {
  id: string;
  name: string;
  scope: Scope;
  applies: string | null;
  dir: string;
  file: string;
}

export interface SkillState {
  name: string;
  scope: Scope;
  status: SkillStatus;
  from: SkillFrom;
  runId: string | null;
  addedAt: string;
  lastWorked: string | null;    // local date of the last checked use; at save, the source run's date
  lastUsedAt: string | null;
  lastUsedRepo: string | null;
  uses: number;
  checkedUses: number;
  hash: string;                 // hash of SKILL.md as Trail last wrote it
  source: { commands: number; failed: number; at: string } | null;
  /** The failed step of the last two uses, newest last; [] when the last use had no failed step (4.8). */
  lastFails: Array<{ step: number; at: string }>;
  /** Why it is needs-fix, in words: 'step 4 failed on Nov 2 and Nov 4'. */
  statusWhy?: string;
  prevStatus?: SkillStatus;     // kept across forget and restore
  /** D65: the SKILL.md hash when it was marked needs-fix. Only an edit after that mark (a hash other than this) brings it back. */
  fixHash?: string;
  promoteOffers: { repo?: string; team?: string };   // phase 3; always {} in 1a
}

export interface SkillsStateFile { v: 1; skills: Record<string, SkillState> }

export type Answer = 'yes' | 'no' | 'show' | 'none' | 'withdrawn';

export interface OfferLine {
  id: string;
  at: string;
  /** 1b: 'closed' lines come only from init (moment 'init', answer 'no', 4.20). */
  event: 'shown' | 'answer' | 'not-shown' | 'closed';
  repo: string;
  key: string;
  /** Phase 2: 'update', 'drift' and 'retire' (2.4); widened here because a field's type can't be widened by merging. */
  moment: 'repeated' | 'repaired' | 'correction' | 'init' | 'update' | 'drift' | 'retire';
  runId: string;
  name: string;
  channel: OfferChannel;
  answer?: Answer;
}

/** Phase 2: cue 'run' (c10's `trail run` only), and the fidelity facts in LedgerUseFacts (2.3). */
export type LedgerUse = { at: string; event: 'use'; useId: string; skill: string; v: string; host: string;
  cue: 'job' | 'name' | 'compact' | 'run'; repo: string; stepsRan: number[]; failedStep: number | null;
  readyFailed: string[]; check: 'passed' | 'failed' | 'none'; calls: number; failed: number } & LedgerUseFacts;

export type LedgerLine =
  | { at: string; event: 'saved'; skill: string; v: string; from: SkillFrom; scope: Scope;
      receipt: { consent: 'offer-yes' | 'asked' | 'init'; stepsVerified: number; stepsTotal: number } }
  | LedgerUse
  | LedgerLesson
  | LedgerCue
  | LedgerChanged
  | { at: string; event: 'corrected'; skill: string; useId: string }
  | { at: string; event: 'status'; skill: string; from: SkillStatus; to: SkillStatus;
      /** Phase 2: 'retire-offer', the retire proposal's or drift's retire (2.3). */
      reason: 'checked-use' | 'failed-twice' | 'forget' | 'restore' | 'retire-offer' };

export interface TrailSkillSettings {
  v: 1;
  skills: 'on' | 'off';
  onSince: string | null;       // when skills last turned on (first-week cap, 4.13)
  offers: 'on' | 'off';
  offersOffAt: string | null;   // when offers were turned off (said back in `trail skills` and, in 1b, at init)
  offRepos: string[];
  pausedUntil: Record<string, string>;     // repoKey -> local date
  skillsOff: string[];                     // skill names off for this person
  /** Cache of the governor window (4.13); offers.jsonl stays the truth. */
  lastNine: Array<'yes' | 'no' | 'none'>;
  governorSaidAt: string | null;
}

export interface Receipt {
  v: 1;
  session: string;              // session id (raw; the file is 0600)
  transcriptPath: string;
  toolUseId: string;            // the PreToolUse payload's tool_use_id for the add command
  runId: string;
  name: string;
  at: string;
  host: string;
  tier: 'A' | 'B' | 'C' | 'D';
  consent: 'offer-yes' | 'asked' | 'none';
  offerId: string | null;
  /** The person's typed line that gave consent: its byte offset and the sha256 of the whole line. */
  typed: { offset: number; lineSha: string } | null;
  typedYes: boolean;
  typedSave: boolean;
  /** What the person's save request said about scope (asked saves only), for the CLI's line (D27). */
  asked: 'this repo' | 'every repo' | 'repo' | 'team' | null;
  stepsTotal: number;
  stepsVerified: number;
  verdict: 'live' | 'held';
  heldWhy?: 'no-yes' | 'host';
  /** D93: the checkout the PreToolUse half compiled the run in ('' for none); the CLI half uses it, never its own cwd. */
  checkout?: string;
  /** Set by the CLI when it acts on the receipt; a used receipt never counts again. */
  usedAt: string | null;
}

/** What a skills hook part hands its caller, which writes one JSON object (0.2 `emitHook`). */
export interface HookOut {
  /** additionalContext: the agent reads it. */
  context?: string;
  /** systemMessage: the person sees it, the agent doesn't. */
  notice?: string;
  /** decision "block" with this reason (UserPromptSubmit: the prompt goes no further; Stop: the agent continues). */
  block?: string;
}

/* -------------------------------------------------------------------------- */
/* Phase 1b (design 1.0). Fields 1b adds to a 1a interface sit in a second     */
/* declaration of it, merged by TypeScript, and are optional: a state file     */
/* written by 1a doesn't have them.                                            */
/* -------------------------------------------------------------------------- */

/** A lesson kept on a skill (moment 4) or tied to a wall (moment 3). */
export type LedgerLesson = { at: string; event: 'lesson'; skill: string; lessonId: string; src: 'correction' | 'repair';
  consent: 'offer-yes' };

/** An asks phrase that kept missing was dropped from the cue (4.19). The phrase is never written, only its sha (R30). */
export type LedgerCue = { at: string; event: 'cue'; skill: string; phraseSha: string; change: 'dropped' };

export interface SkillState {
  /** phraseSha -> misses in a row (4.19, R30). Absent reads as {}. */
  cueMisses?: Record<string, number>;
  /** When skill_stale{unused} was sent. */
  unusedSaidAt?: string | null;
  /** When skill_stale{missing} was last sent (once a day, 4.18). */
  missingSaidAt?: string | null;
}

/** receipts/<session-id>.keep.json: the PreToolUse half of a `trail keep` (4.9). */
export interface KeepReceipt {
  v: 1;
  kind: 'keep';
  session: string;
  /** The very file the hooks read for this session (receiptTranscriptRead, D82). */
  transcriptPath: string;
  toolUseId: string;
  /** Where the list was: the tool_result of a `trail init` call (its offset), or the handover the record names. */
  list: { offset: number; initRunId: string; via: 'init-call' | 'handover' };
  /** The first typed line after the list. */
  typed: { offset: number; lineSha: string };
  /** sha256 of the agent text between the list and the typed line, which named every item (4.9 step 3, R22). */
  replySha: string;
  /** What the command asked for. */
  numbers: number[] | 'none' | 'all';
  at: string;
  verdict: 'live' | 'held';
  heldWhy?: 'no-answer' | 'numbers' | 'not-shown' | 'host';
  usedAt: string | null;
}

/** receipts/<session-id>.lesson.json: the PreToolUse half of a lesson save (4.15). */
export interface LessonReceipt {
  v: 1;
  kind: 'lesson';
  session: string;
  transcriptPath: string;
  toolUseId: string;
  offerId: string;
  /** null for a moment-3 lesson (tied to a wall, no skill). */
  skill: string | null;
  /** The yes. */
  typed: { offset: number; lineSha: string };
  lessonSha: string;
  at: string;
  verdict: 'live' | 'held';
  heldWhy?: 'no-yes' | 'changed' | 'host';
  usedAt: string | null;
}

/* -------------------------------------------------------------------------- */
/* Phase 2 (design 1.0, c0). As in 1b: fields phase 2 adds to a 1a interface   */
/* sit in a further declaration of it, and are optional, so a state, ledger    */
/* or offers file written by 1a or 1b reads unchanged. A union field that      */
/* can't merge (OfferLine.moment, LedgerUse.cue, the status reasons) is        */
/* widened in place above.                                                     */
/* -------------------------------------------------------------------------- */

/** One block that came in for a job and was settled (4.9): followed when a step of it ran. Last 10, oldest first. */
export interface Firing { at: string; followed: boolean }

/** What a fold changes (4.2): a step, steps added, or steps kept as their own skill. */
export type FoldOp = 'update' | 'extend' | 'split';
/** A write of the file Trail wrote (4.5): one ledger `changed` line each. A split is a save; a retire is a status line. */
export type ChangeOp = 'update' | 'extend' | 'replace' | 'adopted' | 'restore-version';

/** 4.1: what the next run did against the skill. Counts only. */
export interface FidelityCounts { ran: number; missing: number; extra: number; changed: number }

export interface SkillState {
  /** 4.9: settled job and name cue blocks, last 10, oldest first. Reset when the skill changes version. */
  firings?: Firing[];
  /** 4.6: the proposal Trail wrote beside a hand-edited file; adopted when the file becomes byte-equal to it. */
  proposed?: { hash: string; version: number; op: FoldOp | 'replace'; at: string } | null;
  /** When Trail last changed the file (fold, replace, adopt, restore by version). */
  changedAt?: string | null;
  /** 4.5 (R8): a write in progress, so a crash between the file and the state is finished, not taken for a hand edit. */
  pendingWrite?: { hash: string; from: number; at: string } | null;
}

/** 2.3: the use line's fidelity facts, absent before phase 2. A 1b reader ignores them. */
export interface LedgerUseFacts {
  /** 4.1: counts only. */
  fid?: FidelityCounts;
  /** 8-hex shas of the compiled text of passing steps the skill lacks (`extraKey`), at most 4. Never the text. */
  extraShas?: string[];
  /** Steps that failed and were then done another way that passed, at most 4. */
  changedSteps?: number[];
  /** D137: gated steps this session couldn't ask for, handed to the person to run (counted in stepsRan). */
  handed?: number[];
}

/** A change to the file Trail wrote, one per write (4.5, 2.3). */
export type LedgerChanged = { at: string; event: 'changed'; skill: string; op: ChangeOp; from: number; to: number;
  offerId: string | null; lessonIds?: string[] };

export interface OfferLine {
  /** 2.4: on an answer line, what the yes chose: a fold op, drift's 'replace', or 'retire' (drift's or the retire proposal's). */
  op?: FoldOp | 'replace' | 'retire';
}

/** receipts/<session-id>.update.json: the PreToolUse half of `trail skills update` (4.11). No step text, only the two hashes. */
export interface UpdateReceipt {
  v: 1;
  kind: 'update';
  session: string;
  /** The very file the hooks read for this session (receiptTranscriptRead, D82). */
  transcriptPath: string;
  toolUseId: string;
  host: string;
  offerId: string;
  skillId: string;
  name: string;
  runId: string;
  op: FoldOp | 'replace';
  /** The SKILL.md hash the plan was computed from. */
  baseHash: string;
  /** 4.11: sha256 of the proposed file text, 16 hex. */
  proposalSha: string;
  /** The yes. */
  typed: { offset: number; lineSha: string };
  at: string;
  usedAt: string | null;
}
