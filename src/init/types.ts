/**
 * The shapes `trail init` shares between its look-back (b5) and its screen,
 * relay and keep (b6): candidates, the items a person sees, what the
 * look-back read, and where an init skill came from.
 *
 * Types only. No typed text is ever stored in these on disk: a typed line is
 * a pointer to it (transcript, offset, sha), and an init skill is a byte
 * range in a host transcript plus the sha of what it compiled to.
 */
import type { CompiledSkill } from '../skills/types.js';
import type { WallClass } from '../trace/types.js';

export type InitKind = 'skill' | 'guardrail' | 'preference' | 'review' | 'session' | 'claude' | 'claudeai';

/** A pointer to a typed line. The line itself is never stored (0 rule 6). */
export interface TypedRef {
  /** The transcript path. */
  t: string;
  /** The line's byte offset. */
  o: number;
  /** sha256 of the line. */
  s: string;
}

export interface InitCandidate {
  /** 'i-' + sha256(kind + key) first 10 hex; stable across inits. */
  id: string;
  kind: InitKind;
  /** skill: '<repoKey>|job:<class>'; guardrail: 'wall:<cls>'; preference: 'pref:<cluster sha>'. */
  key: string;
  /** NAME_RE for skills; a fixed title for guardrails; '' for preferences (the line is the title). */
  plainName: string;
  /** Lead words for the relay check (4.9 step 3): the plain name, or the first 4 content words of the person's line. */
  nameWords: string[];
  count: { days: number; from: string; to: string; costly?: number; repos?: number };
  scope: 'personal' | 'repo';
  /** A repo key or 'every repo'. */
  applies: string;
  /** The person's own words (preferences only). */
  typed: boolean;
  /** Only typed preferences start ticked (D23). */
  ticked: boolean;
  /** The compiled skill (in memory) and where to compile it again. */
  skill?: { compiled: CompiledSkill; src: SkillSource };
  /** The template. */
  guardrail?: { cls: WallClass; check?: 'no-timeout' };
  /** Up to 3, newest first. */
  pref?: { refs: TypedRef[] };
  /** D24 items, unchanged from phase 0. */
  review?: { prs: number[] };
  /** #662: the Claude Code memory note a team row came from. */
  memory?: { path: string };
  /** A learning from the PRs or past sessions: what its file will say, shown when its row is opened. */
  detail?: string[];
  /** Counted words for the screen, e.g. 'your how-to release-notes.md describes it'. */
  evidence: string[];
  rank: number;
}

export interface InitItem extends InitCandidate {
  /** 1-based number on the screen or in the relay. */
  n: number;
  /** In memory only: the model's name, the plain name, or the person's line. */
  title: string;
  /** In memory only. */
  description: string;
}

export interface LookBack {
  sessions: Array<{ sh: string; how: 'own' | 'worktree' | 'clone' | 'ancestor'; days: number }>;
  skipped: Array<{ sh: string; why: 'headless' | 'ancestor-under-30' | 'unreadable' | 'too-old' | 'scratch' }>;
  days: number;
  from: string | null;
  to: string | null;
  parent: number;
  candidates: InitCandidate[];
  alreadyKept: { here: number; elsewhere: Array<{ repo: string; n: number }> };
  /** How-to file names read (never their text). */
  howtos: string[];
  ms: number;
  /** "couldn't read {what} this time ({reason})". */
  errors: string[];
}

export type KeepAnswer = { numbers: number[] } | { all: true } | { none: true };

/**
 * Where an init skill came from, enough to compile it again at keep (R24). No command text: the run's own byte
 * range in a host transcript, and the sha of the skill as compiled at init.
 */
export interface SkillSource {
  /** The transcript path, realpath under ~/.claude/projects or $CLAUDE_CONFIG_DIR/projects. */
  t: string;
  /** When init read it. */
  size: number;
  mtimeMs: number;
  /** Byte offsets: the run's first typed line to its last call. */
  run: { from: number; to: number };
  /** The prior checked run of the same job, for params. */
  prior: { t: string; from: number; to: number } | null;
  /** 1a skillSha(compiled). */
  skillSha: string;
}
