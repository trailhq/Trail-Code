/**
 * Typed preferences, found without a model (design 4.4, P3): the standing
 * or corrective things the person told the agent on more than one day.
 * This replaces phase 0's find call, which sent their typed text to Claude.
 *
 * Pure and in memory: the lines come from the replay (pointers plus text),
 * the text never leaves the worker, and what is found is clusters of
 * pointers with the shortest line to show. A line counts only when it is a
 * preference's shape (4.4 step 1); lines cluster by their content words
 * (lowercased, stop words out, a small stemmer so "published" meets
 * "publish"); a cluster counts on 2+ local days that are not one 8 h
 * sitting (phase 0's rule, D46).
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { secretReason } from '../notes/secrets.js';
import { askText, isStatusOrHistory, matchJob, MAX_ASK_WORDS, wordCount } from '../trace/jobs.js';
import { PASTE_MARK } from '../trace/claude.js';
import { isCorrection } from '../trace/typed.js';
import { readPlain } from './plain-file.js';
import type { TypedRef } from './types.js';

/** Two lines whose times all fall closer than this are one sitting that crossed midnight (phase 0, D46). */
export const SITTING_MS = 8 * 60 * 60 * 1000;
/** Content-word Jaccard at or over this joins two lines (4.4 step 3). */
export const SAME_WORDS = 0.5;
const TITLE_CHARS = 120;
/** package.json or a Makefile read for the repo's names, at most this big. */
const REPO_FILE_MAX = 1024 * 1024;
/** Preference-shaped lines clustered at most, the newest: single-link clustering is quadratic in them (b5 review). */
export const MAX_PREF_LINES = 2000;
const MAX_REFS = 3;

/** Verbs a preference opens with once a correction's lead word ("no,", "actually,") is set aside. */
const IMPERATIVE = new Set([
  'use', 'run', 'keep', 'write', 'say', 'call', 'prefer', 'put', 'add', 'make', 'check', 'ask', 'push', 'commit', 'test', 'read', 'show',
  'explain', 'open', 'stop', 'start', 'leave', 'avoid', 'try', 'do', "don't", 'dont', 'never', 'always', 'give', 'tell', 'let', 'wait',
  'merge', 'rebase', 'deploy', 'publish', 'build', 'install', 'remove', 'delete', 'move', 'rename', 'name', 'format', 'lint', 'quote',
  'include', 'skip', 'follow', 'stay', 'be', 'go', 'set', 'pin', 'reply', 'answer', 'ship', 'release', 'branch', 'squash', 'sign', 'mention',
]);
const STANDING = /^(?:always|never|don'?t|do not|stop|please (?:always|never|don'?t))\b/i;
const NOT_THAT = /\b(?:instead of|rather than|not)\b .{1,40}$/i;
const LEADS = /^(?:use|keep|write|say|call it|prefer)\b/i;
/** A correction's lead, set aside to read the rest: "no,", "nope", "actually,", "wrong,". */
const CORRECTION_LEAD = /^(?:no|nope|actually|wrong|not like that|that'?s (?:wrong|not right))[,.!:;\s-]+/i;

const STOP = new Set([
  'a', 'an', 'the', 'to', 'of', 'in', 'on', 'for', 'and', 'or', 'it', 'its', 'this', 'that', 'these', 'those', 'is', 'are', 'be', 'with',
  'at', 'by', 'from', 'as', 'please', 'i', 'you', 'we', 'me', 'my', 'your', 'our', 'just', 'so', 'then', 'here', 'there', 'when', 'if',
  'can', 'will', 'should', 'would', 'pl', 'all', 'any', 'some', 'up', 'out', 'too', 'also', 'ok', 'okay',
]);

/**
 * D102: how the person wants to be talked to ("explain it simply", "keep it short", "use plain words", "no jargon",
 * "be brief" and close variants). A preference shape, and about the person, so it applies in every repo.
 */
const STYLE = [
  /^(?:please,?\s+)?(?:explain|say|describe|write|answer|reply|talk|put)\b.{0,60}\b(?:simply|simpler|plainly|briefly|concisely|in plain (?:words|english|language)|in simple (?:words|terms|language))\b/i,
  /^(?:please,?\s+)?(?:keep|make)\s+(?:it|this|that|them|things|(?:your\s+)?(?:answers?|replies|reply|responses?|explanations?|messages?|summaries|summary))\s+(?:short|shorter|brief|briefer|simple|simpler|concise|plain|tight)\b/i,
  /^(?:please,?\s+)?(?:use|in|speak|write in)\s+(?:plain|simple|simpler|everyday|short)\s+(?:words|english|language|terms|sentences)\b/i,
  /^(?:plain|simple)\s+(?:english|words|language)\b/i,
  /^(?:please,?\s+)?(?:no|less|fewer|avoid|skip|without|drop the)\s+(?:the\s+)?jargon\b/i,
  /^(?:please,?\s+)?be\s+(?:brief|briefer|concise|terse|short|succinct|direct)\b/i,
  /^(?:shorter|simpler|briefer|plainer)\s+(?:answers?|replies|responses?|explanations?|words|sentences|please)\b/i,
  /^(?:please,?\s+)?(?:one|an?) example first\b/i,
];

/** The person's own words in a typed line: no quoted (`>`) lines, no code block, no paste marker, one line. */
export function prefText(text: string): string {
  return askText(String(text ?? '')).split(PASTE_MARK).join(' ').replace(/\s+/g, ' ').trim();
}

/** D102: a style preference ("explain it simply", "keep it short", "no jargon"), which applies in every repo. */
export function isStylePreference(text: string): boolean {
  const t = prefText(text).replace(/[.!]+$/, '');
  return STYLE.some((re) => re.test(t));
}

const firstWord = (t: string) => (/^[\s"'(]*([a-z][a-z']*)/i.exec(t)?.[1] ?? '').toLowerCase();

/** 4.4 step 1: a standing or corrective line of 25 words or fewer that is not a job ask, a question or a secret. */
export function isPreferenceShape(text: string): boolean {
  const t = prefText(text);
  if (!t || wordCount(t) > MAX_ASK_WORDS || /\?\s*$/.test(t)) return false;
  if (matchJob(t) || isStatusOrHistory(t) || secretReason(t) !== null) return false;
  if (STANDING.test(t) || LEADS.test(t) || isStylePreference(t)) return true;
  if (NOT_THAT.test(t) && IMPERATIVE.has(firstWord(t))) return true;
  if (isCorrection(t)) {
    const rest = t.replace(CORRECTION_LEAD, '');
    return rest !== t && IMPERATIVE.has(firstWord(rest));
  }
  return false;
}

/** A small stemmer: possessive, -ing, -ed, -es after a hiss, plural -s, then a final -e, so forms of one verb meet. */
function stem(w: string): string {
  let s = w.replace(/'s$/, '');
  if (s.length > 5 && s.endsWith('ing')) s = s.slice(0, -3);
  else if (s.length > 4 && s.endsWith('ed')) s = s.slice(0, -2);
  else if (s.length > 4 && /(?:sh|ch|x|ss|z)es$/.test(s)) s = s.slice(0, -2);
  else if (s.length > 3 && s.endsWith('s') && !s.endsWith('ss')) s = s.slice(0, -1);
  if (s.length > 2 && s.endsWith('e')) s = s.slice(0, -1);
  return s;
}

/** Content words, stemmed, sorted, once each (4.4 step 2). */
export function contentWords(text: string): string[] {
  const words = String(text ?? '').toLowerCase().split(/[^a-z0-9'+-]+/).map((w) => w.replace(/^['-]+|['-]+$/g, '')).filter((w) => w && !STOP.has(w));
  return [...new Set(words.map(stem))].filter(Boolean).sort();
}

/** |a ∩ b| / |a ∪ b|; 0 when both are empty. */
export function jaccard(a: readonly string[], b: readonly string[]): number {
  if (!a.length && !b.length) return 0;
  const sa = new Set(a);
  const inter = b.filter((w) => sa.has(w)).length;
  return inter / (sa.size + new Set(b).size - inter);
}

type Line = { ref: TypedRef; day: string; text: string; at?: string };

/** D135 (2): a near-repeat is short: at most this many words, at least NEAR_MIN_WORDS content words. */
export const NEAR_MAX_WORDS = 12;
const NEAR_MIN_WORDS = 3;
/** Almost word for word: content-word Jaccard at or over this. */
export const NEAR_WORDS = 0.8;
/** On this many local days or more. */
export const NEAR_DAYS = 3;
/** A request for something now, not a way of working: aimed at the person ("show me"), or tied to a time ("today"). */
const NEAR_REQUEST = /^\S+\s+(?:me|us)\b|\b(?:today|tonight|yesterday|tomorrow|right now|this (?:morning|afternoon|evening|week))\b/i;

/**
 * D135 (2): a short imperative that 4.4's shape doesn't read ("add a changelog entry for each fix"): an imperative
 * verb first, once a correction's lead is set aside; not a question, a job ask, a status question, a request for
 * something now, or a secret.
 */
export function isNearRepeatShape(text: string): boolean {
  const t = prefText(text);
  if (!t || wordCount(t) > NEAR_MAX_WORDS || /\?\s*$/.test(t) || contentWords(t).length < NEAR_MIN_WORDS) return false;
  if (matchJob(t) || isStatusOrHistory(t) || NEAR_REQUEST.test(t) || secretReason(t) !== null) return false;
  return IMPERATIVE.has(firstWord(t.replace(CORRECTION_LEAD, '')));
}

/**
 * Typed preference clusters (4.4): standing or corrective shapes, on 2+ local days, not one 8 h sitting. Text stays
 * in memory. `refs`: the shortest line's pointer first (the title the screen reads again), then the newest, at most
 * 3. `sha`: 16 hex of the cluster's oldest line's content words, so it holds as the person says it again. `lines`: every
 * line of the cluster (in memory only: phase 0's closed quote hashes are checked against them). `near`: a D135 (2)
 * near-repeat (a short imperative typed almost word for word on 3+ days), which the screen shows unticked.
 */
export type PrefCluster = { sha: string; refs: TypedRef[]; days: string[]; shortest: string; lines: string[]; near?: true };

export function minePreferences(typed: Line[], _now: Date = new Date()): PrefCluster[] {
  const shaped = clusterLines(typed, isPreferenceShape, SAME_WORDS, 2);
  // D135 (2): near-repeats, unless a shaped cluster already says it.
  const said = shaped.map((c) => contentWords(c.shortest));
  const near = clusterLines(typed, (t) => !isPreferenceShape(t) && isNearRepeatShape(t), NEAR_WORDS, NEAR_DAYS)
    .filter((c) => !said.some((w) => jaccard(w, contentWords(c.shortest)) >= SAME_WORDS))
    .map((c) => ({ ...c, near: true as const }));
  return [...shaped, ...near];
}

function clusterLines(typed: Line[], shape: (text: string) => boolean, same: number, minDays: number): PrefCluster[] {
  // Only the person's own words: a quoted block, a code block or a paste is never a preference's (D99, b5 review).
  const lines = typed.filter((l) => l && typeof l.text === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(l.day) && shape(l.text))
    .map((l, i) => ({ ...l, raw: l.text, text: prefText(l.text), i, words: contentWords(prefText(l.text)), time: l.at ? Date.parse(l.at) : NaN }))
    .filter((l) => l.words.length > 0);
  // Newest first: by time where known, else by order of reading.
  lines.sort((a, b) => (Number.isNaN(a.time) || Number.isNaN(b.time) ? b.i - a.i : b.time - a.time || b.i - a.i));
  const clusters: Array<typeof lines> = [];
  for (const l of lines.slice(0, MAX_PREF_LINES)) {
    const home = clusters.find((c) => c.some((m) => jaccard(m.words, l.words) >= same));
    if (home) home.push(l);
    else clusters.push([l]);
  }
  const out: PrefCluster[] = [];
  for (const c of clusters) {
    const days = [...new Set(c.map((l) => l.day))].sort();
    if (days.length < minDays) continue;
    const times = c.map((l) => l.time).filter((t) => !Number.isNaN(t));
    if (times.length === c.length && Math.max(...times) - Math.min(...times) < SITTING_MS) continue;
    const shortest = [...c].sort((a, b) => a.text.length - b.text.length || b.i - a.i)[0]!;
    const oldest = c[c.length - 1]!;
    const refs = [shortest.ref, ...c.filter((l) => l !== shortest).map((l) => l.ref)].slice(0, MAX_REFS);
    out.push({
      sha: createHash('sha256').update(oldest.words.join(' ')).digest('hex').slice(0, 16),
      refs, days, shortest: shortest.text.replace(/\s+/g, ' ').trim().slice(0, TITLE_CHARS), lines: [...new Set(c.flatMap((l) => [l.text, l.raw]))],
    });
  }
  return out;
}

/** Words and path pieces of a line, lowercased, as `preferenceApplies` compares them. */
function tokens(text: string): string[] {
  const out: string[] = [];
  for (const raw of String(text ?? '').toLowerCase().split(/[\s,;:!?()"`]+/)) {
    const t = raw.replace(/'s$/, '').replace(/^['.]+|['.]+$/g, '');
    if (!t) continue;
    out.push(t);
    for (const piece of t.split(/[/\\]/)) if (piece && piece !== t) out.push(piece.replace(/^\.+|\.+$/g, ''));
  }
  return out.filter(Boolean);
}

/**
 * D102: programs every machine runs. Naming one ("use pnpm", "always git rebase") says nothing of this repo, so it
 * never makes a line "this repo", whichever source (a folder, a target, a session's command) put the word in.
 */
export const COMMON_PROGRAMS: ReadonlySet<string> = new Set([
  'git', 'gh', 'hub', 'npm', 'npx', 'pnpm', 'pnpx', 'yarn', 'bun', 'bunx', 'deno', 'node', 'nvm', 'volta', 'corepack', 'tsx', 'ts-node', 'tsc',
  'python', 'python3', 'pip', 'pip3', 'pipx', 'uv', 'uvx', 'poetry', 'pyenv', 'conda', 'pytest', 'ruff', 'black', 'mypy',
  'go', 'gofmt', 'cargo', 'rustc', 'rustup', 'make', 'cmake', 'ninja', 'bazel', 'docker', 'docker-compose', 'compose', 'podman', 'colima',
  'kubectl', 'helm', 'terraform', 'java', 'javac', 'mvn', 'gradle', 'ruby', 'gem', 'bundle', 'bundler', 'rake', 'rails', 'php', 'composer',
  'dotnet', 'swift', 'xcodebuild', 'brew', 'apt', 'apt-get', 'curl', 'wget', 'ssh', 'scp', 'rsync', 'jq', 'sed', 'awk', 'grep', 'rg', 'find',
  'ls', 'cat', 'echo', 'cd', 'rm', 'cp', 'mv', 'mkdir', 'chmod', 'sh', 'bash', 'zsh', 'fish', 'sudo', 'env', 'timeout', 'eslint', 'prettier',
  'jest', 'vitest', 'mocha', 'playwright', 'cypress', 'webpack', 'vite', 'esbuild', 'turbo', 'nx', 'lerna', 'aws', 'gcloud', 'az', 'vercel',
  'netlify', 'fly', 'flyctl', 'heroku', 'supabase', 'psql', 'mysql', 'sqlite3', 'redis-cli', 'code', 'vim', 'nvim', 'emacs', 'tmux', 'claude', 'trail',
]);

/** The line says it is about this repo in so many words ("here", "in this repo", "this project"). */
const HERE = /\b(?:here|in this (?:repo|repository|project|codebase|checkout)|this (?:repo|repository|project|codebase)(?:'s)?)\b/i;

/**
 * 'this repo' when the line names something specific to the repo (a script, path, branch, package or file name, or
 * the repo itself: "here"), else 'every repo' (spec 2, R50). A common program never counts, and a style preference
 * ("explain it simply") is always every repo (D102).
 */
export function preferenceApplies(text: string, repoWords: Set<string>): 'this repo' | 'every repo' {
  if (isStylePreference(text)) return 'every repo';
  const own = prefText(text);
  if (HERE.test(own)) return 'this repo';
  const named = (t: string) => !COMMON_PROGRAMS.has(t) && repoWords.has(t);
  return tokens(own).some((t) => named(t) || named(t.replace(/\.[a-z0-9]+$/, '')) || (t.includes('/') && t.length > 1 && !/^https?:/.test(t)))
    ? 'this repo' : 'every repo';
}

/**
 * The repo's own names (4.4 step 7): top-level files and folders, `package.json` name and scripts, Makefile
 * targets, branch names, and the script files its sessions ran; never a common program (D102). Lowercased. Reads
 * only; never throws.
 */
export function repoWordsOf(checkout: string, programs: Iterable<string> = []): Set<string> {
  const out = new Set<string>();
  const add = (w: unknown) => {
    if (typeof w !== 'string') return;
    const t = w.trim().toLowerCase();
    if (t.length >= 2 && t.length <= 80 && !COMMON_PROGRAMS.has(t)) out.add(t);
  };
  if (!checkout) return out;
  try {
    for (const name of readdirSync(checkout)) {
      if (name.startsWith('.')) continue;
      add(name);
      add(name.replace(/\.[a-z0-9]+$/i, ''));
    }
  } catch { /* no folder */ }
  try {
    // Never a link or a FIFO (a planted one would hang init), never a huge file (b5 review).
    const pkg = JSON.parse(readPlain(join(checkout, 'package.json'), REPO_FILE_MAX) ?? 'null') as { name?: unknown; scripts?: unknown };
    add(pkg.name);
    if (typeof pkg.name === 'string' && pkg.name.includes('/')) add(pkg.name.split('/').pop());
    if (pkg.scripts && typeof pkg.scripts === 'object') for (const k of Object.keys(pkg.scripts)) add(k);
  } catch { /* none */ }
  for (const file of ['Makefile', 'makefile', 'GNUmakefile']) {
    try {
      for (const m of (readPlain(join(checkout, file), REPO_FILE_MAX) ?? '').matchAll(/^([A-Za-z0-9][\w.-]*)\s*:(?!=)/gm)) add(m[1]);
    } catch { /* none */ }
  }
  const r = spawnSync('git', ['-C', checkout, 'for-each-ref', '--format=%(refname:short)', '--count=200', 'refs/heads'], { encoding: 'utf8', timeout: 5000, windowsHide: true });
  if (r.status === 0) for (const b of r.stdout.split('\n')) add(b);
  // A program the sessions ran names the repo only when it is a script file of its own (`seed.sh`), never a program
  // every machine has (D102).
  for (const p of programs) if (typeof p === 'string' && /^[\w.+-]+\.[a-z0-9]{1,5}$/i.test(p)) add(p);
  return out;
}
