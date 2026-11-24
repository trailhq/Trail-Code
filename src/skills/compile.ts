/**
 * Compile: from a run sheet to a skill (design 4.5, spec 10's copy rules).
 *
 * Deterministic and model-free: the same sheet, prior sheet and options give
 * the same file. Every step is a command that ran and worked in the run,
 * copied, then cleaned the same way every time: output filters, trailing
 * echoes, a leading sleep and (on macOS) `timeout` dropped; its folder named
 * as `(cd sub && ...)`; repo paths relative and home paths `$HOME`; a poll
 * folded into one wait loop of at most 5 minutes; values that change become
 * {params}. A step Trail can't keep safely (a secret it can't name, a scratch
 * path, sudo, a credential file, more than one line ...) refuses the whole
 * skill, with the reason in plain words: a skill missing a step is worse than
 * no skill.
 *
 * Reads only the helper scripts a run executed from scratch folders (4.5
 * step 7), to copy them in, and the earlier parts of a run a compaction cut
 * (D59a, `joinCarriedSheet`). Writes nothing: the store saves.
 */
import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { basename, extname } from 'node:path';
import type { CheckFamily, GatedKind, RunCall, RunSheet } from '../trace/types.js';
import type { CompiledSkill, SkillMeta, SkillStep } from './types.js';
import { bareCommand, leadingCds, normalizeCommand, programOf, relativizePaths, simpleCommands, stripLeadingSleep, stripOutputFilters, stripTimeout, stripTrailingEcho } from '../trace/shell.js';
import { callText, checkFamilyOf, fallbackOnly } from '../trace/checks.js';
import { JUDGEMENT_JOBS } from '../trace/jobs.js';
import { essentialSteps } from '../trace/run-verdict.js';
import { joinCarriedSheet } from '../trace/run-join.js';
import { cleanLine } from '../trace/redact.js';
import { secretReason } from '../notes/secrets.js';
import { MAX_RUN_LINES, MAX_STEP_CHARS, gatedKind } from './risk.js';
import { literalPassword, neverSave } from './never-save.js';
import { STABLE_BRANCHES, findParams, paramsToMeta } from './params.js';
import { renderSkillMd } from './skillmd.js';
import { skillProblems } from './validate.js';
import { AGENT_COMMAND_NAMES, type CompileRefusal, askPhrases, askedJob, carriedSteps, describe, elsewhereLines, freeName, goodName, jobWords, toolCheckWords } from './compile-words.js';
import { type LoopWait, WIN_TEMP, splitSheet, stripScratchLog } from './compile-split.js';
import { answersPrompt, loginFeed } from './answers-prompt.js';
import { checkShowsFor, shownVersion, versionShaped, versionTie } from './compile-version.js';
import { findWaits } from './compile-waits.js';
import { followAtSave, type StepLearning } from './follow-learnings.js';

export { AGENT_COMMAND_NAMES, BUILT_IN_NAMES, NAME_RE, askPhrases, draftText, proposeName, refusalWords, type CompileRefusal } from './compile-words.js';

export type CompileResult =
  | { ok: true; skill: CompiledSkill }
  | { ok: false; reason: CompileRefusal; detail: string };

export interface CompileOpts {
  repoRoot: string;
  home: string;                 // os.homedir()
  platform: NodeJS.Platform;
  prior?: RunSheet | null;      // findPriorSheet(sheet): the previous checked run of the same job (varied params)
  name?: string;                // agent-given name; validated
  moment: 'asked' | 'repeated';
  applies: string;              // repo key or 'every repo'
  /** nameTaken from store.ts, passed in so compile doesn't import the store. */
  taken: (name: string) => boolean;
  now?: Date;
  /** The skill's `metadata.trail` id. Default: 's-' + 6 hex from the run id and the name, so compile stays deterministic. */
  id?: string;
  /** Reads the earlier parts of a carried sheet and prior (D59a). Default: `readRunSheet` in the Trail home. */
  readSheet?: (id: string) => RunSheet | null;
  /**
   * D71 b: the person's own typed save request (4.4), for an asked save. A run with no job class takes its asks from
   * it (`askPhrases`: phrases of 2+ words) and from nothing else. Read, never stored beyond those asks.
   */
  askedWith?: string | null;
  /**
   * Part 7: the person's live preferences, decisions and guardrails about commands (`stepLearnings`). A step one of
   * them goes against is written its way when that is safe, else left out, and `followed` says so. Every half of a
   * save passes the same ones, read from disk, so they compile the same skill. Absent: none.
   */
  learnings?: readonly StepLearning[];
}

class Refused extends Error {
  constructor(readonly reason: CompileRefusal, readonly detail: string) { super(reason); }
}
const refuse = (reason: CompileRefusal, detail = ''): never => { throw new Refused(reason, detail); };
const excerpt = (t: string | null | undefined, max = 80) => cleanLine(String(t ?? '').split('\n')[0]!, max) ?? 'a command';

/** Where the skill's own folder goes in a copied helper's path, until the name is known. */
const SKILL_DIR = '\u0000skill\u0000';
const HELPER_MAX_BYTES = 16 * 1024;
const HELPER_MAX_LINES = 200;
const WAIT_TAIL = 'do [ $((SECONDS-s)) -ge 300 ] && echo "not ready after 5 min" && break; sleep 10; done';
const PROBE = /^(?:command -v [\w.+-]+|test -[SfdeE] \S+|\[ -S \S+ \]|git rev-parse --verify \S+)$/;
const PORCELAIN = 'git status --porcelain';
const CHECK_FIRST = /^(?:npm whoami|gh auth status|aws sts get-caller-identity|gcloud auth list|vercel whoami|docker info|colima status)(?:\s+-{1,2}[\w-]+(?:[= ]\S+)?)*$/;
/** A token that is a scratch path: /tmp, /private/tmp, /var/folders, $TMPDIR, a scratchpad segment, or Windows' temp folder. */
const SCRATCH = new RegExp(String.raw`(?<![\w.~$-])(?:\/private)?\/(?:tmp|var\/folders)\/[^\s'"\`;|&()<>,]*|\$\{?TMPDIR\}?[^\s'"\`;|&()<>,]*|[^\s'"\`;|&()<>,=]*[\\/]scratchpad[\\/][^\s'"\`;|&()<>,]*|${WIN_TEMP}[^\s'"\`;|&()<>,]*`, 'g');
const PLAIN = /^(?:npm (?:run )?[\w:.-]+|pnpm (?:run )?[\w:.-]+|yarn (?:run )?[\w:.-]+|make [\w.-]+|go test \.\/\.\.\.)$/;

type Role = 'step' | 'wait' | 'poll' | 'check' | 'probe' | 'checkFirst' | 'failed' | 'left';

interface Item {
  i: number;                    // index of the call it was copied from (the last one, for a wait or merged repeats)
  call: RunCall;
  core: string;                 // the command, cleaned, without its folder
  text: string;                 // what goes in the skill, before params
  bg: boolean;
  wait: boolean;
  from: string[];
  gated: GatedKind | null;
  isCheck: boolean;
}

/** 4.5 step 8, plus leading cds gone (the folder is the call's cwd). */
function cleanText(cmd: string, platform: NodeJS.Platform): string {
  let s = cmd.replace(/\\\r?\n[ \t]*/g, ' ').trim();
  s = leadingCds(s).rest || s;
  for (let n = 0; n < 10; n++) {
    let next = stripTrailingEcho(stripOutputFilters(stripScratchLog(s)));
    next = stripLeadingSleep(next);
    if (platform === 'darwin') next = stripTimeout(next);
    if (next === s) break;
    s = next;
  }
  return s;
}

const quoteDir = (cwd: string) => (/^[\w./@+-]+$/.test(cwd) ? cwd : `'${cwd.replace(/'/g, `'\\''`)}'`);
const inFolder = (cwd: string, cmd: string) => (cwd ? `(cd ${quoteDir(cwd)} && ${cmd})` : cmd);

interface Plan {
  roles: Role[];
  waits: Map<number, { token: string | null; polls: number[]; whileOk?: true; loop?: true }>;
  probes: Array<{ i: number; text: string }>;
  checkFirst: Array<{ i: number; text: string }>;
}

function planCalls(sheet: RunSheet, ci: number | null, checkIsStep: boolean, platform: NodeJS.Platform, loops: Map<RunCall, LoopWait>): Plan {
  const calls = sheet.calls;
  const roles: Role[] = calls.map(() => 'left');
  const waits: Plan['waits'] = findWaits(calls, ci, sheet.job);
  for (const [L, w] of waits) {
    for (const e of w.polls) roles[e] = 'poll';
    if (L !== ci) roles[L] = 'wait';
  }
  // D58 d: a polling loop that worked is a wait on the command it polled.
  calls.forEach((c, i) => {
    const w = loops.get(c);
    if (!w || i === ci || roles[i] === 'poll' || c.failed) return;
    roles[i] = 'wait';
    waits.set(i, { token: w.token, polls: [], ...(w.whileOk ? { whileOk: true as const } : {}), loop: true });
  });
  const probes: Plan['probes'] = [];
  const checkFirst: Plan['checkFirst'] = [];
  calls.forEach((c, i) => {
    if (roles[i] !== 'left') return;
    if (i === ci) { roles[i] = checkIsStep ? 'step' : 'check'; return; }
    if (c.failed) { roles[i] = 'failed'; return; }
    const text = c.cmd === null ? '' : cleanText(c.cmd, platform);
    if ((text === PORCELAIN || PROBE.test(text)) && !(c.cwd === null && text.startsWith('git '))) { roles[i] = 'probe'; probes.push({ i, text }); return; }
    if (CHECK_FIRST.test(text)) { roles[i] = 'checkFirst'; checkFirst.push({ i, text }); return; }
    if (c.kind === 'step') roles[i] = 'step';
  });
  return { roles, waits, probes, checkFirst };
}

/** Is `path` the script this command executes (`bash|sh|zsh|node|python3? <path>` or `<path>` alone)? */
function executes(text: string, path: string): boolean {
  const un = (w: string) => w.replace(/^(['"])(.*)\1$/, '$2');
  return simpleCommands(text).some((simple) => {
    const w = bareCommand(simple).split(/\s+/).map(un);
    if (w[0] === path) return true;
    if (!/^(?:(?:ba|z|da)?sh|node|python3?|bun|deno)$/.test(basename(w[0] ?? ''))) return false;
    return w.slice(1).find((a) => !a.startsWith('-')) === path;
  });
}

interface Helper { file: string; from: string; content: string }

/** 4.5 step 7: scratch paths; a helper script that ran is copied in, anything else refuses. Then repo and home paths. */
function paths(text: string, sheet: RunSheet, opts: CompileOpts, helpers: Helper[], strict: boolean): { text: string; gated: GatedKind | null } {
  let gated: GatedKind | null = null;
  const out = text.replace(SCRATCH, (p) => {
    if (!executes(text, p) || !sheet.helpers.includes(p)) return strict ? refuse('scratch-path', p) : p;
    let content: string;
    try {
      if (!statSync(p).isFile()) throw new Error('not a file');
      content = readFileSync(p, 'utf8');
    } catch {
      return strict ? refuse('helper-missing', p) : p;
    }
    const lines = content.replace(/\n$/, '').split('\n');
    // Read whole too, its `\`-continued lines joined: `curl … \` then `| sh` is one command.
    const whole = content.replace(/\\\r?\n/g, ' ');
    if (Buffer.byteLength(content) > HELPER_MAX_BYTES || lines.length > HELPER_MAX_LINES || secretReason(content) !== null
      || literalPassword(whole) || neverSave(whole) !== null || lines.some((l) => neverSave(l) !== null)) {
      return strict ? refuse('scratch-path', `${p} (too big, or unsafe to copy)`) : p;
    }
    gated ??= lines.map((l) => gatedKind(l)).find((k) => k !== null) ?? gatedKind(whole);
    let file = basename(p);
    const clash = helpers.find((h) => h.file === file && h.from !== p);
    if (clash) file = `${basename(p, extname(p))}-${helpers.length + 1}${extname(p)}`;
    if (!helpers.some((h) => h.from === p)) helpers.push({ file, from: p, content });
    return `$HOME/.trail/skills/${SKILL_DIR}/scripts/${helpers.find((h) => h.from === p)!.file}`;
  });
  return { text: relativizePaths(out, opts.repoRoot, opts.home), gated };
}

/**
 * Steps 2 and 4 to 9 for one sheet, its multi-line calls read line by line (compile-split.ts).
 * strict: refuse; not strict (a prior run, for varied params): skip what can't be kept.
 */
function keptSteps(input: RunSheet, opts: CompileOpts, strict: boolean) {
  // D58 a/b: the steps the run verdict reads (run-verdict.ts `essentialSteps`) are the only ones that can be
  // in the skill; a call in another checkout (its own key) ran elsewhere, like one outside any repo.
  const essential = new Set(essentialSteps(input.calls, input.repoKey));
  const away = (c: RunCall) => c.cwd !== null && (c.key !== input.repoKey || (c.kind === 'step' && !essential.has(c)));
  const placed = { ...input, calls: input.calls.map((c) => (away(c) ? { ...c, cwd: null } : c)) };
  const { sheet, blocked, waits: loops, parts } = splitSheet(placed, opts);
  const calls = sheet.calls;
  // D101: a call that may pass only through its `|| echo` / `|| true` fallback is never taken as the check.
  const ci = sheet.checkIndex !== null && sheet.checkIndex >= 0 && sheet.checkIndex < calls.length && !fallbackOnly(callText(calls[sheet.checkIndex]!)) ? sheet.checkIndex : null;
  const checkCall = ci === null ? null : calls[ci]!;
  const checkFam: CheckFamily | null = checkCall ? (checkCall.check?.family ?? (checkCall.cmd ? checkFamilyOf(checkCall.cmd, sheet.job) : null)) : null;
  // A push that moved the branch (D56a) is a step that doubles as the check, like tests and queries.
  const checkIsStep = checkFam === 'tests' || checkFam === 'query' || checkFam === 'push';
  const plan = planCalls(sheet, ci, checkIsStep, opts.platform, loops);
  const helpers: Helper[] = [];
  const guard = <T>(fn: () => T): T | null => {
    if (strict) return fn();
    try { return fn(); } catch (e) { if (e instanceof Refused) return null; throw e; }
  };

  // Step 2: what each kept call is. D58 b: a step that ran outside the repo is left out (and listed), not refused.
  const raw = plan.roles.flatMap((r, i) => (r === 'step' || r === 'wait' ? [i] : []));
  const elsewhere: RunCall[] = [];
  const logins: Array<{ service: string; login: string }> = [];
  const usable = (i: number) => guard(() => {
    const c = calls[i]!;
    if (c.cwd === null && i !== ci) { elsewhere.push(c); return false; }
    // A long call from before its pieces were kept; a long call whose piece held a secret Trail couldn't name (D58 c).
    if (c.truncated && !c.parts) refuse('truncated', excerpt(c.cmd));
    if (c.cmd === null || c.secret === 'refused') refuse('secret');
    // D116 item 5: keystrokes fed into a login alone: the step goes, and the login is the person's, before they start.
    const feed = c.loginFeed ? { service: c.loginFeed, login: c.cmd ?? '' } : loginFeed(c.cmd ?? '');
    if (feed) { logins.push(feed); return false; }
    // D101: keystrokes fed into a login or publish prompt answer the person's own confirmation.
    if (answersPrompt(c.cmd ?? '')) refuse('answers-prompt', excerpt(c.cmd));
    const why = blocked.get(c);
    if (why) refuse('multi-line', `${why}: \`${excerpt(c.cmd)}\``);
    if (c.multiLine) {
      const never = neverSave(c.cmd!);
      refuse(never ? 'never-save' : 'multi-line', never ? `${never}: \`${excerpt(c.cmd)}\`` : excerpt(c.cmd));
    }
    if (c.cwd === null) refuse('outside-repo', excerpt(c.cmd));
    return true;
  });
  let items: Item[] = [];
  for (const i of raw) {
    if (!usable(i)) continue;
    const c = calls[i]!;
    items.push({ i, call: c, core: '', text: '', bg: c.bg, wait: plan.roles[i] === 'wait', from: [c.id], gated: null, isCheck: i === ci });
  }
  // D59b: a deploy status read over MCP has no command to copy; build() words it.
  const checkOk = checkCall && !checkIsStep ? (checkCall.tool ? true : usable(ci!)) : null;

  // Step 4: a repeat keeps its last run, with every id.
  let duplicates = 0;
  const keyOf = (it: Item) => `${it.call.cwd}\u0000${normalizeCommand(it.call.cmd!)}`;
  items = items.filter((it, k) => {
    if (it.wait) return true;
    const later = items.slice(k + 1).find((b) => !b.wait && keyOf(b) === keyOf(it));
    if (!later) return true;
    later.from = [...new Set([...it.from, ...later.from])];
    duplicates++;
    return false;
  });

  // Steps 6 to 9: folder, paths, text, risk.
  const shape = (c: RunCall, wait: { token: string | null; whileOk?: true; loop?: true } | null) => {
    // A loop's poll keeps its output filters: the value it waited for is what they printed.
    let core = wait?.loop ? c.cmd!.trim() : cleanText(c.cmd!, opts.platform);
    let bg = c.bg;
    if (/(?<![&|>])&\s*$/.test(core)) { core = core.replace(/\s*&\s*$/, ''); bg = true; }
    const p = paths(core, sheet, opts, helpers, strict);
    core = p.text;
    const text = inFolder(c.cwd ?? '', core);
    if (text.length > MAX_STEP_CHARS) refuse('step-too-long', excerpt(text));
    let final = text;
    if (wait) {
      final = wait.token !== null
        ? `s=$SECONDS; until [ "$(${c.cwd ? `cd ${quoteDir(c.cwd)} && ${core}` : core})" = "${wait.token}" ]; ${WAIT_TAIL}`
        : `s=$SECONDS; ${wait.whileOk ? 'while' : 'until'} ${text} >/dev/null 2>&1; ${WAIT_TAIL}`;
    }
    const why = neverSave(final);
    if (why) refuse('never-save', `${why}: \`${excerpt(core)}\``);
    if (literalPassword(final)) refuse('secret');
    return { core, text: final, bg: wait ? false : bg, gated: gatedKind(final) ?? p.gated };
  };
  items = items.filter((it) => guard(() => Object.assign(it, shape(it.call, it.wait ? plan.waits.get(it.i)! : null))) !== null);
  const check = checkCall && checkOk && !checkCall.tool ? guard(() => shape(checkCall, null)) : null;
  return { sheet, items, check, checkCall, checkFam, checkIsStep, ci, plan, helpers, duplicates, elsewhere, parts, logins };
}

const BUG = (what: string) => refuse('never-save', `bug: ${what}`);

function build(sheet: RunSheet, opts: CompileOpts): CompiledSkill {
  // Step 1.
  if (sheet.job && JUDGEMENT_JOBS.has(sheet.job)) refuse('judgement', sheet.job);
  // Deploy status reads (D59b) share the call cap but are not commands.
  if (sheet.counts.commands > sheet.calls.filter((c) => !c.tool).length) refuse('too-long', 'overflow');
  if (opts.moment === 'repeated' && sheet.checkIndex === null) refuse('no-check');
  const k = keptSteps(sheet, opts, true);
  if (opts.moment === 'repeated' && !k.checkCall) refuse('no-check');

  // Step 10: params, with the prior run's steps for what varied.
  const prior = opts.prior ? keptSteps(opts.prior, opts, false).items.map((it) => it.text) : null;
  const checkText = k.checkIsStep ? k.items.find((it) => it.isCheck)?.text : k.check?.text;
  const found = findParams(k.items.map((it) => it.text), { prompt: sheet.promptParams ?? {}, prior, ...(checkText === undefined ? {} : { check: checkText }) });

  // Params can hide a target (`rm -rf build-{arg1}`) or a branch (`git push origin {branch}`): read the steps again.
  k.items.forEach((it, n) => {
    const why = neverSave(found.cmds[n]!);
    if (why) refuse('never-save', `${why}: \`${excerpt(found.cmds[n]!)}\``);
    it.gated ??= gatedKind(found.cmds[n]!);
  });
  if (found.check !== undefined && neverSave(found.check)) refuse('never-save', excerpt(found.check));
  // D106: a check that reads a version shows the {version} the steps use, or it could never pass.
  const cc = k.checkCall;
  const tie = cc && !k.checkIsStep && versionShaped(cc, k.checkFam)
    ? versionTie(k.items.map((it, n) => ({ cmd: found.cmds[n]!, cwd: it.call.cwd })), found.params, shownVersion(cc)) ?? refuse('no-check', 'version') : null;
  if (tie) found.params = tie.params;

  // Step 12: size and worth. D58 b: at least one step inside the repo (the check, when there is one, too).
  if (!k.items.length) refuse(k.elsewhere.length ? 'outside-repo' : 'no-steps', k.elsewhere.length ? excerpt(k.elsewhere[0]!.cmd) : '');
  // D51: a report whose query ran as an inline script has no step that makes the numbers.
  if (sheet.job === 'report' && !k.items.some((it) => checkFamilyOf(it.call.cmd!, 'report') === 'query')) refuse('no-steps', 'report');
  if (k.items.length > MAX_RUN_LINES) refuse('too-long', String(k.items.length));
  if (opts.moment === 'repeated' && sheet.counts.failed === 0) {
    const plain = (t: string) => PLAIN.test(/^\(cd \S+ && (.*)\)$/.exec(t)?.[1] ?? t);
    if (k.items.every((it) => !it.wait && !it.bg && plain(it.text))) refuse('trivial', k.items.map((it) => it.text).join(' ; '));
  }

  // Part 7: the steps follow the person's learnings about commands; the check can't be left out.
  const follow = followAtSave(k.items.map((it, n) => ({ cmd: found.cmds[n]!, gated: it.gated !== null, isCheck: k.checkIsStep && it.isCheck })), [...(opts.learnings ?? [])]);
  if (follow.refuse) refuse('never-save', follow.refuse);
  if (follow.line) {
    const was = k.items;
    k.items = follow.keep.map(({ i, cmd }) => (cmd === found.cmds[i] ? was[i]! : { ...was[i]!, core: /^\(cd \S+ && (.*)\)$/.exec(cmd)?.[1] ?? cmd }));
    const cmds = follow.keep.map(({ cmd }) => cmd);
    const checkAt = follow.keep.findIndex(({ i }) => k.checkIsStep && was[i]!.isCheck);
    if (checkAt >= 0) found.check = cmds[checkAt]!;
    found.cmds = cmds;
    if (!k.items.length) refuse('no-steps');
  }

  // Step 13: name and words.
  let steps: SkillStep[] = k.items.map((it, n) => ({ n: n + 1, cmd: found.cmds[n]!, gated: it.gated, bg: it.bg, wait: it.wait, from: it.from }));
  const sourceCalls = k.items.map((it) => it.call);
  const main = k.checkIsStep && found.check !== undefined ? { main: found.check } : {};
  // D99: an asked save whose run's asks gave no job takes it from the save request or the run's commands, so a
  // release is `release-npm`, never named after its first step (`git-fetch`).
  const job = sheet.job ?? (opts.moment === 'asked' ? askedJob(opts.askedWith, steps, sourceCalls, k.checkFam) : null);
  const asked = job === null && opts.moment === 'asked' ? { asked: askPhrases(opts.askedWith) } : {};
  const words = jobWords({ ...sheet, job }, steps, { calls: sourceCalls, helperText: k.helpers.map((h) => h.content).join('\n'), ...main, ...asked });
  const name = opts.name && goodName(opts.name) && !AGENT_COMMAND_NAMES.has(opts.name) && !opts.taken(opts.name) ? opts.name : freeName(words.base, sheet.repoKey, opts.taken);
  const named = (t: string) => t.split(SKILL_DIR).join(name);
  steps = steps.map((s) => ({ ...s, cmd: named(s.cmd) }));
  const tool = k.checkCall?.tool;
  const check = tool ? toolCheckWords(tool, k.checkCall!.check?.facts ?? {}, found.params) : found.check === undefined ? '' : named(found.check);

  // Step 11: ready, check first, needs.
  const shipping = job === 'ship' || job === 'release';
  const ready: string[] = [];
  if (shipping || k.plan.probes.some((p) => p.text === PORCELAIN)) ready.push(PORCELAIN);
  if (shipping && sheet.branch && STABLE_BRANCHES.has(sheet.branch)) ready.push(`git rev-parse --abbrev-ref HEAD = ${sheet.branch}`);
  for (const p of k.plan.probes) {
    const t = relativizePaths(p.text, opts.repoRoot, opts.home);
    if (p.text !== PORCELAIN && !SCRATCH_ONE.test(t) && !ready.includes(t)) ready.push(t);
  }
  const checkFirst = [...new Set(k.plan.checkFirst.map((c) => relativizePaths(c.text, opts.repoRoot, opts.home)))].slice(0, 2);
  const needs: string[] = [];
  for (const core of [...k.items.map((it) => it.core), ...(k.check ? [k.check.core] : [])]) {
    for (const simple of simpleCommands(core)) {
      const w = bareCommand(simple).split(/\s+/)[0] ?? '';
      if (/^[A-Za-z][\w.+-]*$/.test(w) && !NOT_NEEDS.has(w) && !needs.includes(w)) needs.push(w);
    }
  }

  // Step 14: If it fails.
  const ifFails = failLines(k.sheet, opts, k.items, steps, checkFirst, found.params);

  // Step 3: the check.
  const checkShows = checkShowsFor(k.checkFam, k.checkCall, found.params, tie?.name ?? null);

  const id = opts.id ?? `s-${createHash('sha256').update(`${sheet.id}|${name}`).digest('hex').slice(0, 6)}`;
  const gatedTexts = steps.filter((s) => s.gated).map((s) => s.cmd);
  const meta: SkillMeta = {
    trail: id, scope: 'personal', applies: opts.applies, ...(job ? { job } : {}), asks: words.asks.join(', '),
    ...(words.statusAsks.length ? { 'status-asks': words.statusAsks.join(', ') } : {}),
    ...(found.params.length ? { params: paramsToMeta(found.params) } : {}),
    ...(needs.length ? { needs: needs.slice(0, 6).join(', ') } : {}),
    ...(ready.length ? { ready: ready.slice(0, 3).join(' ; ') } : {}),
    ...(checkFirst.length ? { 'check-first': checkFirst.join(' ; ') } : {}),
    ...(k.logins.length ? { 'before-you-start': [...new Set(k.logins.map((l) => `the person is logged in to ${l.service}; they run ${l.login} themselves`))].join(' | ') } : {}),
    ...(gatedTexts.length ? { 'confirm-before': gatedTexts.join(' ; ') } : {}),
    ...(check ? { check } : {}),
    ...(check && checkShows ? { 'check-shows': checkShows } : {}),
    ...(tool ? { 'check-tool': tool.replace(/^mcp__.+__(?=[^_])/, '') } : {}),
    version: '1',
  };

  // Every call not copied into a step, by what it was; steps that ran elsewhere are listed instead (D58 b).
  const inSteps = new Set(steps.flatMap((s) => s.from ?? []));
  const away = new Set(k.elsewhere.map((c) => c.id));
  const leftOut = { failed: 0, lookOnly: 0, duplicates: k.duplicates, plumbing: 0, work: 0 };
  sheet.calls.forEach((c, i) => {
    if (c.tool) return; // a deploy status read is not a command
    // A piece too long to keep (D58 c) is work left out, even when the call's other pieces are steps.
    const long = c.parts?.filter((p) => p.long).length ?? 0;
    leftOut.work += long;
    if (long && c.parts!.every((p) => p.long)) return;
    if (inSteps.has(c.id) || away.has(c.id)) return;
    // A call read part by part counts as what its parts were (a heredoc that only wrote files is work, D51).
    const kinds = (k.parts.get(c) ?? [c]).map((x) => x.kind);
    if (c.failed && i !== sheet.checkIndex) leftOut.failed++;
    else if (kinds.every((x) => x === 'plumbing')) leftOut.plumbing++;
    else if (kinds.includes('work')) leftOut.work++;
    else leftOut.lookOnly++;
  });

  // Step 15: assemble and check the file.
  const c: CompiledSkill = {
    name, title: words.title, description: describe(words.lead, sheet.endedAt, words.asks), meta, steps, check,
    checkShows: check ? checkShows : null, checkIsStep: k.checkIsStep && !!check, ifFails, dontUse: words.dontUse, params: found.params,
    helpers: k.helpers, leftOut, ...(k.elsewhere.length ? { elsewhere: elsewhereLines(k.elsewhere, sheet.repoKey, (t) => relativizePaths(cleanText(t, opts.platform), opts.repoRoot, opts.home)) } : {}),
    ...(sheet.joined?.length ? { carried: carriedSteps(sheet, steps) } : {}),
    source: { runId: sheet.id, commands: sheet.counts.commands, failed: sheet.counts.failed, at: sheet.endedAt },
    ...(follow.line ? { followed: follow.line } : {}),
  };
  const text = renderSkillMd(c);
  const problems = skillProblems(text, name);
  if (problems.length) BUG(problems[0]!);
  if (text.split('\n').length - 1 > 60) BUG('more than 60 lines');
  if (secretReason(text) !== null) BUG('the file holds something that looks like a secret');
  return c;
}

const SCRATCH_ONE = new RegExp(SCRATCH.source);
const NOT_NEEDS = new Set(['cd', 'export', 'source', 'echo', 'printf', 'sleep', 'true', 'false', 'pwd', 'set', 'unset', 'alias', 'wait', 'exit', 'return', 'test', 'until', 'while', 'if', 'for', 'do', 'done', 'then', 'fi', 'eval', 'exec', 'read', 'local', 'shift', 'trap', 'cat', 'ls', 'head', 'tail', 'grep']);

/** 4.5 step 14: a failure the run got past, and the step that got past it. At most 4 lines. */
function failLines(sheet: RunSheet, opts: CompileOpts, items: Item[], steps: SkillStep[], checkFirst: string[], params: CompiledSkill['params']): string[] {
  const out: string[] = [];
  const add = (line: string | undefined) => { if (line && !out.includes(line) && out.length < 4) out.push(line); };
  const asParams = (t: string) => {
    let s = relativizePaths(t, opts.repoRoot, opts.home);
    for (const p of params) for (const v of p.seen) if (v && v.length >= 2) s = s.replace(new RegExp(`(?<![\\w.-])${v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w-]|\\.\\w)`, 'g'), `{${p.name}}`);
    return s;
  };
  sheet.calls.forEach((f, i) => {
    if (!f.failed || f.cmd === null || f.cwd === null) return;
    const text = cleanText(f.cmd, opts.platform);
    const cf = checkFirst.find((c) => c.split(' ').slice(0, 2).join(' ') === text.split(' ').slice(0, 2).join(' '));
    if (cf && CHECK_FIRST.test(text)) {
      add(`\`${cf}\` said you're not signed in: sign in first (the person may need to do this part).`);
      return;
    }
    const prog = programOf(f.cmd);
    if (!prog || !f.errorLine) return;
    const k = items.findIndex((it) => it.i > i && programOf(it.call.cmd!) === prog);
    if (k < 0) return;
    const s = items[k]!;
    // The same command again: a retry, nothing to learn from it.
    if (normalizeCommand(f.cmd) === normalizeCommand(s.call.cmd!) && f.cwd === s.call.cwd) return;
    const err = asParams(f.errorLine);
    if (SCRATCH_ONE.test(err)) return;
    add(cleanLine(`\`${prog}\` said "${err}": what worked was step ${steps[k]!.n}.`, 200));
  });
  return out;
}

export function compileRun(input: RunSheet, opts: CompileOpts): CompileResult {
  try {
    // D59a: a run a compaction cut compiles whole, and so does its prior.
    const sheet = joinCarriedSheet(input, opts.readSheet);
    const prior = opts.prior ? joinCarriedSheet(opts.prior, opts.readSheet) : opts.prior;
    return { ok: true, skill: build(sheet, { ...opts, prior }) };
  } catch (e) {
    if (e instanceof Refused) return { ok: false, reason: e.reason, detail: e.detail };
    return { ok: false, reason: 'never-save', detail: `bug: ${e instanceof Error ? e.message : String(e)}` };
  }
}
