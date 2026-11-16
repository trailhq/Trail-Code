/**
 * What a keep writes (design 4.9), for the TTY screen, `--yes` and
 * `trail keep`, and `trail keep`'s CLI half.
 *
 * - A skill: on the TTY path, the skill compiled in this process (with the
 *   naming call's name and sentence, never its steps); on a relay path, only
 *   what `recompileInitSkill` gives again from the source transcript with
 *   the same `skillSha` (R24). Saved personal, `from: init`, consent `init`.
 * - A guardrail: the catalog's template (`guardrailLearning`), every repo
 *   in `~/.trail/learnings/`, or this repo's personal folder.
 * - A preference: the person's line read again by its pointer, sha checked,
 *   as the learning's body (P5); every repo, this repo, or the repo's
 *   committed `.trail/learnings/` after `r`.
 * - A PR-review finding: phase 0's write, unchanged (TTY only: its words
 *   are model text and never relayed).
 *
 * Then the record: kept and closed ids, `recordInitClosed` for every closed
 * skill (b4, R53), `pending` cleared (R66), and on the TTY path the D87
 * notice of what was kept with its undo. No typed word goes into the record.
 */
import { readdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { writeEveryRepo } from '../notes/every-repo.js';
import { guardrailLearning } from '../notes/guardrails.js';
import { newLearningId } from '../notes/learning-fields.js';
import { writeNote, type WriteNoteInput } from '../notes/notes.js';
import { saveReviewFindings, type ReviewFinding } from '../notes/pr-reviews.js';
import { repoPlace } from '../notes/home.js';
import { trailHome } from '../notes/trail-home.js';
import { recordInitClosed } from '../skills/offers.js';
import { receiptTranscriptOk, receiptTranscriptRead } from '../skills/receipts.js';
import { localDate, readSettings } from '../skills/settings.js';
import { savePersonal } from '../skills/store.js';
import { stepsTotal } from '../skills/store-fs.js';
import type { KeepReceipt, Receipt } from '../skills/types.js';
import { trailPath, withLock, writePrivate } from '../util/private-fs.js';
import { initKindCounts } from '../telemetry/contract.js';
import { track } from '../telemetry/track.js';
import { WALLS } from '../trace/walls.js';
import { readInitRecord, updateInitRecord, type KeptName, type PendingItem } from './init-record.js';
import { keepArgs, parseKeepAnswer, replyNamesList, withinAnswer } from './keep-answer.js';
import { pendingAsItem } from './handover.js';
import { afterList, linesFrom } from './keep-list.js';
import { markLookedBack } from './look-back.js';
import { readPlain } from './plain-file.js';
import { KEEP_LINE, RELAY_LINE } from './relay.js';
import { afterKeepLines, type ScreenFacts } from './review-screen.js';
import { applyName } from './name-call.js';
import { prefText } from './prefs.js';
import { lessonRefused, newLessonId, writeLesson } from '../skills/lessons.js';
import { onlyRepeats } from '../skills/follow-learnings.js';
import { recompileInitSkill, typedAt } from './replay-runs.js';
import { dayWords } from './review-screen.js';
import type { InitItem, KeepAnswer } from './types.js';

export { leadWords, parseKeepAnswer, replyNamesList } from './keep-answer.js';

export interface KeepResult {
  kept: InitItem[]; notKept: InitItem[]; refused: Array<{ item: InitItem; why: string }>;
  /** Part 7: kept preferences that only repeat a step of a skill kept with them, kept as a lesson on that skill instead. */
  folded?: Array<{ item: InitItem; skill: string }>;
}

/** Where a keep writes: the checkout (phase 0's notes) and its repo key; the run it answers; PR-review findings in memory. */
export interface KeepPlace {
  dir: string;
  repoKey: string;
  runId?: string | null;
  reviews?: Map<string, ReviewFinding>;
}

const span = (c: InitItem['count']) => (c.from === c.to ? dayWords(c.from) : `${dayWords(c.from)} to ${dayWords(c.to)}`);

/** A learning mined from past sessions is dated the day it was first said or hit, never the day it was kept. */
const firstDay = (c: InitItem['count'], now: Date) => (/^\d{4}-\d{2}-\d{2}$/.test(c.from) ? c.from : localDate(now));

/** phase 0's `writeNote` resolves the Trail home from process.env: refuse rather than write another home than `env`'s. */
function sameHome(env: NodeJS.ProcessEnv): boolean {
  return trailHome(env) === trailHome(process.env);
}

/** The person's line for a preference, whole, read again now; null when it changed or is gone. */
export function prefLine(item: Pick<InitItem, 'pref'>, env: NodeJS.ProcessEnv): string | null {
  const ref = item.pref?.refs[0];
  const text = ref ? typedAt(ref, env) : null;
  const line = text ? prefText(text) : '';
  return line || null;
}

const TITLE_MAX = 120;
/** A preference's title: its line, or over 120 characters cut after the last whole word that fits, with an ellipsis. */
export function prefTitle(line: string): string {
  if (line.length <= TITLE_MAX) return line;
  // Room for the ellipsis; a word that ends right at the cut is whole.
  const fit = line.slice(0, TITLE_MAX - 1);
  const at = /\s/.test(line[TITLE_MAX - 1]!) ? fit.length : fit.lastIndexOf(' ');
  return `${(at > 0 ? fit.slice(0, at) : fit).replace(/[\s,.;:]+$/, '')}…`;
}

function keepSkill(item: InitItem, how: 'tty' | 'yes' | 'keep', place: KeepPlace, env: NodeJS.ProcessEnv, now: Date): { id: string; name: string; steps: string[] } | string {
  const s = item.skill;
  if (!s) return 'gone';
  let compiled = s.compiled;
  if (how === 'tty') {
    if (!compiled) return 'gone';
    if (item.title && item.title !== compiled.name) compiled = applyName(compiled, { title: item.title, description: item.description || compiled.description });
  } else {
    const again = recompileInitSkill(s.src, place.repoKey, env, now);
    if (!again.ok) return again.why;
    compiled = again.compiled;
  }
  try {
    const ref = savePersonal(compiled, { from: 'init', runId: compiled.source.runId, consent: 'init', stepsVerified: stepsTotal(compiled), env, now });
    track('skill_saved', { from: 'init', scope: 'personal' });
    return { id: ref.id, name: compiled.name, steps: compiled.steps.map((s) => s.cmd) };
  } catch (e) {
    return e instanceof Error && /name|taken|exists/i.test(e.message) ? 'taken' : 'failed';
  }
}

function keepGuardrail(item: InitItem, place: KeepPlace, env: NodeJS.ProcessEnv, now: Date): { id: string; name: string } | string {
  const cls = item.guardrail?.cls;
  const w = WALLS.find((x) => x.cls === cls);
  if (!cls || !w?.guardrail) return 'gone';
  const input = { ...guardrailLearning(cls, item.applies, `${w.words} on ${item.count.days} days, ${span(item.count)}`, now), date: firstDay(item.count, now) };
  if (input.applies === 'every repo') {
    const path = writeEveryRepo(input, w.guardrail.fileName, env);
    return { id: newLearningId(basename(path)), name: item.plainName };
  }
  if (!sameHome(env)) return 'failed';
  const n = writeNote(place.dir, { ...input, applies: place.repoKey } as WriteNoteInput, 'personal');
  return { id: n.id ?? '', name: item.plainName };
}

function keepPreference(item: InitItem, place: KeepPlace, env: NodeJS.ProcessEnv, now: Date): { id: string; name: string } | string {
  const line = prefLine(item, env);
  if (!line) return 'gone';
  const input: WriteNoteInput = {
    title: prefTitle(line), body: line, author: '', date: firstDay(item.count, now), kind: 'preference', src: 'init-typed', standing: true,
    evidence: `said on ${item.count.days} days, ${span(item.count)}`,
  };
  if (item.scope !== 'repo' && item.applies === 'every repo') {
    const file = `pref-${item.key.replace(/^pref:/, '').replace(/[^a-z0-9]/g, '').slice(0, 16) || item.id.slice(2)}.md`;
    const path = writeEveryRepo(input, file, env);
    return { id: newLearningId(basename(path)), name: '' };
  }
  if (!sameHome(env)) return 'failed';
  const n = writeNote(place.dir, item.scope === 'repo' ? input : { ...input, applies: place.repoKey }, item.scope === 'repo' ? 'repo' : 'personal');
  return { id: n.id ?? '', name: '' };
}

/**
 * Part 7: the skill kept here whose steps a preference only repeats ("run scripts/gen_schema.py" beside a skill whose
 * step runs it), so the agent hears it once, with the skill. Only a preference for this repo just for the person: one
 * for every repo or added to the repo says more than one skill's step, and keeps its own place.
 */
function foldInto(item: InitItem, skills: Array<{ name: string; steps: string[] }>, env: NodeJS.ProcessEnv): { name: string; line: string } | null {
  if (item.scope === 'repo' || item.applies === 'every repo' || !skills.length) return null;
  const line = prefLine(item, env);
  if (!line || lessonRefused(line)) return null;
  const s = skills.find((k) => onlyRepeats(line, k.steps));
  return s ? { name: s.name, line } : null;
}

/** The preference as a lesson on the skill: the person's own words, dated the day they first said it. */
function keepAsLesson(item: InitItem, into: { name: string; line: string }, place: KeepPlace, env: NodeJS.ProcessEnv, now: Date): { id: string; name: string } {
  const id = newLessonId();
  writeLesson({ id, skill: into.name, at: firstDay(item.count, now), text: into.line, kind: 'lesson', src: 'correction', wall: null }, place.repoKey, env);
  return { id, name: '' };
}

function keepReview(item: InitItem, place: KeepPlace): { id: string; name: string } | string {
  const f = place.reviews?.get(item.id);
  if (!f) return 'gone';
  const [n] = saveReviewFindings(place.dir, [f]);
  return n ? { id: n.id ?? '', name: '' } : 'failed';
}

/**
 * Writes what the person picked: skills (savePersonal, consent 'init'), guardrails and preferences (every-repo.ts,
 * or writeNote for one repo), PR-review findings (phase 0). `all` is every item shown; on 'tty' and 'keep' the
 * shown items not kept are closed (a refused one is neither: it can come back), on 'yes' they stay pending.
 */
export function keepItems(picked: InitItem[], all: InitItem[], how: 'tty' | 'yes' | 'keep', env: NodeJS.ProcessEnv = process.env, now: Date = new Date(),
  place?: KeepPlace): KeepResult {
  const at = place ?? { dir: process.cwd(), repoKey: all[0]?.applies && all[0].applies !== 'every repo' ? all[0].applies : '' };
  const kept: InitItem[] = [];
  const refused: KeepResult['refused'] = [];
  const names: KeptName[] = [];
  // Part 7: skills first, so a preference that only repeats a step of one kept here goes into it as a lesson.
  const skills: Array<{ name: string; steps: string[] }> = [];
  const folded: NonNullable<KeepResult['folded']> = [];
  for (const item of [...picked].sort((a, b) => Number(b.kind === 'skill') - Number(a.kind === 'skill'))) {
    let r: { id: string; name: string } | string;
    try {
      const into = item.kind === 'preference' ? foldInto(item, skills, env) : null;
      r = item.kind === 'skill' ? keepSkill(item, how, at, env, now)
        : item.kind === 'guardrail' ? keepGuardrail(item, at, env, now)
          : into ? keepAsLesson(item, into, at, env, now)
            : item.kind === 'preference' ? keepPreference(item, at, env, now)
              : keepReview(item, at);
      if (typeof r !== 'string' && 'steps' in r) skills.push({ name: r.name, steps: r.steps as string[] });
      if (into && typeof r !== 'string') folded.push({ item, skill: into.name });
    } catch {
      r = 'failed';
    }
    if (typeof r === 'string') {
      refused.push({ item, why: r });
      continue;
    }
    kept.push(item);
    names.push({ kind: item.kind, name: r.name, id: r.id, forget: r.name || r.id });
  }
  const pickedIds = new Set(picked.map((i) => i.id));
  const notKept = all.filter((i) => !pickedIds.has(i.id));
  const closed = how === 'yes' ? [] : notKept;
  for (const c of closed) if (c.kind === 'skill' && at.repoKey) {
    try {
      recordInitClosed(at.repoKey, c.key, env, now);
    } catch { /* the record still closes it */ }
  }
  if (at.repoKey) {
    updateInitRecord(at.repoKey, (r) => {
      const keptIds = kept.map((i) => i.id);
      const closedIds = closed.map((i) => i.id);
      r.closed = [...new Set([...r.closed, ...closedIds])];
      const done = new Set([...keptIds, ...closedIds]);
      r.deferred = r.deferred.filter((id) => !done.has(id));
      const run = r.runs.find((x) => x.id === (at.runId ?? r.pendingFrom));
      if (run) {
        run.kept = [...new Set([...run.kept, ...keptIds])];
        run.closed = [...new Set([...run.closed, ...closedIds])];
      }
      if (how !== 'yes') {
        r.pending = [];
        r.pendingFrom = null;
        r.handedAt = null;
        r.handover = null;
      } else {
        const gone = new Set(keptIds);
        r.pending = r.pending.filter((p) => !gone.has(p.id));
      }
      if (how === 'tty' && names.length) {
        // A notice no session start has named yet keeps its items: each kept item is named once (D87, O8, b6 review).
        const earlier = r.notice && r.notice.shownAt === null ? r.notice.items.filter((x) => !names.some((y) => y.id === x.id)) : [];
        r.notice = { run: run?.id ?? at.runId ?? 'ir-0000', at: now.toISOString(), items: [...earlier, ...names].slice(-20), shownAt: null };
      }
    }, env);
  }
  track('cold_start', { source: how === 'keep' ? 'keep' : 'sessions', outcome: 'kept', ...initKindCounts('kept', kept) });
  return { kept, notKept, refused, ...(folded.length ? { folded } : {}) };
}

/* -------------------------------------------------------------------------- */
/* trail keep: the CLI half (4.9)                                             */
/* -------------------------------------------------------------------------- */

/** A keep receipt older than this is stale (2.11). */
const FRESH_MS = 2 * 60 * 60_000;
const AHEAD_MS = 5_000;

export const KEEP_USAGE = 'trail keep <numbers> keeps items from the list trail init printed, after the person typed their numbers: trail keep 1 3, trail keep all, or trail keep none';
export const KEEP_HELD = "Nothing kept: Trail couldn't find the person's answer after the list.";
export const KEEP_AT_TTY = 'Pick in your terminal: trail init --look-back';
export const KEEP_NOTHING_WAITS = 'Nothing waits for an answer in this repo: run trail init to look back at your past sessions.';

function asKeepReceipt(v: unknown): KeepReceipt | null {
  const r = v as KeepReceipt;
  if (!r || typeof r !== 'object' || r.v !== 1 || r.kind !== 'keep' || typeof r.session !== 'string' || typeof r.transcriptPath !== 'string') return null;
  if (!r.list || !Number.isSafeInteger(r.list.offset) || typeof r.list.initRunId !== 'string' || (r.list.via !== 'init-call' && r.list.via !== 'handover')) return null;
  if (!r.typed || !Number.isSafeInteger(r.typed.offset) || typeof r.typed.lineSha !== 'string' || typeof r.replySha !== 'string' || typeof r.at !== 'string') return null;
  if (r.verdict !== 'live' || (r.usedAt !== null && typeof r.usedAt !== 'string')) return null;
  return r;
}

/** The newest unused, fresh keep receipt for this list (the record's `pendingFrom`), and its path. */
function findKeepReceipt(runId: string, env: NodeJS.ProcessEnv, now: Date): { path: string; r: KeepReceipt } | null {
  const dir = trailPath(env, 'receipts');
  let names: string[];
  try {
    names = readdirSync(dir).filter((n) => n.endsWith('.keep.json'));
  } catch {
    return null;
  }
  let best: { path: string; r: KeepReceipt } | null = null;
  for (const n of names) {
    const path = join(dir, n);
    const text = readPlain(path, 64 * 1024);
    let r: KeepReceipt | null = null;
    try {
      r = text === null ? null : asKeepReceipt(JSON.parse(text));
    } catch { /* not a receipt */ }
    if (!r || r.usedAt !== null || r.list.initRunId !== runId) continue;
    const age = now.getTime() - Date.parse(r.at);
    if (Number.isNaN(age) || age > FRESH_MS || age < -AHEAD_MS) continue;
    if (!best || Date.parse(r.at) > Date.parse(best.r.at)) best = { path, r };
  }
  return best;
}

const sameNumbers = (a: KeepAnswer, b: KeepReceipt['numbers']) =>
  'none' in a ? b === 'none' : 'all' in a ? b === 'all' : Array.isArray(b) && JSON.stringify([...b].sort((x, y) => x - y)) === JSON.stringify(a.numbers);

/** The list's text at the receipt's offset: the tool_result there must hold the relay and keep lines. */
function listTextAt(path: string, offset: number): string | null {
  const [first] = linesFrom(path, { from: offset, bytes: 2 * 1024 * 1024 }) ?? [];
  if (!first || first.offset !== offset) return null;
  try {
    const e = JSON.parse(first.line) as { type?: string; message?: { content?: unknown } };
    if (e.type !== 'user' || !Array.isArray(e.message?.content)) return null;
    for (const part of e.message!.content as Array<Record<string, unknown>>) {
      if (part?.type !== 'tool_result') continue;
      const c = part.content;
      const text = typeof c === 'string' ? c : Array.isArray(c) ? c.map((x) => (typeof (x as { text?: unknown })?.text === 'string' ? (x as { text: string }).text : '')).join('\n') : '';
      if (text.includes(RELAY_LINE) && text.includes(KEEP_LINE)) return text;
    }
  } catch { /* not a list */ }
  return null;
}

/** A relayed item as keep needs it, rebuilt from the record: the person's line read again for a preference's title. */
/**
 * The CLI half of `trail keep` (4.9). Always needs a KeepReceipt (R23): the PreToolUse half wrote it after it found
 * the list, the agent's reply naming every item, and the person's typed numbers. Here everything is read again from
 * the transcript, and only what still agrees is kept.
 */
export function keepCommand(args: string[], env: NodeJS.ProcessEnv, now: Date = new Date(),
  opts: { dir?: string; tty?: boolean; onFound?: () => void } = {}): { code: 0 | 1; lines: string[] } {
  if (args.some((a) => a === '--help' || a === '-h')) return { code: 0, lines: [KEEP_USAGE] };
  const asked = keepArgs(args);
  if (!asked) return { code: 1, lines: [KEEP_USAGE] };
  const dir = opts.dir ?? process.cwd();
  const repoKey = repoPlace(dir, env).key;
  const record = readInitRecord(repoKey, env);
  if (!record.pending.length || !record.pendingFrom) return { code: 1, lines: [KEEP_NOTHING_WAITS] };
  const tty = opts.tty ?? (process.stdin.isTTY === true && process.stdout.isTTY === true);
  const found = findKeepReceipt(record.pendingFrom, env, now);
  if (!found) return { code: 1, lines: [tty ? KEEP_AT_TTY : KEEP_HELD] };
  const r = found.r;
  const held = { code: 1 as const, lines: [KEEP_HELD] };
  const asReceipt = { ...r, host: 'claude', tier: 'A' } as unknown as Receipt;
  if (!receiptTranscriptOk(asReceipt, env) || !receiptTranscriptRead(asReceipt, env)) return held;
  const all = record.pending.map((p) => pendingAsItem(p, env));
  const names = all.map((i) => ({ n: i.n, nameWords: i.nameWords }));
  if (r.list.via === 'init-call') {
    const text = listTextAt(r.transcriptPath, r.list.offset);
    if (!text || !replyNamesList(text, names)) return held;
  } else if (record.handover?.session !== r.session || record.handover.offset !== r.list.offset) return held;
  const after = afterList(r.transcriptPath, r.list, env);
  if (!after || after.tampered || !after.typed || after.replySha !== r.replySha) return held;
  if (after.typed.offset !== r.typed.offset || after.typed.lineSha !== r.typed.lineSha || !replyNamesList(after.reply, names)) return held;
  const typed = parseKeepAnswer(after.typed.text);
  const listed = all.map((i) => i.n);
  if (!typed || !sameNumbers(asked, r.numbers) || !withinAnswer(asked, typed, listed)) return held;
  // Deferred items (B5): only when the person's typed numbers named them on this list.
  const deferred = new Set(record.deferred);
  const named = 'numbers' in typed ? new Set(typed.numbers) : new Set<number>();
  const want = 'none' in asked ? [] : 'all' in asked ? listed : asked.numbers;
  // A deferred item the typed numbers didn't name is neither kept nor closed: it waits for the person's own init.
  const waits = new Set(all.filter((i) => deferred.has(i.id) && !named.has(i.n)).map((i) => i.id));
  const picked = all.filter((i) => want.includes(i.n) && !waits.has(i.id));
  opts.onFound?.();
  // The receipt is claimed before anything is written: a second keep that found it too gets nothing (b6 review).
  if (!claimKeep(found.path, r, now)) return held;
  const result = keepItems(picked, all.filter((i) => !waits.has(i.id)), 'keep', env, now, { dir, repoKey, runId: record.pendingFrom });
  markLookedBack(dir, now, env);
  const s = readSettings(env);
  const facts = { skills: s.skills === 'on', offers: s.offers, offersOffAt: s.offersOffAt } as ScreenFacts;
  return { code: 0, lines: afterKeepLines({ ...result, how: 'keep' }, facts) };
}

/** Sets usedAt on the receipt under its lock; true only when it was still this one and unused (this keep owns it). */
function claimKeep(path: string, r: KeepReceipt, now: Date): boolean {
  try {
    const done = withLock(path, () => {
      const text = readPlain(path, 64 * 1024);
      const cur = text === null ? null : asKeepReceipt(JSON.parse(text));
      if (!cur || cur.usedAt !== null || cur.at !== r.at || cur.typed.lineSha !== r.typed.lineSha) return false;
      writePrivate(path, `${JSON.stringify({ ...cur, usedAt: now.toISOString() }, null, 2)}\n`);
      return true;
    }, 1000);
    return done.ok && done.value === true;
  } catch {
    return false;
  }
}
