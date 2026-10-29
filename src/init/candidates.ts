/**
 * Init's candidates (design 4.5): what the look-back found, as items the
 * screen or the relay can show.
 *
 * - Skills (skills on only, R60): a moment-2 job on 3+ session-days, 2+ of
 *   them costly (moment 2's bar, P12), compiled by 1a's compile from its
 *   newest checked run, then up to 2 more; the first that compiles wins.
 * - Guardrails: a wall with a template, seen on 2+ days on this machine and
 *   still true now.
 * - Preferences: the person's own lines (4.4), ticked (D23), unless a how-to,
 *   a kept learning or a phase 0 "no" already has them.
 * - PR-review findings (D24), as given.
 *
 * Closed, kept and deferred ids give nothing; nor does a job a kept skill
 * covers. Ranked within kind; `pickFive` picks what the screen shows, and the
 * skills it leaves out seed the pool (P10, R45). No typed text is written:
 * a preference is pointers, and its words live in memory only.
 */
import { createHash } from 'node:crypto';
import { localDate } from '../skills/settings.js';
import { jobCovered } from '../skills/store.js';
import { everyRepoLearnings } from '../notes/every-repo.js';
import { notePoolDay } from '../trace/pool.js';
import { OFFER_FAMILIES } from '../trace/jobs.js';
import type { JobClass } from '../trace/types.js';
import { WALLS } from '../trace/walls.js';
import { wallDays, type WallsFile } from '../trace/wall-state.js';
import { norm } from './look-back.js';
import { howtoDescribes, howtoKnows } from './howtos.js';
import type { JobFind } from './miners.js';
import { contentWords, jaccard, preferenceApplies, SAME_WORDS, type minePreferences } from './prefs.js';
import { compileInitSkill } from './replay-runs.js';
import type { InitCandidate, InitKind } from './types.js';

/** Moment 2's bar (P12): session-days and costly ones. */
export const SKILL_DAYS = 3;
export const SKILL_COSTLY = 2;
/** A wall seen on this many days on this machine (4.5). */
export const GUARD_DAYS = 2;
/** Never-shown skills seed this many days back, today included (R45). */
const SEED_DAYS = 45;
const EVERY_REPO = 'every repo';
const STOP = new Set(['a', 'an', 'the', 'to', 'of', 'in', 'on', 'for', 'and', 'or', 'it', 'this', 'that', 'is', 'be', 'with', 'please', 'here', 'i', 'you', 'we']);

/** 'i-' + sha256(kind + key) first 10 hex: stable across inits. */
export function candidateId(kind: InitKind, key: string): string {
  return `i-${createHash('sha256').update(kind + key).digest('hex').slice(0, 10)}`;
}

type Prefs = ReturnType<typeof minePreferences>;

export interface CandidateInput {
  jobs: JobFind[];
  walls: WallsFile;
  prefs: Prefs;
  howtos: Array<{ file: string; text: string }>;
  reviews: InitCandidate[];
  repoKey: string;
  repoWords: Set<string>;
  skills: boolean;
  closed: Set<string>;
  closedV1: Set<string>;
  kept: Set<string>;
  /** Ids to leave out as deferred: the caller passes them only on an agent run (4.5). */
  deferred: Set<string>;
  /** Resolves the Trail home (kept skills and learnings, names taken). */
  env?: NodeJS.ProcessEnv;
  /** The checkout init runs in. */
  checkout?: string;
  /** Machine facts now (4.5 "still true"): no `timeout` on PATH; an https origin with no credential helper. */
  machine?: { timeoutMissing: boolean; httpsNoHelper: boolean };
  /** Kept learnings' titles and text: a preference one of them already says is not offered. */
  learnings?: string[];
  /** Filled with each job that qualified but didn't compile, and each run's refusal word, newest first (`a, b`), and
   *  its session-days (the record and --verbose, D135 (3)). */
  skipped?: Array<{ job: JobClass; why: string; days?: number }>;
}

const dateOf = (sessionDay: string) => sessionDay.slice(0, 10);

function skillItems(i: CandidateInput, now: Date): InitCandidate[] {
  const env = i.env ?? process.env;
  const out: Array<InitCandidate & { score: number; boost: boolean }> = [];
  for (const j of i.jobs) {
    if (!OFFER_FAMILIES[j.job] || j.days.length < SKILL_DAYS || j.costly < SKILL_COSTLY) continue;
    const key = `${i.repoKey}|job:${j.job}`;
    const id = candidateId('skill', key);
    if (i.closed.has(id) || i.kept.has(id) || i.deferred.has(id)) continue;
    if (jobCovered(j.job, { repoKeys: [i.repoKey], checkout: i.checkout ?? '', env })) continue;
    let made: { compiled: import('../skills/types.js').CompiledSkill; skillSha: string; g: JobFind['good'][number] } | null = null;
    // Every run's reason, newest first, once each: the newest's alone can hide the one that mattered (fix-lab5).
    const whys: string[] = [];
    for (const g of j.good) {
      const c = compileInitSkill({ sheet: g.sheet, src: g.src.run, root: g.root }, g.prior, i.repoKey, env, now);
      if (c.ok) {
        made = { compiled: c.compiled, skillSha: c.skillSha, g };
        break;
      }
      if (!whys.includes(c.why)) whys.push(c.why);
    }
    if (!made) {
      i.skipped?.push({ job: j.job, why: whys.join(', ') || 'no-check', days: j.days.length });
      continue;
    }
    const programs = [...new Set(made.compiled.steps.map((s) => s.cmd.trim().split(/\s+/)[0] ?? '').filter(Boolean))];
    const file = howtoDescribes(i.howtos, j.job, programs);
    const dates = j.days.map(dateOf).sort();
    out.push({
      id, kind: 'skill', key, plainName: made.compiled.name, nameWords: [made.compiled.name],
      count: { days: j.days.length, from: dates[0]!, to: dates[dates.length - 1]!, costly: j.costly },
      scope: 'personal', applies: i.repoKey, typed: false, ticked: false,
      skill: { compiled: made.compiled, src: { ...made.g.src, run: { ...made.g.src.run }, skillSha: made.skillSha } },
      evidence: file ? [`your Claude Code how-to ${file} describes it`] : [], rank: 0,
      // Session-days times the costly share; ties go to more session-days.
      score: j.days.length * (j.costly / j.days.length) + j.days.length / 1000, boost: file !== null,
    });
  }
  out.sort((a, b) => b.score - a.score);
  // How-to evidence moves an item up one place.
  for (let k = 1; k < out.length; k++) {
    if (out[k]!.boost && !out[k - 1]!.boost) [out[k - 1], out[k]] = [out[k]!, out[k - 1]!];
  }
  return out.map(({ score: _s, boost: _b, ...c }, n) => ({ ...c, rank: n + 1 }));
}

function guardrailItems(i: CandidateInput): InitCandidate[] {
  const env = i.env ?? process.env;
  const m = i.machine ?? { timeoutMissing: false, httpsNoHelper: false };
  let keptWalls: Set<string>;
  try {
    keptWalls = new Set(everyRepoLearnings(env).map((n) => (n as { wall?: string }).wall).filter((x): x is string => !!x));
  } catch {
    keptWalls = new Set();
  }
  const out: InitCandidate[] = [];
  for (const w of WALLS) {
    const g = w.guardrail;
    if (!g) continue;
    const stillTrue = w.cls === 'timeout-missing' ? m.timeoutMissing : w.cls === 'git-https-auth' ? m.httpsNoHelper : false;
    if (!stillTrue) continue;
    const days = wallDays(i.walls, w.cls);
    if (days.length < GUARD_DAYS) continue;
    const key = `wall:${w.cls}`;
    const id = candidateId('guardrail', key);
    if (i.closed.has(id) || i.kept.has(id) || i.deferred.has(id) || keptWalls.has(w.cls)) continue;
    const name = g.fileName.replace(/\.md$/, '');
    out.push({
      id, kind: 'guardrail', key, plainName: name, nameWords: [name], count: { days: days.length, from: days[0]!, to: days[days.length - 1]! },
      scope: 'personal', applies: g.applies === EVERY_REPO ? EVERY_REPO : i.repoKey, typed: false, ticked: false,
      guardrail: { cls: w.cls, ...(g.check ? { check: g.check } : {}) }, evidence: [], rank: 0,
    });
  }
  return out.sort((a, b) => b.count.days - a.count.days).map((c, n) => ({ ...c, rank: n + 1 }));
}

const v1Hash = (line: string) => createHash('sha1').update(norm(line)).digest('hex').slice(0, 16);

function preferenceItems(i: CandidateInput): InitCandidate[] {
  const learned = (i.learnings ?? []).map((l) => l.split('\n').map(contentWords).filter((w) => w.length));
  const out: InitCandidate[] = [];
  for (const p of i.prefs) {
    if (howtoKnows(i.howtos, p.shortest)) continue;
    const mine = contentWords(p.shortest);
    if (learned.some((lines) => lines.some((w) => jaccard(mine, w) >= SAME_WORDS))) continue;
    if ((p.lines ?? [p.shortest]).some((l) => i.closedV1.has(v1Hash(l)))) continue;
    const key = `pref:${p.sha}`;
    const id = candidateId('preference', key);
    if (i.closed.has(id) || i.kept.has(id) || i.deferred.has(id)) continue;
    const words = p.shortest.toLowerCase().split(/[^a-z0-9'+-]+/).filter((w) => w && !STOP.has(w)).slice(0, 4);
    out.push({
      id, kind: 'preference', key, plainName: '', nameWords: words,
      count: { days: p.days.length, from: p.days[0]!, to: p.days[p.days.length - 1]! },
      scope: 'personal', applies: preferenceApplies(p.shortest, i.repoWords) === 'this repo' ? i.repoKey : EVERY_REPO,
      // D135 (2): a near-repeat is offered, never pre-ticked: the person didn't say it as a standing preference.
      typed: true, ticked: p.near !== true, pref: { refs: p.refs.slice(0, 3) }, evidence: [], rank: 0,
    });
  }
  return out.sort((a, b) => b.count.days - a.count.days).map((c, n) => ({ ...c, rank: n + 1 }));
}

export function buildCandidates(i: CandidateInput, now: Date = new Date()): InitCandidate[] {
  const reviews = i.reviews.filter((r) => !i.closed.has(r.id) && !i.kept.has(r.id) && !i.deferred.has(r.id)).map((r, n) => ({ ...r, rank: n + 1 }));
  return [...(i.skills ? skillItems(i, now) : []), ...guardrailItems(i), ...preferenceItems(i), ...reviews];
}

/** The at-most-5 the screen shows, in order (4.7): skill 1, guardrail 1, preference 1, skill 2, guardrail 2, preference 2, review 1, then by rank. */
export function pickFive(c: InitCandidate[]): InitCandidate[] {
  const of = (k: InitKind) => c.filter((x) => x.kind === k).sort((a, b) => a.rank - b.rank);
  const lists: Record<InitKind, InitCandidate[]> = { skill: of('skill'), guardrail: of('guardrail'), preference: of('preference'), review: of('review'), session: of('session'), claude: of('claude'), claudeai: of('claudeai') };
  const order: Array<[InitKind, number]> = [['skill', 0], ['guardrail', 0], ['preference', 0], ['skill', 1], ['guardrail', 1], ['preference', 1], ['review', 0]];
  const out: InitCandidate[] = [];
  for (const [k, n] of order) {
    const x = lists[k][n];
    if (x && out.length < 5) out.push(x);
  }
  const kinds: InitKind[] = ['skill', 'guardrail', 'preference', 'review', 'session', 'claude', 'claudeai'];
  const rest = c.filter((x) => !out.includes(x)).sort((a, b) => a.rank - b.rank || kinds.indexOf(a.kind) - kinds.indexOf(b.kind));
  for (const x of rest) if (out.length < 5) out.push(x);
  return out;
}

/**
 * Never-shown skills (P10, R45): a skill candidate the screen leaves out adds its session-days of the last 45 days
 * to the repo's pool (`goodRun: null`), so moment 2 can fire at its next checked success without counting history
 * again. Kept skills cover their job and closed ones were said no to: they are no candidates, so never seeded.
 */
export function seedNeverShown(jobs: JobFind[], candidates: InitCandidate[], shown: InitCandidate[], repoKey: string,
  env: NodeJS.ProcessEnv = process.env, now: Date = new Date()): void {
  const shownIds = new Set(shown.map((x) => x.id));
  const from = localDate(new Date(now.getFullYear(), now.getMonth(), now.getDate() - (SEED_DAYS - 1), 12));
  const today = localDate(now);
  for (const c of candidates) {
    if (c.kind !== 'skill' || shownIds.has(c.id)) continue;
    const job = c.key.slice(c.key.lastIndexOf('|job:') + 5) as JobClass;
    const j = jobs.find((x) => x.job === job);
    if (!j) continue;
    const costlyDays = new Set(j.costlyDays ?? []);
    for (const sd of j.days) {
      const d = dateOf(sd);
      if (d < from || d > today) continue;
      notePoolDay(repoKey, { job, words: j.words ?? [] }, { d, s: sd.slice(11), costly: costlyDays.has(sd) }, null, env, now);
    }
  }
}
