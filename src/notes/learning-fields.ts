/**
 * What a learning says about itself beyond its title, author and date: a
 * stable id, what kind of learning it is, who it is for, whether it still
 * holds, and which older learning it replaces.
 *
 * A file written before these fields existed reads with defaults: its id
 * comes from its file name (the same id a new file of that name is given),
 * its status is active, and its scope comes from where it sits. A value a
 * learning can't hold (an unknown kind, a malformed id, a line break in a
 * repo key) is dropped rather than carried into what an agent reads.
 *
 * `replaces` means the newest wins: recall and `trail check` read only the
 * live learnings (`liveLearnings`), never one a newer learning replaced.
 */
import { createHash } from "node:crypto";
import { flatLine } from "./flatten.js";
import type { WallClass } from "../trace/types.js";

/** 1b: `lesson` is a wall lesson with no skill (R5). Recall, `trail check` and session start never load one as text (R47). */
export type LearningKind = "preference" | "guardrail" | "decision" | "lesson";
/** Who a learning is for: just you, everyone working in this repo, or everyone in your team. */
export type Scope = "personal" | "repo" | "team";
export type LearningStatus = "active" | "held" | "replaced" | "retired";
/** Where a learning's words came from: set by whatever saved it, never by a flag the agent passes. */
export type LearningSource = "person" | "init-typed" | "init-review" | "error-class" | "agent" | "correction" | "repair";
/** A built-in enforcement template (spec 12), and how it is enforced. No other value in 1b. */
export type LearningCheck = "no-timeout";
export type LearningEnforce = "sure-fail";

export const KINDS: readonly LearningKind[] = ["preference", "guardrail", "decision", "lesson"];
export const SCOPES: readonly Scope[] = ["personal", "repo", "team"];
export const STATUSES: readonly LearningStatus[] = ["active", "held", "replaced", "retired"];
export const SOURCES: readonly LearningSource[] = ["person", "init-typed", "init-review", "error-class", "agent", "correction", "repair"];
export const CHECKS: readonly LearningCheck[] = ["no-timeout"];
export const ENFORCES: readonly LearningEnforce[] = ["sure-fail"];
/**
 * The wall catalog's classes at run time, in the catalog's order (trace/walls.ts). Equal to the WallClass type and
 * to telemetry's wall_hit.class values; a test holds all three equal.
 */
export const WALL_CLASSES: readonly WallClass[] = [
  "timeout-missing", "zsh-no-match", "git-https-auth", "docker-rootless", "npm-e401-eotp", "claude-not-logged-in", "enospc",
];

/** A personal learning's `applies` when it holds in every repo, not just one. */
export const EVERY_REPO = "every repo";

export interface LearningFields {
  /** `l-3f9a21c4` (6 hex digits in older files): how other learnings and commands name this one. */
  id: string;
  kind?: LearningKind;
  /** `repo`: in the repo's `.trail/learnings/`, for everyone. `personal`: in ~/.trail, this machine only. `team`: from a team repo. */
  scope?: Scope;
  /** Personal only: the repo key it holds in, or "every repo". */
  applies?: string;
  /** Active unless the file says otherwise. Held ones wait for a yes and reach no agent. */
  status?: LearningStatus;
  /** The id of the older learning this one replaces. */
  replaces?: string;
  src?: LearningSource;
  /** 1b: a lesson's skill name. */
  skill?: string;
  /** 1b: a built-in enforcement template (spec 12). */
  check?: LearningCheck;
  /** 1b: how the template is enforced. */
  enforce?: LearningEnforce;
  /** 1b: the wall class a lesson or guardrail is tied to (P20). */
  wall?: WallClass;
  /** Counts only, on one line: "failed 56 of 57 times · 5 repos". */
  evidence?: string;
}

/** The front-matter keys, in the order they're written. */
export const LEARNING_KEYS = ["id", "kind", "scope", "applies", "status", "replaces", "src", "skill", "check", "enforce", "wall", "evidence"] as const;

/** `l-` and 6 to 16 lowercase hex digits. */
export const LEARNING_ID = /^l-[0-9a-f]{6,16}$/;
/** A repo key as `home.ts` makes them: `github.com/acme/api`, `local/…`. */
const REPO_KEY = /^[a-z0-9._-]+(?:\/[a-z0-9._-]+)*$/;
const EVIDENCE_MAX = 160;
/** A skill name as compile gives them (compile-words.ts NAME_RE, no `--`, no trailing `-`). Kept here so notes don't load compile. */
const SKILL_NAME = /^(?=[a-z0-9-]*[a-z])[a-z0-9][a-z0-9-]{1,47}$/;

function skillName(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const s = v.trim().toLowerCase();
  return SKILL_NAME.test(s) && !/--|-$/.test(s) ? s : undefined;
}

/** The file name in a path: after the last `/`, `\\` or a branch ref's `:`. */
export function learningFileName(path: string): string {
  return path.slice(Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"), path.lastIndexOf(":")) + 1);
}

/**
 * The id of a learning file that doesn't say its own: `l-` and the first 6 hex
 * digits of the file name's sha1. Files written before ids keep this one.
 */
export function learningId(fileName: string): string {
  return `l-${createHash("sha1").update(fileName).digest("hex").slice(0, 6)}`;
}

/**
 * The id a new learning is written with: the first 8 hex digits of the same
 * sha1, so a repo with hundreds of learnings doesn't hand two the same one.
 * Its first 6 are the id the file would get if its id line were lost.
 */
export function newLearningId(fileName: string): string {
  return `l-${createHash("sha1").update(fileName).digest("hex").slice(0, 8)}`;
}

/** `v` as one of `allowed`, ignoring case and padding, or undefined. */
function oneOf<T extends string>(v: unknown, allowed: readonly T[]): T | undefined {
  if (typeof v !== "string") return undefined;
  const s = v.trim().toLowerCase();
  return (allowed as readonly string[]).includes(s) ? (s as T) : undefined;
}

/** A learning id, normalised, or undefined when `v` isn't one. */
export function asLearningId(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const s = v.trim().toLowerCase();
  return LEARNING_ID.test(s) ? s : undefined;
}

function appliesValue(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const s = v.trim().toLowerCase();
  if (s === EVERY_REPO) return EVERY_REPO;
  return s.length <= 200 && REPO_KEY.test(s) ? s : undefined;
}

/** The fields of a learning's front matter `d`, read from the file `fileName`, with defaults for what it lacks. */
export function readLearningFields(d: Record<string, unknown>, fileName: string): LearningFields {
  const out: LearningFields = { id: asLearningId(d.id) ?? learningId(fileName), status: oneOf(d.status, STATUSES) ?? "active" };
  const kind = oneOf(d.kind, KINDS);
  const scope = oneOf(d.scope, SCOPES);
  const applies = appliesValue(d.applies);
  const replaces = asLearningId(d.replaces);
  const src = oneOf(d.src, SOURCES);
  const skill = skillName(d.skill);
  const check = oneOf(d.check, CHECKS);
  const enforce = oneOf(d.enforce, ENFORCES);
  const wall = oneOf(d.wall, WALL_CLASSES);
  // One line, the way every field an agent reads is (flatten.ts).
  const evidence = flatLine(d.evidence, EVIDENCE_MAX) || undefined;
  if (kind) out.kind = kind;
  if (scope) out.scope = scope;
  if (applies) out.applies = applies;
  if (replaces && replaces !== out.id) out.replaces = replaces;
  if (src) out.src = src;
  if (skill) out.skill = skill;
  if (check) out.check = check;
  if (enforce) out.enforce = enforce;
  if (wall) out.wall = wall;
  if (evidence) out.evidence = evidence;
  return out;
}

/** What `liveLearnings` needs to know of a learning. */
type Linked = Pick<LearningFields, "id" | "status" | "replaces" | "scope" | "kind"> & { date: string; path: string; ref?: string };

/** Whether following `replaces` from `x` comes back round to the id `to`. */
function leadsTo(x: Linked, to: string, byId: Map<string, Linked[]>): boolean {
  const seen = new Set<string>();
  const todo = x.replaces ? [x.replaces] : [];
  while (todo.length) {
    const id = todo.pop()!;
    if (id === to) return true;
    if (seen.has(id)) continue;
    seen.add(id);
    for (const n of byId.get(id) ?? []) if (n.replaces) todo.push(n.replaces);
  }
  return false;
}

function byIdOf(notes: Linked[]): Map<string, Linked[]> {
  const byId = new Map<string, Linked[]>();
  for (const n of notes) byId.set(n.id, [...(byId.get(n.id) ?? []), n]);
  return byId;
}

/**
 * Whether `r` replaces `x`. Only a learning someone has seen through counts:
 * not one on a teammate's unmerged branch, nor one held for a yes. A
 * just-for-you learning never hides one the repo or team shares. The newest
 * wins; on the same day the replacement does, and of learnings that replace
 * each other in a circle (only a hand edit makes one), the later file name.
 */
function replaces(r: Linked, x: Linked, byId: Map<string, Linked[]>): boolean {
  if (r === x || r.replaces !== x.id || r.id === x.id) return false;
  if (r.ref || r.status === "held") return false;
  if (r.scope === "personal" && x.scope !== "personal") return false;
  if (r.date !== x.date) return r.date > x.date;
  return r.path > x.path || !leadsTo(x, r.id, byId);
}

/** Active and not replaced (the rule both lists below share). */
function stillHold<T extends Linked>(notes: T[], counts: (r: T, x: T) => boolean): T[] {
  const byTarget = new Map<string, T[]>();
  for (const r of notes) if (r.replaces) byTarget.set(r.replaces, [...(byTarget.get(r.replaces) ?? []), r]);
  const byId = byIdOf(notes);
  return notes.filter((x) => (x.status ?? "active") === "active" && !(byTarget.get(x.id) ?? []).some((r) => replaces(r, x, byId) && counts(r, x)));
}

/**
 * The learnings that still hold: active ones (a file without a status is
 * active) that no newer learning replaces. Order is kept. `counts(r, x)` can
 * turn a replacement down: `trail check` lets only one on the base branch
 * hide a learning that is there.
 *
 * 1b (R47): never a `lesson`. Session start, recall, standing learnings and
 * `trail check` all read through here, and a lesson loads only through
 * `lastTimeText` once it has worked twice (`liveLessons`).
 */
export function liveLearnings<T extends Linked>(notes: T[], counts: (r: T, x: T) => boolean = () => true): T[] {
  return stillHold(notes, counts).filter((x) => x.kind !== "lesson");
}

/** The lessons that still hold, by the same rule: what `lastTimeText`'s caller reads (4.10). */
export function liveLessons<T extends Linked>(notes: T[]): T[] {
  return stillHold(notes, () => true).filter((x) => x.kind === "lesson");
}

/** The learnings among `notes` that replace `x` by the rule above, newest first. */
export function replacementsOf<T extends Linked>(notes: T[], x: T): T[] {
  const byId = byIdOf(notes);
  return notes.filter((r) => replaces(r, x, byId)).sort((a, b) => (a.date === b.date ? b.path.localeCompare(a.path) : b.date.localeCompare(a.date)));
}

/**
 * The learning `ref` names: by id, or by its file name (with or without `.md`,
 * or a path ending in it). An id is copied from file to file by hand, so when
 * two share one, the one in this checkout or on this machine comes before one
 * on a teammate's branch.
 */
export function findLearning<T extends Pick<LearningFields, "id"> & { path: string; ref?: string }>(notes: T[], ref: string): T | undefined {
  const id = asLearningId(ref);
  if (id) {
    const named = notes.filter((n) => n.id === id);
    return named.find((n) => !n.ref) ?? named[0];
  }
  const name = learningFileName(ref.trim());
  if (!name) return undefined;
  const file = name.endsWith(".md") ? name : `${name}.md`;
  return notes.find((n) => learningFileName(n.path) === file);
}
