/**
 * The skill store (design 1.4 and 2, spec 5 and 6). Personal skills live in
 * `~/.trail/skills/<name>/` (SKILL.md, scripts/, lessons/), each applying to
 * one repo or to every repo; what changes about them per person is in
 * `state/skills.json` (state.ts) and their history in the ledger. Repo skills
 * (`.agents/skills` in the checkout) and team skills (`~/.trail/teams`) are
 * modelled in every type, and their lists are empty until phase 3.
 *
 * Listing follows links (a skill folder kept elsewhere and linked in is
 * listed); writing never goes through one: a save makes a new folder, never
 * fills one that is there; forget and restore move a folder (or the link
 * itself) whole. Held items (store-held.ts) are never listed here, so recall
 * never sees them. Files 0600, folders 0700.
 */
import { readdirSync, renameSync, rmSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { JobClass } from '../trace/types.js';
import type { CompiledSkill, ParsedSkill, SkillFrom, SkillRef, SkillStatus } from './types.js';
import { trailPath } from '../util/private-fs.js';
import { parseSkillMd, renderSkillMd, skillHash } from './skillmd.js';
import { AGENT_COMMAND_NAMES, BUILT_IN_NAMES } from './compile-words.js';
import { readSettings, localDate } from './settings.js';
import { appendLedger } from './ledger.js';
import { getSkillState, handEdited, readSkillsState, updateSkillState } from './state.js';
import {
  checkSaveName, freeId, heldDir, homeSkillDirs, lstatOrNull, personalRef, privateDir, readCapped, retiredDir, safeName, skillsDir,
  startSkill, statOrNull, stepsTotal, takenAtHome, underStoreLock, writeSkillFolder,
} from './store-fs.js';
import { allHeld } from './store-held.js';

export { BUILT_IN_NAMES } from './compile-words.js';
export { newSkillId } from './store-fs.js';
export { dropHeld, keepHeld, listHeld, markHeldShown, saveHeld, type HeldItem } from './store-held.js';
export { personAtTerminal, type PersonCheck, type PersonDeps, type PsRow } from './person.js';

export function personalSkillsDir(env?: NodeJS.ProcessEnv): string {
  return skillsDir(env);
}

export interface ScopeCtx { repoKeys: string[]; checkout: string; env?: NodeJS.ProcessEnv }

interface Entry { ref: SkillRef; skill: ParsedSkill }

/** Every Trail skill folder in skills/ (links followed), by name; folders without `metadata.trail` are not Trail's. */
function personalEntries(env?: NodeJS.ProcessEnv): Entry[] {
  let names: string[];
  try {
    names = readdirSync(skillsDir(env));
  } catch {
    return [];
  }
  const out: Entry[] = [];
  for (const name of names.sort()) {
    if (name.startsWith('.') || !safeName(name) || !statOrNull(join(skillsDir(env), name))?.isDirectory()) continue;
    const text = readCapped(join(skillsDir(env), name, 'SKILL.md'));
    const skill = text === null ? null : parseSkillMd(text, name);
    if (skill) out.push({ ref: personalRef(skill.meta.trail, name, skill.meta.applies ?? null, env), skill });
  }
  return out;
}

const appliesTo = (applies: string | null, keys: Set<string>) => !applies || applies.toLowerCase() === 'every repo' || keys.has(applies.toLowerCase());

/** Personal skills that apply to any of repoKeys or 'every repo', then repo (stub), then team (stub). Follows symlinks. Excludes held, retired and settings.skillsOff. */
export function listSkills(ctx: ScopeCtx): SkillRef[] {
  const keys = new Set(ctx.repoKeys.map((k) => k.toLowerCase()));
  const off = new Set(readSettings(ctx.env).skillsOff);
  const state = readSkillsState(ctx.env).skills;
  const personal = personalEntries(ctx.env)
    .filter((e) => appliesTo(e.ref.applies, keys) && !off.has(e.ref.name) && state[e.ref.id]?.status !== 'retired')
    .map((e) => e.ref);
  return [...personal, ...listRepoSkills(ctx.checkout), ...listTeamSkills(ctx.repoKeys, ctx.env)];
}

/** Every personal skill regardless of applies (for `trail skills`). */
export function listAllPersonal(env?: NodeJS.ProcessEnv): SkillRef[] {
  return personalEntries(env).map((e) => e.ref);
}

/** Repo skills (`.agents/skills/*` with `metadata.trail`, committed HEAD only): phase 3, so none in 1a. */
export function listRepoSkills(_checkout: string): SkillRef[] {
  return []; // phase 3
}

/** Team skills (`~/.trail/teams/<team>/skills`, the team repo's default branch): phase 3, so none in 1a. */
export function listTeamSkills(_repoKeys: string[], _env?: NodeJS.ProcessEnv): SkillRef[] {
  return []; // phase 3
}

/**
 * The skill's SKILL.md, parsed (null when missing, not a file, over 64 KB, or not Trail's). A personal needs-fix
 * skill whose file no longer has the hash Trail wrote was changed by hand, and goes back to what it was (4.8).
 */
export function readSkill(ref: SkillRef, known?: { status?: string } | null): ParsedSkill | null {
  const text = readCapped(ref.file);
  const skill = text === null ? null : parseSkillMd(text, basename(ref.dir));
  if (skill && ref.scope === 'personal') {
    // The state file sits beside skills/ in the same Trail home: <home>/skills/<name> -> <home>.
    const env = { TRAIL_HOME: join(ref.dir, '..', '..') };
    try {
      // `known`: the state the caller already read for this skill (recall reads 200 skills against one state file).
      const status = known !== undefined ? known?.status : getSkillState(skill.meta.trail, env)?.status;
      if (status === 'needs-fix') handEdited(skill.meta.trail, skill.hash, env);
    } catch { /* the skill still reads */ }
  }
  return skill;
}

export function findSkill(name: string, ctx: ScopeCtx): SkillRef | null {
  return listSkills(ctx).find((r) => r.name === name) ?? null;
}

/** What follows `<name>` in a retired copy's folder name: `-<date>`, then `-2`, `-3` the same day. */
const RETIRED_TAIL = /^-(\d{4}-\d{2}-\d{2})(?:-(\d+))?$/;

/** The retired copies of a name, newest first: `.retired/<name>-<date>` then `-2`, `-3` the same day. */
function retiredCopies(name: string, env?: NodeJS.ProcessEnv): string[] {
  let names: string[];
  try {
    names = readdirSync(retiredDir(env));
  } catch {
    return [];
  }
  return names.flatMap((n) => {
    // A prefix check, not a regex built from the name: no character in it can mean anything.
    const m = n.startsWith(name) ? RETIRED_TAIL.exec(n.slice(name.length)) : null;
    return m ? [{ n, day: m[1]!, k: Number(m[2] ?? 1) }] : [];
  }).sort((a, b) => b.day.localeCompare(a.day) || b.k - a.k).map((x) => x.n);
}

/** Is SKILL.md in this folder Trail's (`metadata.trail`)? */
const trailMarked = (dir: string) => {
  const text = readCapped(join(dir, 'SKILL.md'));
  return text !== null && parseSkillMd(text, basename(dir)) !== null;
};

/**
 * Where the name is taken: 'personal' | 'retired' | 'held' | 'repo' | 'team' | 'host' (~/.claude/skills, ~/.agents/skills,
 * <checkout>/.claude/skills, <checkout>/.agents/skills, or one of Claude Code's own commands) | 'built-in'; null when
 * free. 'invalid' for a name that is not one folder name. In the checkout, a Trail skill (`metadata.trail`) is 'repo',
 * anything else 'host'.
 */
export function nameTaken(name: string, ctx: ScopeCtx): string | null {
  if (!safeName(name)) return 'invalid';
  if (BUILT_IN_NAMES.has(name)) return 'built-in';
  if (AGENT_COMMAND_NAMES.has(name)) return 'host';
  const env = ctx.env;
  if (lstatOrNull(join(skillsDir(env), name))) return 'personal';
  if (retiredCopies(name, env).length) return 'retired';
  if (lstatOrNull(join(heldDir(env), name))) return 'held';
  if (ctx.checkout) {
    for (const d of [join(ctx.checkout, '.agents', 'skills'), join(ctx.checkout, '.claude', 'skills')]) {
      if (lstatOrNull(join(d, name))) return trailMarked(join(d, name)) ? 'repo' : 'host';
    }
  }
  let teams: string[] = [];
  try {
    teams = readdirSync(trailPath(env, 'teams'));
  } catch { /* no team joined */ }
  if (teams.some((t) => safeName(t) && lstatOrNull(join(trailPath(env, 'teams'), t, 'skills', name)))) return 'team';
  if (homeSkillDirs(env).some((d) => lstatOrNull(join(d, name)))) return 'host';
  return null;
}

/**
 * Moment 2's "a Trail skill covers it" (4.12 condition 3): a skill in scope with this job and status candidate,
 * active or needs-fix, or a held item for this repo and job not yet shown. Retired never covers. A skill the person
 * turned off still covers its job: an offer would only make a second one.
 */
export function jobCovered(job: JobClass, ctx: ScopeCtx): boolean {
  const keys = new Set(ctx.repoKeys.map((k) => k.toLowerCase()));
  const state = readSkillsState(ctx.env).skills;
  const live = personalEntries(ctx.env).some((e) =>
    e.skill.meta.job === job && appliesTo(e.ref.applies, keys) && (state[e.ref.id]?.status ?? 'candidate') !== 'retired');
  if (live) return true;
  return allHeld(ctx.env).some((h) => h.shownAt === null && h.job === job && keys.has(h.repoKey.toLowerCase()));
}

/** Writes skills/<name>/SKILL.md (+ scripts/, empty lessons/), the state entry (candidate, source counts), ledger 'saved'. Locked. */
export function savePersonal(c: CompiledSkill, opts: { from: SkillFrom; runId: string; consent: 'offer-yes' | 'asked' | 'init'; stepsVerified: number; env?: NodeJS.ProcessEnv; now?: Date }): SkillRef {
  checkSaveName(c.name);
  const env = opts.env;
  const now = opts.now ?? new Date();
  return underStoreLock(env, () => {
    const id = freeId(c.meta.trail, c.name, env);
    const skill = id === c.meta.trail ? c : { ...c, meta: { ...c.meta, trail: id } };
    const text = renderSkillMd(skill);
    const dir = join(skillsDir(env), c.name);
    writeSkillFolder(dir, skill, text, { lessons: true });
    try {
      startSkill(id, {
        name: c.name, from: opts.from, runId: opts.runId, hash: skillHash(text), version: skill.meta.version,
        source: { commands: c.source.commands, failed: c.source.failed, at: c.source.at },
        consent: opts.consent, stepsVerified: opts.stepsVerified, stepsTotal: stepsTotal(c), now, env,
      });
    } catch (e) {
      rmSync(dir, { recursive: true, force: true }); // made just now: a skill with no state is undone whole
      throw e;
    }
    return personalRef(id, c.name, skill.meta.applies ?? null, env);
  });
}

/** The skill's id from its SKILL.md, or null. */
const idIn = (dir: string) => {
  const text = readCapped(join(dir, 'SKILL.md'));
  return text === null ? null : parseSkillMd(text, basename(dir))?.meta.trail ?? null;
};

/**
 * Moves skills/<name> to skills/.retired/<name>-<YYYY-MM-DD>/ (`-2`, `-3` the same day); status retired, prevStatus kept.
 * Phase 2 (4.9): the retire proposal's and drift's retire pass `reason: 'retire-offer'` (the ledger status line's
 * reason) and a hook's short `waitMs`; a busy store throws, as for the person.
 */
export function forgetSkill(name: string, env?: NodeJS.ProcessEnv, now: Date = new Date(),
  o: { reason?: 'forget' | 'retire-offer'; waitMs?: number } = {}): { ok: true; to: string } | { ok: false; reason: 'unknown' } {
  if (!safeName(name)) return { ok: false, reason: 'unknown' };
  const reason = o.reason === 'retire-offer' ? 'retire-offer' : 'forget';
  return underStoreLock(env, () => {
    const dir = join(skillsDir(env), name);
    if (!lstatOrNull(dir)) return { ok: false as const, reason: 'unknown' as const };
    const id = idIn(dir);
    privateDir(retiredDir(env));
    const day = localDate(now);
    let to = join(retiredDir(env), `${name}-${day}`);
    for (let k = 2; lstatOrNull(to); k++) to = join(retiredDir(env), `${name}-${day}-${k}`);
    renameSync(dir, to);
    if (id) moveStatus(id, reason, now, env);
    return { ok: true as const, to };
  }, o.waitMs);
}

/** The newest retired copy back to skills/<name>, with the status it had (needs-fix when it was, else prevStatus). */
export function restoreSkill(name: string, env?: NodeJS.ProcessEnv, now: Date = new Date()): { ok: true; ref: SkillRef } | { ok: false; reason: 'unknown' | 'name-taken' } {
  if (!safeName(name)) return { ok: false, reason: 'unknown' };
  return underStoreLock(env, () => {
    const [copy] = retiredCopies(name, env);
    if (!copy) return { ok: false as const, reason: 'unknown' as const };
    if (takenAtHome(name, env)) return { ok: false as const, reason: 'name-taken' as const };
    const dir = join(skillsDir(env), name);
    renameSync(join(retiredDir(env), copy), dir);
    const text = readCapped(join(dir, 'SKILL.md'));
    const skill = text === null ? null : parseSkillMd(text, name);
    const id = skill?.meta.trail ?? null;
    if (id) moveStatus(id, 'restore', now, env);
    return { ok: true as const, ref: personalRef(id ?? '', name, skill?.meta.applies ?? null, env) };
  });
}

/**
 * Forget: retired, remembering what it was (a needs-fix skill keeps the status before it and its why, so restore can
 * bring needs-fix back). Restore: back to needs-fix when it carries a why, else to prevStatus (candidate when unknown).
 */
function moveStatus(id: string, reason: 'forget' | 'restore' | 'retire-offer', now: Date, env?: NodeJS.ProcessEnv): void {
  let line: { from: SkillStatus; to: SkillStatus } | null = null;
  const next = updateSkillState(id, (s) => {
    if (!s) return undefined;
    if (reason !== 'restore') {
      if (s.status === 'retired') return s;
      if (s.status !== 'needs-fix') {
        s.prevStatus = s.status;
        delete s.statusWhy;
        delete s.fixHash;
      }
      line = { from: s.status, to: 'retired' };
      s.status = 'retired';
    } else {
      if (s.status !== 'retired') return s;
      const to: SkillStatus = s.statusWhy ? 'needs-fix' : s.prevStatus && s.prevStatus !== 'retired' && s.prevStatus !== 'needs-fix' ? s.prevStatus : 'candidate';
      line = { from: 'retired', to };
      s.status = to;
    }
    return s;
  }, env);
  const l = line as { from: SkillStatus; to: SkillStatus } | null;
  if (next && l) {
    try { appendLedger(id, { at: now.toISOString(), event: 'status', skill: id, from: l.from, to: l.to, reason }, env); } catch { /* the state is the truth */ }
  }
}
