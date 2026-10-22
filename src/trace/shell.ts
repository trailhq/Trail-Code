/**
 * Reading a shell command the way the shell does, without running anything.
 *
 * Agents write commit messages in `"$(cat <<'EOF' ... EOF)"`, wrap commands
 * in `(cd x && ...)`, poll in `for` loops and pipe everything through
 * `| tail`. A plain split on `;` or `|` turns a word inside a quote, a
 * substitution or a heredoc body into a "step", so this reads top-level
 * segments only: quotes, `$'…'`, `$(…)`, backticks, `(…)` subshells, `{…}`
 * groups, `[[…]]`, loops and ifs are opaque, and a heredoc body belongs to the
 * segment whose line opened it.
 *
 * The PreToolUse fast path loads this file: its imports are the lexer,
 * `shell-scan.ts`, and the program-word layer on it, `shell-words.ts`; the
 * lexer imports nothing.
 *
 * Every reader here is linear in the command's length (a skill's step is
 * matched against each command the agent runs, in the PreToolUse hook) and
 * reads nesting only to a fixed depth.
 */
import type { CallKind } from './types.js';
import { ASSIGN, OPEN_KW, base, cut, pieceText, scan, unquote, words, type Piece } from './shell-scan.js';
import {
  MAX_DEPTH, PLUMBING, RUNNERS, VALUE_FLAGS, afterTimeout, bareCommand, groupInner, heredocInterpreter, hookUnrun, inlineScript, programOfText, programWords,
  quotedTextHit, readsFiles, scriptKind, shellOnly, shellScript, simpleCommands, stripKeywords, writesFile,
} from './shell-words.js';

export { PLUMBING, RUNNERS, bareCommand, heredocInterpreter, hookUnrun, inlineScript, quotedTextHit, readsFiles, scriptKind, simpleCommands };

export interface Segment { text: string; sep: '&&' | '||' | ';' | '|' | '&' | '' }

/**
 * Top-level segments. Opaque: '…', "…", $'…', $(…), `…`, a (…) subshell, a {…} group, and a heredoc
 * body (the lines after `<<[-~]?\s*['"]?WORD['"]?` up to the line that is exactly WORD), which belongs to
 * the segment whose line opened it. Each segment keeps the separator after it; a trailing `&` gives '&'.
 */
export function splitTop(cmd: string): Segment[] {
  const s = String(cmd ?? '');
  return scan(s).segs.map((p) => ({ text: pieceText(s, p), sep: p.sep }));
}

/** Any heredoc, or a newline outside quotes and heredoc bodies (a `\`-continued line is not one). */
export function isMultiLine(cmd: string): boolean {
  const r = scan(String(cmd ?? ''));
  return r.heredoc || r.newline;
}

/** `A=1 B=2 cmd` -> { env: ['A=1','B=2'], rest: 'cmd' }. */
export function envPrefix(cmd: string): { env: string[]; rest: string } {
  const s = String(cmd ?? '').trimStart();
  const env: string[] = [];
  let at = 0;
  for (const w of words(s)) {
    if (!ASSIGN.test(w)) break;
    env.push(w);
    at = s.indexOf(w, at) + w.length;
  }
  return { env, rest: env.length ? s.slice(at).trim() : s.trim() };
}

/**
 * Every leading `cd X &&` / `cd X;` segment in order (`cd X || exit 1` on its own line is one too), and
 * `(cd X && rest)` when the subshell is the whole command.
 */
export function leadingCds(cmd: string, depth = 0): { cds: string[]; rest: string } {
  const s = String(cmd ?? '').trim();
  const { segs } = scan(s);
  const cds: string[] = [];
  let k = 0;
  for (; k < segs.length; k++) {
    const p = segs[k]!;
    const w = words(s.slice(p.start, p.end));
    if (w[0] !== 'cd' || w.length > 2 || p.bodies.length) break;
    let end = k;
    if (p.sep === '||') {
      const q = segs[k + 1];
      const e = q ? words(s.slice(q.start, q.end)) : [];
      if (!q || q.bodies.length || q.group || !/^(?:exit|return)$/.test(e[0] ?? '') || e.length > 2) break;
      end = k + 1;
    }
    const sep = segs[end]!.sep;
    if (end < segs.length - 1 && sep !== '&&' && sep !== ';') break;
    if (end === segs.length - 1 && sep !== '') break;
    cds.push(w[1] === undefined ? '~' : unquote(w[1]));
    k = end;
  }
  if (k === segs.length && k > 0) return { cds, rest: '' };
  const rest = k ? s.slice(segs[k]!.start).trim() : s;
  const only = scan(rest).segs;
  const g = only.length === 1 ? only[0]!.group : null;
  if (g && rest[g.open] === '(' && g.close === rest.length - 1 && depth < MAX_DEPTH && /^\s*cd\b/.test(rest.slice(g.open + 1))) {
    const inner = leadingCds(rest.slice(g.open + 1, g.close), depth + 1);
    if (inner.cds.length) return { cds: [...cds, ...inner.cds], rest: inner.rest };
  }
  return { cds, rest };
}

/** Drops a leading `sleep N;` / `sleep N &&`. A sleep inside a subshell or pipe stays. */
export function stripLeadingSleep(cmd: string): string {
  const s = String(cmd ?? '').trim();
  const { segs } = scan(s);
  let k = 0;
  for (; k < segs.length - 1; k++) {
    const p = segs[k]!;
    if (p.sep !== ';' && p.sep !== '&&') break;
    const w = words(s.slice(p.start, p.end));
    if (w[0] !== 'sleep' || w.length !== 2) break;
  }
  return k ? s.slice(segs[k]!.start).trim() : s;
}

/** Drops a leading `timeout N ` / `gtimeout N ` (also right after env prefixes). */
export function stripTimeout(cmd: string): string {
  const s = String(cmd ?? '').trim();
  const { env, rest } = envPrefix(s);
  const w = words(rest);
  const after = afterTimeout(w);
  if (!after?.length) return s;
  // Cut the original text where the command after the duration starts, so its spacing and quotes stay as typed.
  let at = 0;
  for (const word of w.slice(0, w.length - after.length)) at = rest.indexOf(word, at) + word.length;
  return [...env, rest.slice(at).trim()].join(' ').trim();
}

/** Drops trailing `| tail…`, `| head…`, `| less`, `| more`, `| cat` segments and the `2>&1` that fed them. */
export function stripOutputFilters(cmd: string): string {
  let s = String(cmd ?? '').trim();
  for (;;) {
    const { segs, keep } = scan(s);
    let k = segs.length;
    while (k > 1 && segs[k - 2]!.sep === '|' && /^(?:tail|head|less|more|cat)$/.test(words(s.slice(segs[k - 1]!.start, segs[k - 1]!.end))[0] ?? '')) k--;
    if (k === segs.length) return s;
    const prev = segs[k - 1]!;
    const head = s.slice(prev.start, prev.end);
    const redirect = /\s*2>&1\s*$/.exec(head);
    const from = redirect ? prev.start + redirect.index : prev.end;
    s = cut(s, [[from, segs[segs.length - 1]!.end]], keep);
  }
}

/** Drops a last segment that is only `echo …` or `printf …` after `&&`, `;` or `||`. */
export function stripTrailingEcho(cmd: string): string {
  const s = String(cmd ?? '').trim();
  const { segs, keep } = scan(s);
  if (segs.length < 2) return s;
  const prev = segs[segs.length - 2]!;
  const last = segs[segs.length - 1]!;
  if (prev.sep !== '&&' && prev.sep !== ';' && prev.sep !== '||') return s;
  if (!/^(?:echo|printf)$/.test(words(s.slice(last.start, last.end))[0] ?? '') || last.bodies.length) return s;
  return cut(s, [[prev.end, last.end]], keep);
}

/**
 * The first segment's program after env prefixes, leading cds, `time`, `nice`, `command`, and a
 * `script -q /dev/null` wrapper; two words for RUNNERS (`git push`, `gh pr`, `npm run`, `npx vitest`).
 * Never a word from inside quotes or a heredoc body.
 */
export function programOf(cmd: string): string | null {
  const s = String(cmd ?? '').trim();
  if (!s) return null;
  return programOfText(leadingCds(s).rest || s).prog;
}

/** `find` actions that change files or run commands: such a find is not a look. */
const FIND_ACTS = /^-(?:delete|exec|execdir|ok|okdir|fprint0?|fprintf|fls)$/;

/**
 * Commands that only report on the machine, reshape text, read an API or print a version or help: they
 * run, but change nothing, so they are looks (on the program words, wrappers gone; a file redirect still
 * makes them work).
 */
const INFO = /^(?:date|uname|hostname|sw_vers|whoami|id|uptime|nproc|ps|pgrep|lsof|vm_stat|printenv|sysctl|seq|tr|sort(?![^|;&]*\s-\w*o)|uniq|cut|awk|column|paste|comm|nl|diff|cmp|basename|dirname|realpath|readlink|od|xxd|strings|xargs echo|git (?:rev-list|for-each-ref|name-rev|ls-tree)|docker (?:ps|images|inspect|logs|version|context (?:ls|inspect|show))|colima (?:status|list|ls)|kubectl (?:get|describe|logs)|npm config get|git config --get|brew (?:list|info)|open(?!\s+-[aAbe]\b)|gh (?:repo|release) (?:list|view)|gh api(?![^|;&]*\s(?:-X|--method|-f|-F|--field|--raw-field|--input)\b))(?:\s|$)|^(?:npx(?:\s+-[\w-]+)*\s+)?[\w.@/+-]+(?: [\w-]+)? (?:--version|-v|-V|version|--help|-h|help)(?:\s+\d?>>?&?\s*[^\s&>]\S*)*$/;

/**
 * A segment's kind on its own: plumbing, work, look or step. A top-level redirect into a file turns
 * a look or plumbing segment into work: `grep x a > ~/.trail/y` writes a file, and the tamper check
 * (4.1) trusts that a look only reads.
 */
function segKind(s: string, p: Piece, depth: number): CallKind {
  if (p.group) return kindOf(groupInner(s, p), depth + 1);
  const head = s.slice(p.start, p.end);
  // D51, D58 e: an interpreter's heredoc program is read for what it does; it is never a step.
  const prog = p.bodies.length ? heredocInterpreter(programWords(head)) : null;
  if (prog) return scriptKind(p.bodies.map(([a, b]) => s.slice(a, b)).join('\n'), prog) === 'look' && !writesFile(head) ? 'look' : 'work';
  const k = readKind(head, depth);
  return (k === 'look' || k === 'plumbing') && writesFile(head) ? 'work' : k;
}

function readKind(head: string, depth: number): CallKind {
  const w = programWords(head);
  const prog = base(w[0] ?? '');
  if (OPEN_KW.has(w[0] ?? '')) {
    const inner = stripKeywords(head);
    if (inner !== head) return kindOf(inner, depth + 1);
  }
  if (!w.length || shellOnly(prog)) return 'plumbing';
  if (INFO.test(w.join(' ').replace(/^docker(?:\s+(?:--context|-c|--host|-H)[ =]\S+)+/, 'docker'))) return 'look';
  const sub = w.slice(1).filter((a) => !a.startsWith('-'));
  const flags = w.slice(1).filter((a) => a.startsWith('-'));
  if (prog === 'git') {
    const g = w.slice(1).filter((a, i, all) => !a.startsWith('-') && !VALUE_FLAGS.git!.has(all[i - 1] ?? ''));
    const verb = g[0];
    if ((verb === 'worktree' || verb === 'stash') && /^(?:list|show)$/.test(g[1] ?? '')) return 'look';
    if (verb === 'tag' && (g.length === 1 || flags.some((f) => /^(?:-l|--list|--contains|--points-at)$/.test(f)))) return 'look';
    if (verb && /^(?:add|commit|stash|restore|rm|mv|apply|am)$/.test(verb)) return 'work';
    if (verb === 'checkout' && w.includes('--')) return 'work';
    if (verb && /^(?:status|log|diff|show|ls-files|blame|describe|reflog|shortlog)$/.test(verb)) return flags.some((f) => /^--output\b/.test(f)) ? 'step' : 'look';
    if (verb === 'rev-parse' && !w.includes('--verify')) return 'look';
    if (verb === 'remote' && g.length === 1) return 'look';
    if (verb === 'branch' && g.length === 1 && !flags.some((f) => /^-(?:[dDmMcCfu]|-delete|-move|-copy|-force|-set-upstream-to|-unset-upstream|-edit-description)/.test(f))) return 'look';
    return 'step';
  }
  if (prog === 'gh') {
    if (/^(?:pr (?:view|list|diff)|run list|issue (?:view|list)|repo view)$/.test(sub.slice(0, 2).join(' '))) return 'look';
    return 'step';
  }
  if (prog === 'npm' && sub[0] === 'ls') return 'look';
  if (prog === 'perl' && flags.some((f) => /^-\w*i/.test(f))) return 'work';
  // D51, D58 e: `node -e`, `python3 -c`: a step only when it is one line that starts a program.
  const code = inlineScript(w);
  if (code !== null) return scriptKind(code, prog);
  if (prog === 'sed') return flags.some((f) => /^-[a-zA-Z]*i/.test(f) || f === '--in-place') ? 'work' : flags.includes('-n') ? 'look' : 'step';
  if (prog === 'perl') return flags.some((f) => /^-\w*i/.test(f)) ? 'work' : 'step';
  if (prog === 'rm') return flags.some((f) => /^-\w*[rR]|^--recursive/.test(f)) ? 'step' : 'work';
  if (prog === 'tee') return sub.length ? 'work' : 'plumbing';
  if (/^(?:patch|mkdir|touch|cp|mv|chmod|ln)$/.test(prog)) return 'work';
  if (prog === 'command') return w[1] === '-v' || w[1] === '-V' ? 'look' : 'step';
  if (prog === 'find' && w.some((a) => FIND_ACTS.test(a))) return 'step';
  if (prog === 'tree' && flags.some((f) => /^-o/.test(f))) return 'step';
  if (/^(?:ls|cat|head|tail|grep|egrep|rg|find|wc|pwd|which|less|more|tree|stat|file|du|df|jq|test|\[)$/.test(prog)) return 'look';
  return 'step';
}

/** What a whole command is: plumbing when every segment is; work when it only edits or commits; look when it only reads. */
function kindOf(cmd: string, depth = 0): CallKind {
  if (depth > MAX_DEPTH) return 'step';
  const s = String(cmd ?? '');
  const { segs } = scan(s);
  const kinds = segs.map((p) => segKind(s, p, depth));
  if (kinds.every((k) => k === 'plumbing')) return 'plumbing';
  if (kinds.includes('step')) return 'step';
  return kinds.includes('work') ? 'work' : 'look';
}

/** Read-only exploration (4.1 kinds). */
export function isLookOnly(cmd: string): boolean {
  const k = kindOf(cmd);
  return k === 'look' || k === 'plumbing';
}

/** Changes the work itself rather than running the job (4.1 kinds). */
export function isWork(cmd: string): boolean {
  return kindOf(cmd) === 'work';
}

/** plumbing, work, look or step from the command alone (4.1; the fold also counts read-only check families as look). */
export function commandKind(cmd: string): CallKind {
  return kindOf(cmd);
}

const TRAIL_BIN = /^(?:trail|graft|trail-code)$/;
const TRAIL_PKG = /^(?:@trailhq\/trail-code|@nanonets\/graft|trail-code)(?:@\S*)?$/;
const TRAIL_SCRIPT = /(?:^|\/)dist\/bin\/(?:trail|graft)\.js$|(?:^|\/)(?:trail|graft)-hooks\.cjs$/;

/** Trail's own program in one simple command (not through `sh -c`). `bare`: only `trail`/`graft` found on PATH, not a path to one. */
function trailProgram(w: string[], bare: boolean): boolean {
  const p = w[0];
  if (!p) return false;
  if (bare ? TRAIL_BIN.test(p) : TRAIL_BIN.test(base(p)) || TRAIL_SCRIPT.test(p)) return true;
  const args = w.slice(1).filter((a) => !a.startsWith('-'));
  if (p === 'npx' || p === 'bunx' || p === 'pnpx') return TRAIL_PKG.test(args[0] ?? '');
  if ((p === 'pnpm' || p === 'yarn') && args[0] === 'dlx') return TRAIL_PKG.test(args[1] ?? '');
  if (p === 'npm' && args[0] === 'exec') return TRAIL_PKG.test(args[1] ?? '');
  if (base(p) === 'node') return TRAIL_SCRIPT.test(args[0] ?? '');
  return false;
}

function trailSegment(text: string, depth: number): boolean {
  const raw = programWords(text);
  const script = shellScript(raw);
  return script !== null ? isTrailAt(script, depth + 1) : trailProgram(raw.map(unquote), false);
}

function isTrailAt(s: string, depth: number): boolean {
  if (depth > MAX_DEPTH) return false;
  return scan(s, false).segs.some((p) => (p.group ? isTrailAt(groupInner(s, p), depth + 1) : trailSegment(s.slice(p.start, p.end), depth)));
}

/**
 * Any part of the command runs Trail: trail, graft, npx @trailhq/trail-code, npx @nanonets/graft,
 * node …/dist/bin/(trail|graft).js. For "a skill never runs Trail" (4.11). The fold's "Trail's own
 * command, ignored" (4.1) is `onlyTrail`: `trail x; rm ~/.trail/y` runs Trail and is not only Trail.
 */
export function isTrailCommand(cmd: string): boolean {
  const s = String(cmd ?? '');
  return isTrailAt(s, 0) || TRAIL_INSIDE.test(s);
}
/** Trail run inside a word: `$(trail …)`, `<(trail …)`. Not backticks: `graft` in backticks is far more often a quoted word in a commit message. */
const TRAIL_INSIDE = /(?:\$\(|[<>]\()\s*(?:trail|graft|trail-code|npx\s+(?:@trailhq\/trail-code|@nanonets\/graft))\b/;

/** Code that runs inside a word: `$( )`, backticks, `<( )`, `>( )`, outside single quotes (and anywhere in a command with a heredoc). */
function runsInside(s: string): boolean {
  let dq = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (c === '\\') { i++; continue; }
    if (c === '`' || (c === '$' && s[i + 1] === '(')) return true;
    if (dq) { if (c === '"') dq = false; continue; }
    if (c === '"') dq = true;
    else if (c === "'") {
      if (s[i - 1] === '$') while (i + 1 < s.length && s[i + 1] !== "'") i += s[i + 1] === '\\' ? 2 : 1;
      else while (i + 1 < s.length && s[i + 1] !== "'") i++;
      i++;
    } else if ((c === '<' || c === '>') && s[i + 1] === '(') return true;
  }
  return scan(s).heredoc && /`|\$\(/.test(s);
}

/** Lines that change what a later `trail` runs: PATH, an alias, a function. */
const REDEFINES = /\bPATH\+?=|^(?:alias|unalias|hash|function)$|^[\w.-]+\(\)/;

function onlyTrailAt(s: string, depth: number): boolean {
  if (depth > MAX_DEPTH || !s.trim() || runsInside(s)) return false;
  let trail = false;
  for (const simple of simpleCommands(s)) {
    if (writesFile(simple) || words(simple).some((x) => REDEFINES.test(x))) return false;
    const raw = programWords(simple);
    const script = shellScript(raw);
    if (script !== null) {
      if (!onlyTrailAt(script, depth + 1)) return false;
      trail = true;
    } else if (trailProgram(raw.map(unquote), true)) trail = true;
    else if (!['look', 'plumbing'].includes(kindOf(simple, depth + 1))) return false;
  }
  return trail;
}

/**
 * The whole command is Trail's own (4.1 "ignored entirely", and the tamper check's exemption): it runs
 * Trail, and everything else in it only reads or sets up the shell. Not when any part writes a file
 * (a redirect, cp, tee), runs code inside a word (`$( )`, backticks), runs another program, or changes
 * which `trail` runs (PATH, an alias, a function, a path to a `trail`).
 */
export function onlyTrail(cmd: string): boolean {
  return onlyTrailAt(String(cmd ?? ''), 0);
}

/** The strips, repeated until nothing changes. */
function stripped(cmd: string): string {
  let s = String(cmd ?? '').trim();
  for (let n = 0; n < 20; n++) {
    const next = stripTimeout(stripLeadingSleep(leadingCds(stripTrailingEcho(stripOutputFilters(s))).rest));
    if (next === s) break;
    s = next;
  }
  return s;
}
const flatten = (s: string) => s.replace(/['"]/g, '').replace(/\s+/g, ' ').trim();

/** For comparisons: output filters, trailing echo, leading cds, leading sleep and timeout stripped; quotes removed; spaces collapsed. */
export function normalizeCommand(cmd: string): string {
  return flatten(stripped(cmd));
}

const escapeRe = (t: string) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * A step matches a command that ran when, after normalizeCommand on both, the step (params filled from
 * `values` where known, other {params} as \S+) matches at the start of the ran command or right after a
 * top-level `&& ` or `; `. Env prefixes are compared too, unless `ignoreEnv`.
 */
export function stepMatches(step: string, ran: string, values: Record<string, string> = {}, ignoreEnv = false): boolean {
  const core = stripped(step);
  let want = flatten(core);
  if (ignoreEnv) want = envPrefix(want).rest;
  if (!want) return false;
  // An unknown {param} is one token, never an operator: `{b}` can't swallow `&&`.
  const re = new RegExp(`^${want.split(/(\{[A-Za-z_][\w]*\})/).map((part) => {
    const name = /^\{([A-Za-z_]\w*)\}$/.exec(part)?.[1];
    if (!name) return escapeRe(part);
    const v = values[name];
    return v === undefined ? '[^\\s;&|<>]+' : escapeRe(flatten(v));
  }).join('')}(?=$|[\\s;&|])`);
  // The step spans `width` top-level segments, so a match from segment k reads only k..k+width-1:
  // linear in the command, where re-reading every tail was quadratic (a 7 KB script took 8 s).
  const width = Math.max(1, scan(core).segs.length);
  const s = stripped(ran);
  const { segs } = scan(s);
  for (let k = 0; k < segs.length; k++) {
    if (k > 0 && segs[k - 1]!.sep !== '&&' && segs[k - 1]!.sep !== ';') continue;
    const last = segs[Math.min(k + width, segs.length) - 1]!;
    let tail = flatten(stripTimeout(stripLeadingSleep(leadingCds(s.slice(segs[k]!.start, last.end)).rest)));
    if (ignoreEnv) tail = envPrefix(tail).rest;
    if (re.test(tail)) return true;
  }
  return false;
}

/** Absolute path tokens: under repoRoot become repo-relative (`./x` or `x`); under home become `$HOME/…`; `~/` becomes `$HOME/`. */
export function relativizePaths(cmd: string, repoRoot: string, home: string): string {
  const before = String.raw`(^|[\s'"=:(,]|(?<=:)//)`;
  const after = String.raw`(?=$|[/\s'"),;:&|])`;
  let s = String(cmd ?? '');
  const root = repoRoot.replace(/\/+$/, '');
  const h = home.replace(/\/+$/, '');
  if (root) s = s.replace(new RegExp(`${before}${escapeRe(root)}${after}(/?)`, 'g'), (_m, pre: string, slash: string) => `${pre}.${slash}`);
  if (h) s = s.replace(new RegExp(`${before}${escapeRe(h)}${after}`, 'g'), (_m, pre: string) => `${pre}$HOME`);
  return s.replace(/(^|[\s'"=:(,])~(?=\/|$|\s)/g, '$1$HOME');
}
