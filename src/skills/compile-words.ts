/**
 * The words around a compiled skill, from templates, never from a model
 * (design 4.5 step 13, 2.1): its name, title, description, the asks that
 * bring it back, what it is not for; the "show me" print; and a refusal in
 * plain words.
 *
 * Pure: no files, no clock (dates come from the run sheet).
 */
import type { CheckHit, JobClass, RunCall, RunSheet } from '../trace/types.js';
import type { CompiledSkill, SkillStep } from './types.js';
import { bareCommand, programOf, simpleCommands, stripOutputFilters } from '../trace/shell.js';
import { callText, factsFromCalls } from '../trace/checks.js';
import { flatLine } from '../notes/flatten.js';
import { cleanLine } from '../trace/redact.js';
import { STABLE_BRANCHES } from './params.js';
import { gatedGroups } from './risk.js';
import { askText, JUDGEMENT_JOBS, matchJob } from '../trace/jobs.js';
import { SAVE_REQUEST } from '../trace/typed.js';

export type CompileRefusal =
  | 'no-steps' | 'too-long' | 'step-too-long' | 'multi-line' | 'never-save' | 'secret'
  | 'scratch-path' | 'outside-repo' | 'truncated' | 'no-check' | 'trivial' | 'helper-missing' | 'judgement' | 'answers-prompt';

/** At least one letter, so the digits of `trail skills keep 1 3` (init, 1b) can never be a name. */
export const NAME_RE = /^(?=[a-z0-9-]*[a-z])[a-z0-9][a-z0-9-]{1,47}$/;
/** Names Trail's own commands use. store.ts (g4) re-exports this list. */
export const BUILT_IN_NAMES: ReadonlySet<string> = new Set([
  'trail', 'graft', 'verify', 'run', 'init', 'review', 'skills', 'keep', 'forget', 'restore', 'add', 'show', 'draft', 'offers', 'help', 'on', 'off', 'promote', 'team', 'manual',
]);

/**
 * Claude Code's own slash commands and bundled skills. A kept skill is typed as `/<name>`, so it never takes one of
 * these: Claude Code refuses to load a custom `ship` or `steward` at all ("Not loaded: a custom /ship. Rename it,
 * then restart."), and a skill named like any of the others can't be told apart from the built-in when typed.
 * `run`, `init`, `review`, `skills` and `help` are already Trail's own words (BUILT_IN_NAMES).
 */
export const AGENT_COMMAND_NAMES: ReadonlySet<string> = new Set([
  'add-dir', 'agents', 'btw', 'bug', 'claude-api', 'clear', 'code-review', 'compact', 'config', 'context', 'cost', 'doctor',
  'effort', 'exit', 'export', 'fast', 'feedback', 'fewer-permission-prompts', 'hooks', 'ide', 'install-github-app',
  'keybindings-help', 'login', 'logout', 'loop', 'mcp', 'memory', 'model', 'output-style', 'permissions', 'plan', 'plugin',
  'plugin-authoring', 'pr-comments', 'privacy-settings', 'release-notes', 'resume', 'rewind', 'sandbox', 'schedule',
  'security-review', 'ship', 'simplify', 'status', 'statusline', 'steward', 'tasks', 'terminal-setup', 'theme', 'todos',
  'update-config', 'upgrade', 'usage', 'vim', 'workflow-authoring',
]);

/** Lesson and learning id shapes (`ls-` + 6 hex, `l-` + hex): `trail forget` reads them as ids first, so no skill takes one (D114 (2)). */
export const RESERVED_ID = /^(?:ls-[0-9a-f]{6}|l-[0-9a-f]{6,16})$/;

/** NAME_RE, not built in, not an id's shape, and a valid Agent Skills name (no `--`, no trailing `-`). */
export function goodName(name: string): boolean {
  return NAME_RE.test(name) && !/--|-$/.test(name) && !BUILT_IN_NAMES.has(name) && !RESERVED_ID.test(name);
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** 'Oct 27', in local time. */
export function monthDay(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? 'an earlier day' : `${MONTHS[d.getMonth()]} ${d.getDate()}`;
}
const hm = (d: Date) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;

const slug = (t: string) => t.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
export const repoName = (key: string) => key.split('/').filter(Boolean).pop() || 'this repo';
const cap = (w: string) => w.charAt(0).toUpperCase() + w.slice(1);
const joinWith = (items: string[], last: string) => (items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} ${last} ${items[items.length - 1]}`);

export interface JobWords { base: string; title: string; lead: string; asks: string[]; statusAsks: string[]; dontUse: string }

const REGISTRIES: Array<[RegExp, string, string]> = [
  [/\b(?:npm|pnpm|yarn(?:\s+npm)?)\s+publish\b/, 'npm', 'npm'],
  [/\btwine\s+upload\b/, 'pypi', 'PyPI'],
  [/\bcargo\s+publish\b/, 'crates', 'crates.io'],
  [/\bdocker\s+push\b/, 'docker', 'Docker'],
  [/\bgem\s+push\b/, 'gem', 'RubyGems'],
];

/** Remotes named for where a deploy goes: a push to one goes there, whatever branch it names (`git push prod HEAD:main`). */
const DEPLOY_REMOTES: ReadonlySet<string> = new Set(['prod', 'production', 'staging', 'live']);
/** The places a person names for a ship ("ship it to prod"), as the job's words have them. */
const SAID_PLACES = ['beta', 'staging', 'prod'];

/** The remote of one simple `git push`, when it is named for a deploy target; else null. */
function deployRemote(simple: string): string | null {
  const w = bareCommand(simple).split(/\s+/);
  if (w[0] !== 'git') return null;
  let i = 1;
  while (i < w.length && w[i] !== 'push') i += /^-[Cc]$|^--(?:git-dir|work-tree|namespace)$/.test(w[i]!) ? 2 : 1;
  for (i++; i < w.length; i++) {
    const a = w[i]!;
    if (a === '-o' || a === '--push-option' || a === '--repo') { i++; continue; }
    if (a.startsWith('-')) continue;
    const remote = a.replace(/^['"]|['"]$/g, '');
    return DEPLOY_REMOTES.has(remote) ? remote : null;
  }
  return null;
}

/** Stable branches pushed, in order, from the calls the steps came from (`push origin beta` then `beta:prod` too). */
const pushedStable = (calls: RunCall[]) => factsFromCalls(calls.filter((c) => !c.failed), {}).pushedBranches.filter((b) => STABLE_BRANCHES.has(b));

/**
 * Where the calls the steps came from shipped to, in order: a remote named for a deploy target (`git push prod
 * HEAD:main` goes to prod), else the stable branch pushed (`push origin beta` then `beta:prod` too).
 */
export function stableBranches(calls: RunCall[], jobWords: string[]): string[] {
  const out: string[] = [];
  for (const c of calls) {
    if (c.failed) continue;
    for (const simple of simpleCommands(stripOutputFilters(callText(c)))) {
      const remote = deployRemote(simple);
      for (const b of remote ? [remote] : pushedStable([{ ...c, cmd: simple, parts: undefined }])) if (!out.includes(b)) out.push(b);
    }
  }
  if (out.length) return out;
  return SAID_PLACES.filter((b) => jobWords.includes(b));
}

/**
 * Asks for the places a ship skill goes that its name leaves out: the branch a push to a deploy remote named
 * (`push to main`), and the places the person named when it was saved (`ship to prod`), so the asks it was saved
 * from bring it back.
 */
function otherPlaces(targets: string[], calls: RunCall[], jobWords: string[]): string[] {
  const same = (a: string, b: string) => a === b || ([a, b].every((x) => x === 'prod' || x === 'production'));
  const out: string[] = [];
  for (const b of pushedStable(calls)) if (!targets.some((t) => same(t, b))) out.push(`push to ${b}`);
  for (const p of SAID_PLACES) if (jobWords.includes(p) && !targets.some((t) => same(t, p))) out.push(`ship to ${p}`);
  return [...new Set(out)];
}

/** The program the null-job name and title come from: the first step that isn't a wait. */
function mainProgram(steps: SkillStep[]): string | null {
  const s = steps.find((x) => !x.wait) ?? steps[0];
  return s ? programOf(s.cmd) : null;
}

/**
 * The kind of tests the person asked for, in their own words ("run the integration tests"), from the job words their
 * asks matched; null when they said only "the tests". Never the runner's name: nobody asked for "pytest tests".
 */
function testsTag(jobWordsSaid: string[]): string | null {
  return ['integration', 'e2e'].find((w) => jobWordsSaid.includes(w)) ?? null;
}

/** 4.6's stop words, and words that say how to keep a skill or how the job went, not what the job is. */
const ASK_SKIP = new Set((
  "a an the to and then please can could would you we i it its this that now also just so okay ok yes lets let's do some me my our for of on in at "
  + 'first again too as well be is are will save saved keep kept make made turn remember skill skills step steps next time later thanks thank '
  + 'great nice cool awesome perfect good pls works worked working done everything every all repo repos team when need needs want how what way '
  + 'us your they them he she was were been has have had there here'
).split(' '));
const KEEP_CLAUSE = new RegExp(SAVE_REQUEST.source, 'gi');
const SCOPE_CLAUSE = /\b(?:for|in|on|across)\s+(?:every|all(?:\s+my)?|this|the|my|our|each)\s+(?:repos?|repositories|team|mac|machine|laptop|projects?)\b|\beverywhere\b|\balways\b/g;
const CLAUSE_BREAK = /[,.;:!?()[\]"{}\n]+|\s(?:and then|then|so that|so|because|since|but)\s/;

/**
 * D71 b: the asks of a run with no job class, from the person's own typed save request: its words minus the save
 * clause, scope words, values (a URL, a path, a version, a sha, a number) and filler, clause by clause, kept when a
 * clause leaves 2 to 5 words. At most 2. [] when the request says only how to keep it.
 */
export function askPhrases(typed: string | null | undefined): string[] {
  const t = askText(String(typed ?? '')).toLowerCase().replace(/[\u2018\u2019]/g, "'")
    .replace(KEEP_CLAUSE, ' , ').replace(SCOPE_CLAUSE, ' , ')
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/g, ' ')
    .replace(/\S*\w[./\\]\w\S*/g, ' ')
    .replace(/(?<![\w-])(?=[0-9a-f]*\d)[0-9a-f]{7,40}(?![\w-])/g, ' ')
    .replace(/(?<![\w-])#?\d[\w-]*/g, ' ');
  const out: string[] = [];
  for (const clause of t.split(CLAUSE_BREAK)) {
    const words = clause.split(/[^a-z0-9-]+/).filter((w) => w.length >= 2 && /^[a-z]/.test(w) && !ASK_SKIP.has(w));
    if (words.length < 2 || words.length > 5) continue;
    const phrase = words.join(' ');
    if (!out.includes(phrase)) out.push(phrase);
    if (out.length === 2) break;
  }
  return out;
}

/**
 * D99: the job class an asked save names the skill after when the run's typed asks gave none. First the person's
 * typed save request ("save this publish as a skill"), then the run's own commands: a step that publishes to a
 * registry, checked with `npm view` (or not checked at all), is a release; pushes to stable branches are a ship.
 * Null when neither says (the run keeps the first-step name). Judgement jobs never name a skill.
 */
export function askedJob(askedWith: string | null | undefined, steps: SkillStep[], calls: RunCall[], checkFamily: CheckHit['family'] | null): JobClass | null {
  const said = askedWith ? matchJob(String(askedWith).replace(KEEP_CLAUSE, ' , '))?.job ?? null : null;
  if (said !== null && !JUDGEMENT_JOBS.has(said)) return said;
  const text = steps.map((s) => s.cmd).join('\n');
  if (REGISTRIES.some(([re]) => re.test(text)) && (checkFamily === 'npm-view' || checkFamily === null)) return 'release';
  if (stableBranches(calls, []).length) return 'ship';
  return null;
}

/** 4.5 step 13's table. `asked`: a job-less run's asks (D71 b), from `askPhrases`; never the run's own words. */
export function jobWords(sheet: RunSheet, steps: SkillStep[], extra: { calls?: RunCall[]; helperText?: string; main?: string; asked?: string[] } = {}): JobWords {
  const repo = repoName(sheet.repoKey);
  const other = 'Jobs other than this one.';
  const job: JobClass | null = sheet.job;
  if (job === 'release') {
    const text = `${steps.map((s) => s.cmd).join('\n')}\n${extra.helperText ?? ''}`;
    const reg = REGISTRIES.find(([re]) => re.test(text));
    const asks = ['publish', 'release', 'bump', 'redo the publish'];
    if (!reg) return { base: 'release', title: `Release ${repo}`, lead: `Releases ${repo}`, asks, statusAsks: ['is it published', 'did it publish'], dontUse: 'Pre-releases, or packages other than the ones above.' };
    return { base: `release-${reg[1]}`, title: `Release ${repo} to ${reg[2]}`, lead: `Publishes ${repo} to ${reg[2]}`, asks: [...asks, `ship to ${reg[1]}`], statusAsks: ['is it published', 'did it publish'], dontUse: 'Pre-releases, or packages other than the ones above.' };
  }
  if (job === 'ship') {
    const calls = extra.calls ?? steps.map((s, i) => ({ id: `s${i}`, cmd: s.cmd, failed: false }) as RunCall);
    const b = stableBranches(calls, sheet.jobWords);
    const also = otherPlaces(b, calls, sheet.jobWords);
    const dontUse = 'Pushes to other branches, or other repos.';
    if (b.length >= 2) {
      const [b1, b2] = [b[0]!, b[b.length - 1]!];
      return {
        base: `ship-${b1}-then-${b2}`, title: `Ship ${repo}: ${b1}, then ${b2}`, lead: `Ships ${repo} to ${b1}, then fast-forwards ${b2}`,
        asks: [`push to ${b1}`, `ff to ${b2}`, `fast-forward ${b2}`, `promote to ${b2}`, `deploy to ${b2}`, `update ${b2}`, ...also, 'ship it'],
        statusAsks: ['is it live', `is ${b2} updated`, 'did it deploy'], dontUse,
      };
    }
    if (b.length === 1) {
      const one = b[0]!;
      return { base: `ship-${one}`, title: `Ship ${repo} to ${one}`, lead: `Ships ${repo} to ${one}`, asks: [`push to ${one}`, `deploy to ${one}`, `update ${one}`, ...also, 'ship it'], statusAsks: ['is it live', `is ${one} updated`, 'did it deploy'], dontUse };
    }
    return { base: 'ship', title: `Ship ${repo}`, lead: `Ships ${repo}`, asks: ['ship it', 'deploy it'], statusAsks: ['is it live', 'did it deploy'], dontUse };
  }
  if (job === 'tests') {
    const tag = testsTag(sheet.jobWords);
    if (!tag) return { base: 'run-tests', title: `Run ${repo}'s tests`, lead: `Runs ${repo}'s tests`, asks: ['run the tests'], statusAsks: ['did the tests pass'], dontUse: 'Other test suites.' };
    return { base: `${tag}-tests`, title: `Run ${repo}'s ${tag} tests`, lead: `Runs ${repo}'s ${tag} tests`, asks: [`${tag} tests`, `run the ${tag} tests`], statusAsks: ['did the tests pass'], dontUse: 'Other test suites.' };
  }
  if (job === 'report') {
    const w = sheet.jobWords.filter((x) => x !== 'report').slice(0, 2);
    const dontUse = 'Other numbers or other tables.';
    if (w.length === 2) {
      const [w1, w2] = w as [string, string];
      return { base: `${w1}-${w2}-report`, title: `${cap(w1)} ${w2} report for ${repo}`, lead: `Reads the ${w1} ${w2} numbers for ${repo}`, asks: [`any ${w1} ${w2}`, `${w1} ${w2}`, `how many ${w2}`], statusAsks: [], dontUse };
    }
    if (w.length === 1) return { base: `${w[0]}-report`, title: `${cap(w[0]!)} report for ${repo}`, lead: `Reads the ${w[0]} numbers for ${repo}`, asks: [w[0]!], statusAsks: [], dontUse };
    return { base: 'report', title: `Report for ${repo}`, lead: `Reads the numbers for ${repo}`, asks: ['report'], statusAsks: [], dontUse };
  }
  if (job === 'run-local') return { base: 'run-locally', title: `Run ${repo} locally`, lead: `Starts ${repo} locally`, asks: ['open it locally', 'run it locally', 'localhost'], statusAsks: [], dontUse: other };
  // A check that is a step (tests, a query, a push) is what the run was for: it names the skill.
  const prog = (extra.main !== undefined ? programOf(extra.main) : null) ?? mainProgram(steps) ?? 'these commands';
  // D71 b: a common word of the run ("done", "test", the repo's name) as an ask fired on unrelated prompts.
  return { base: slug(prog) || 'steps', title: `Run ${prog} in ${repo}`, lead: `Runs ${prog} in ${repo}`, asks: extra.asked ?? [], statusAsks: [], dontUse: other };
}

/** The base name, then -<repo>, then -2, -3 ...: the first that is a good name, not an agent's command, and free. */
export function freeName(base: string, repoKey: string, taken: (n: string) => boolean): string {
  const fit = (n: string) => n.slice(0, 48).replace(/-+$/, '');
  const b = goodName(fit(base)) ? fit(base) : fit(`run-${base}`);
  const tries = [b, fit(`${b}-${slug(repoName(repoKey))}`)];
  for (let n = 2; n < 100; n++) tries.push(`${b.slice(0, 44).replace(/-+$/, '')}-${n}`);
  return tries.find((n) => goodName(n) && !AGENT_COMMAND_NAMES.has(n) && !taken(n)) ?? `${b.slice(0, 40)}-${repoKey.length}`;
}

export function proposeName(sheet: RunSheet, steps: SkillStep[], taken: (n: string) => boolean): string {
  return freeName(jobWords(sheet, steps).base, sheet.repoKey, taken);
}

/** Words an ask starts with when it is something to do: "asked to run the tests", "asked to publish". */
const ASK_VERBS = new Set(['run', 'rerun', 'push', 'ff', 'fast-forward', 'promote', 'deploy', 'update', 'ship', 'publish', 'release', 'bump', 'redo',
  'open', 'start', 'restart', 'stop', 'build', 'rebuild', 'test', 'check', 'fix', 'merge', 'rebase', 'lint', 'format', 'generate', 'regenerate',
  'install', 'upgrade', 'clean', 'reset', 'sync', 'pull', 'fetch', 'commit', 'tag', 'create', 'make', 'add', 'remove', 'delete', 'migrate', 'seed',
  'serve', 'compile', 'pack', 'upload', 'download', 'review', 'refresh', 'roll', 'revert', 'cut', 'prepare', 'verify', 'show', 'list', 'count',
  'get', 'find', 'read', 'send', 'do', 'try', 'tidy', 'trim', 'backup', 'restore', 'export', 'import', 'reindex', 'index', 'measure', 'profile']);
const ASK_QUESTION = /^(?:how|what|which|who|when|where|why|is|are|was|were|did|does|can)\b/i;

/** How one ask follows "asked" or "you ask": `to` a verb, a question bare, `about` a gerund, `for` anything else. */
function askLead(ask: string): 'to' | 'about' | 'for' | '' {
  const first = ask.trim().split(/\s+/)[0]?.toLowerCase() ?? '';
  if (ASK_QUESTION.test(first)) return '';
  if (/^\S+ tests$/i.test(ask.trim())) return 'for';
  if (ASK_VERBS.has(first)) return 'to';
  return /\w{3,}ing$/.test(first) ? 'about' : 'for';
}

/**
 * fix-lab5: the asks as words after "asked" (or "you ask"), each the way it reads: "to publish, release or bump",
 * "for integration tests, or to run the integration tests", "about regenerating the api client", "how many users".
 * Asks next to each other that take the same word share it.
 */
export function askedWords(asks: string[]): string {
  const groups: Array<{ lead: string; items: string[] }> = [];
  for (const a of asks) {
    const lead = askLead(a);
    const last = groups[groups.length - 1];
    if (last && last.lead === lead && lead !== '') last.items.push(a);
    else groups.push({ lead, items: [a] });
  }
  const parts = groups.map((g) => `${g.lead ? `${g.lead} ` : ''}${joinWith(g.items, 'or')}`);
  return parts.length < 2 ? parts.join('') : `${parts.slice(0, -1).join(', ')}, or ${parts[parts.length - 1]}`;
}

/** "<lead>, from the steps that worked on <Mon D>. Use when asked to <a, b or c>.", at most 300 characters. */
export function describe(lead: string, endedAt: string, asks: string[]): string {
  if (!asks.length) return flatLine(`${lead}, from the steps that worked on ${monthDay(endedAt)}.`, 300);
  const make = (a: string[]) => flatLine(`${lead}, from the steps that worked on ${monthDay(endedAt)}. Use when asked ${askedWords(a)}.`, 1000);
  for (let n = asks.length; n >= 1; n--) {
    const d = make(asks.slice(0, n));
    if (d.length <= 300) return d;
  }
  return flatLine(make(asks.slice(0, 1)), 300);
}

const split = (s: string | undefined) => (s ? s.split(' ; ').map((x) => x.trim()).filter(Boolean) : []);

function probeWords(p: string): string {
  let m: RegExpExecArray | null;
  if (p === 'git status --porcelain') return 'no uncommitted changes (git status --porcelain)';
  if ((m = /^git rev-parse --abbrev-ref HEAD = (\S+)$/.exec(p))) return `on ${m[1]} (git rev-parse --abbrev-ref HEAD)`;
  if ((m = /^command -v (\S+)$/.exec(p))) return `${m[1]} is installed (${p})`;
  if ((m = /^(?:test -\w|\[ -S) (\S+)/.exec(p))) return `${m[1]} is there (${p})`;
  if ((m = /^git rev-parse --verify (\S+)$/.exec(p))) return `${m[1]} exists (${p})`;
  return p;
}

const WAIT_TOKEN = /^s=\$SECONDS; until \[ "\$\((.*)\)" = "([^"]*)" \]; do /;
const WAIT_ANY = /^s=\$SECONDS; (until|while) (.*) >\/dev\/null 2>&1; do /;

function stepWords(s: SkillStep): string {
  if (s.wait) {
    const t = WAIT_TOKEN.exec(s.cmd);
    if (t) return `wait up to 5 min until ${t[1]} shows ${t[2]}`;
    const a = WAIT_ANY.exec(s.cmd);
    if (a) return a[1] === 'until' ? `wait up to 5 min until ${a[2]} works` : `wait up to 5 min while ${a[2]} still works`;
  }
  return s.bg ? `${s.cmd} (in the background)` : s.cmd;
}

const LEFT: Array<[keyof CompiledSkill['leftOut'], (n: number) => string]> = [
  ['failed', (n) => `${n} that failed`],
  ['lookOnly', (n) => `${n} that only looked around`],
  ['duplicates', (n) => `${n} ${n === 1 ? 'repeat' : 'repeats'}`],
  ['plumbing', (n) => `${n} that only set up the shell`],
  ['work', (n) => `${n} that changed files`],
];

/** D58 b: a left-out step as the draft shows it (`clean`: compile's step cleaning and paths), and where it ran. */
export function elsewhereLines(calls: RunCall[], repoKey: string, clean: (cmd: string) => string): Array<{ cmd: string; where: string }> {
  const out: Array<{ cmd: string; where: string }> = [];
  for (const c of calls) {
    const text = c.cmd === null ? null : cleanLine(clean(c.cmd), 100);
    const cmd = text ?? (c.truncated ? 'a command too long to show' : "a command Trail can't show (it held a secret)");
    const where = c.key === null ? 'outside any repo' : c.key !== repoKey ? `in ${repoName(c.key)}` : "in a folder Trail couldn't follow";
    if (!out.some((x) => x.cmd === cmd && x.where === where)) out.push({ cmd, where });
  }
  return out;
}

/** D59a: a joined sheet's compactions, its first start, and the steps whose every run came before the last compaction. */
export function carriedSteps(sheet: RunSheet, steps: SkillStep[]): NonNullable<CompiledSkill['carried']> {
  const n = (sheet.joined ?? []).reduce((a, p) => a + p.calls, 0);
  const before = new Set(sheet.calls.slice(0, n).map((c) => c.id));
  return { compactions: sheet.joined?.length ?? 0, startedAt: sheet.startedAt, steps: steps.filter((s) => s.from?.length && s.from.every((id) => before.has(id))).map((s) => s.n) };
}

/** "step 2", "steps 1 and 2", "steps 1, 2 and 3". */
const stepList = (ns: number[]) => `${ns.length === 1 ? 'step' : 'steps'} ${joinWith(ns.map(String), 'and')}`;

/** D59a: the draft line for a job a compaction cut, and which steps ran before the (last) compaction. */
function carriedWords(k: NonNullable<CompiledSkill['carried']>): string {
  const across = k.compactions === 1 ? 'a compaction' : `${k.compactions} compactions`;
  const before = k.compactions === 1 ? 'before it' : 'before the last one';
  return `  compaction  the job ran across ${across}: ${k.steps.length ? `${stepList(k.steps)} ran ${before}, the rest after` : `every step ran after ${k.compactions === 1 ? 'it' : 'the last one'}`}`;
}

/**
 * D59b: a check read with a deploy status tool, not a command: what to read, the same way the run did.
 * The deployment is named by the commit param when one holds its commit, else by its branch, else as the new commit.
 */
export function toolCheckWords(tool: string, facts: CheckHit['facts'], params: CompiledSkill['params']): string {
  const [, server = '', name = tool] = /^mcp__(.+)__([^_].*)$/.exec(tool) ?? [];
  const provider = /vercel/i.test(server) ? 'Vercel' : flatLine(server, 40) || 'the deploy';
  const sha = facts.sha;
  const commit = sha ? params.find((p) => p.shape === 'sha' && p.seen.some((v) => v.length >= 7 && (sha.startsWith(v) || v.startsWith(sha)))) : undefined;
  const branch = facts.branch ? params.find((p) => p.seen.includes(facts.branch!)) : undefined;
  const target = commit ? `{${commit.name}}` : facts.branch ? `the newest commit on ${branch ? `{${branch.name}}` : facts.branch}` : 'the new commit';
  return `read the ${provider} deployment for ${target} with ${name}`;
}

/** The "show me" text (2.1). */
export function draftText(c: CompiledSkill, sheet: RunSheet): string {
  const from = c.carried?.startedAt ?? sheet.startedAt;
  const start = new Date(from);
  const end = new Date(sheet.endedAt);
  const sameDay = monthDay(from) === monthDay(sheet.endedAt);
  const when = `${monthDay(from)}, ${hm(start)} to ${sameDay ? '' : `${monthDay(sheet.endedAt)}, `}${hm(end)}`;
  const out = [`${c.name} · copied from the run that just ${sheet.checked ? 'worked' : 'ran'} (${when})`];
  if (c.carried) out.push(carriedWords(c.carried));
  for (const x of split(c.meta['check-first'])) out.push(`  check first  ${x}`);
  for (const x of split(c.meta.ready)) out.push(`  ready        ${probeWords(x)}`);
  const groups = gatedGroups(c.steps);
  for (const s of c.steps) {
    const g = groups.find((x) => x.steps[0] === s.n);
    if (g) out.push(`  ■  can't be undone: Claude Code asks you once, right before step ${s.n}${g.steps.length > 1 ? ` (it covers ${joinWith(g.steps.map(String), 'and')})` : ''}`);
    out.push(`  ${s.n}  ${stepWords(s)}`);
  }
  if (!c.check) out.push('  check  none: no check ran in the run this came from');
  else if (c.checkIsStep) out.push(`  check  step ${[...c.steps].reverse().find((s) => s.cmd === c.check)?.n ?? c.steps.length} passing is the check`);
  else if (c.meta['check-tool']) out.push(`  check  ${c.check}: it should show ${c.checkShows ?? 'READY'}`);
  else out.push(`  check  ${c.check} ${c.checkShows ? `shows ${c.checkShows}` : 'works'}`);
  for (const h of c.helpers) out.push(`  helper  ${h.file}, copied into the skill from a temporary folder`);
  for (const p of c.params) {
    const seen = p.seen[0] ? `; it was ${p.seen[0]} this time` : '';
    if (p.default?.startsWith('$(')) out.push(`  {${p.name}}  from what you type, or ${p.default.slice(2, -1)}${seen}`);
    else if (p.default !== undefined) out.push(`  {${p.name}}  from what you type, or ${p.default} as last time`);
    else out.push(`  {${p.name}}  from what you type${seen}`);
  }
  const away = c.elsewhere ?? [];
  const total = Object.values(c.leftOut).reduce((a, b) => a + b, 0) + away.length;
  const parts = LEFT.filter(([k]) => c.leftOut[k]).map(([k, f]) => f(c.leftOut[k]));
  if (away.length) parts.push(`${away.length} that ran outside this repo`);
  if (total) out.push(`  left out  ${total} ${total === 1 ? 'command' : 'commands'}: ${parts.join(', ')}`);
  // D58 b: what ran elsewhere, so the person sees it before saying yes.
  for (const e of away.slice(0, 6)) out.push(`  elsewhere  ${e.cmd} (${e.where})`);
  if (away.length > 6) out.push(`  elsewhere  and ${away.length - 6} more`);
  // Part 7: steps that follow the person's learnings rather than the run.
  if (c.followed) out.push(`  learnings  ${flatLine(c.followed, 400)}`);
  out.push(`  just for you, ${c.meta.applies === 'every repo' ? 'in every repo' : 'in this repo'} · nothing is shared or uploaded`);
  return out.join('\n');
}

/** A refusal in plain words: "a step reads a credential file: `TOKEN=$(python3 -c …auth.json…)`". */
export function refusalWords(reason: CompileRefusal, detail: string): string {
  const d = flatLine(detail, 120);
  switch (reason) {
    case 'judgement':
      return d === 'sweep'
        ? "going through PRs takes judgement each time, so Trail doesn't keep it as fixed steps"
        : "getting checks green takes judgement each time, so Trail doesn't keep it as fixed steps";
    case 'no-steps': return d === 'report'
      ? 'the numbers came from a script written inline, not from a command Trail can keep'
      : 'no command in the run did the job itself: they only looked around, set up the shell or changed files';
    case 'too-long': return d === 'overflow' ? 'the run had more commands than Trail keeps for one job' : `the job takes ${d || 'more than 12'} steps, and a skill holds at most 12`;
    case 'step-too-long': return `a step is longer than 300 characters: \`${d}\``;
    case 'multi-line': return /^(?:uses|needs|runs) [^`]*: `/.test(d) ? `a step ${d}` : `a step runs over several lines (a heredoc or an inline script): \`${d}\``;
    case 'never-save': return d.startsWith('bug: ') ? `the skill file came out wrong (${d.slice(5)})` : `a step ${d}`;
    case 'secret': return "a step holds a secret Trail can't turn into a variable name";
    case 'scratch-path': return `a step uses a temporary file: \`${d}\``;
    case 'outside-repo': return `a step ran outside this repo: \`${d}\``;
    case 'truncated': return 'a step is over 2,000 characters';
    case 'no-check': return d === 'version'
      ? "the check reads a version, but no step names or makes the version it should show, so it can't tell this release from the last one"
      : 'nothing in the run checked that the job worked';
    case 'trivial': return `every step is already a script in the repo (\`${d}\`), so there is nothing worked out to keep`;
    case 'helper-missing': return `a step runs a temporary script that is gone now: \`${d}\``;
    case 'answers-prompt': return `a step answers a login or confirmation prompt for the person: \`${d}\``;
  }
}

/** D56a: what a push check shows, its branch as the param that holds it. */
export function pushShows(branch: string | undefined, params: CompiledSkill['params']): string {
  const p = branch ? params.find((x) => x.seen.includes(branch)) : undefined;
  const dst = p ? `{${p.name}}` : branch;
  return dst ? `${dst} moved: git prints old..new -> ${dst}, not "Everything up-to-date"` : 'the branch moved: git prints old..new, not "Everything up-to-date"';
}
