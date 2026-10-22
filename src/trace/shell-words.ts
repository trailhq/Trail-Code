/**
 * What a simple command runs, under `shell.ts`: the program word after env
 * prefixes and wrappers (`time`, `nice`, `nohup`, `command`, `env`, `sudo`,
 * `timeout`, `script -q /dev/null`), two words for a runner (`git push`,
 * `npm run`), and every simple command inside subshells, groups and loops.
 *
 * Nesting is read to a fixed depth: a command nested deeper than any real
 * one gets the safe answer (no program, a step) instead of a stack overflow.
 *
 * The PreToolUse fast path loads this file through `shell.ts`: its only
 * import is the lexer, which imports nothing.
 */
import type { CallKind } from './types.js';
import { ASSIGN, OPEN_KW, base, scan, unquote, words, type Piece } from './shell-scan.js';

/** Deeper than any real command: past it, a reader gives its safe answer. */
export const MAX_DEPTH = 24;

export const RUNNERS: ReadonlySet<string> = new Set([
  'npx', 'npm', 'pnpm', 'yarn', 'bun', 'bunx', 'deno', 'node', 'uv', 'uvx', 'python', 'python3', 'pip', 'pip3',
  'poetry', 'cargo', 'go', 'make', 'just', 'bundle', 'rake', 'mvn', 'gradle', 'gradlew', 'dotnet', 'docker', 'kubectl',
  'gh', 'git', 'terraform', 'aws', 'gcloud', 'az',
]);
/** cd export source . echo printf sleep true false pwd clear set unset alias wait */
export const PLUMBING: ReadonlySet<string> = new Set(['cd', 'export', 'source', '.', 'echo', 'printf', 'sleep', 'true', 'false', 'pwd', 'clear', 'set', 'unset', 'alias', 'wait']);

/** Builtins that only steer the shell itself: kinds and programOf treat them like PLUMBING (the exported list stays the design's). */
const SHELL_ONLY: ReadonlySet<string> = new Set(['exit', 'return', ':', 'trap', 'shopt', 'setopt', 'local', 'declare', 'typeset', 'readonly']);
export const shellOnly = (prog: string) => PLUMBING.has(prog) || SHELL_ONLY.has(prog);

/** Flags that take the next word as their value, per runner. */
export const VALUE_FLAGS: Record<string, ReadonlySet<string>> = {
  git: new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace']),
  npm: new Set(['--prefix', '-C', '-w', '--workspace']),
  pnpm: new Set(['-C', '--dir', '--filter', '-F', '-w']),
  yarn: new Set(['--cwd']),
  docker: new Set(['-f', '--file', '-p', '--project-name', '-H', '--context']),
};

const DURATION = /^\d+(?:\.\d+)?[smhd]?$/;
/** The words after `timeout [options] DURATION`, or null when `w` doesn't start that way. One pass over the words. */
export function afterTimeout(w: string[]): string[] | null {
  if (w[0] !== 'timeout' && w[0] !== 'gtimeout') return null;
  let i = 1;
  for (; i < w.length; i++) {
    const a = w[i]!;
    if (/^(?:--preserve-status|--foreground|-v|--verbose)$/.test(a) || /^(?:-[ks]|--kill-after|--signal)=\S/.test(a)) continue;
    if (/^(?:-[ks]|--kill-after|--signal)$/.test(a)) { i++; continue; }
    break;
  }
  return i < w.length && DURATION.test(w[i]!) ? w.slice(i + 1) : null;
}

/** `env [-i] [-u NAME] [NAME=V]... cmd` and `sudo|doas [-u user] [-flags] [--] cmd`: the words of cmd, or null. */
function afterEnvOrSudo(w: string[]): string[] | null {
  const p = w[0];
  let i = 1;
  if (p === 'env') {
    while (i < w.length) {
      const a = w[i]!;
      if (/^(?:-u|--unset|-C|--chdir|-S|--split-string)$/.test(a)) i += 2;
      else if (a.startsWith('-') || ASSIGN.test(a)) i++;
      else break;
    }
  } else if (p === 'sudo' || p === 'doas') {
    while (i < w.length) {
      const a = w[i]!;
      if (a === '--') { i++; break; }
      if (/^-[ugCDhprtUT]$/.test(a)) i += 2;
      else if (a.startsWith('-')) i++;
      else break;
    }
  } else return null;
  return i < w.length ? w.slice(i) : null;
}

/** The program words of one simple command: env prefixes and wrappers (time, nice, command, nohup, env, sudo, timeout, script -q /dev/null, !) gone. */
export function programWords(head: string): string[] {
  let w = words(head);
  for (;;) {
    while (w.length && ASSIGN.test(w[0]!)) w = w.slice(1);
    const p = w[0];
    if (p === 'time' || p === 'nohup' || p === '!' || p === 'exec') w = w.slice(p === 'time' && w[1] === '-p' ? 2 : 1);
    else if (p === 'command' && w[1] && !w[1].startsWith('-')) w = w.slice(1);
    else if (p === 'nice') w = w.slice(w[1] === '-n' ? 3 : w[1]?.startsWith('-') ? 2 : 1);
    else if (p === 'timeout' || p === 'gtimeout') {
      const rest = afterTimeout(w);
      if (!rest) return w;
      w = rest;
    } else if (p === 'env' || p === 'sudo' || p === 'doas') {
      const rest = afterEnvOrSudo(w);
      if (!rest) return w;
      w = rest;
    } else if (p === 'script') {
      const dev = w.indexOf('/dev/null');
      if (dev < 0 || !w.slice(1, dev).every((x) => x.startsWith('-'))) return w;
      w = w.slice(dev + 1);
    } else return w;
  }
}

/** `bash -c 'script'` (also sh, zsh, dash, `-lc`, `-ec`): the script, unquoted; else null. */
export function shellScript(w: string[]): string | null {
  return /^(?:ba|z|da)?sh$/.test(base(w[0] ?? '')) && /^-[a-zA-Z]*c$/.test(w[1] ?? '') && w[2] ? unquote(w[2]) : null;
}

/** A top-level `>`, `>>`, `&>`, `N>` or `>|` into a file other than /dev/null (quoted text and comments are not redirects). */
export function writesFile(head: string): boolean {
  return /(?:^|[^<>&\d])(?:&|\d)?>>?\|?\s*(?!&|\/dev\/null\b)[^\s&|;]/.test(words(head).join(' ').replace(/(["'])(?:\\.|(?!\1)[\s\S])*\1/g, '""'));
}

/* --------------------------------------------- scripts run by an interpreter (D51, D58 e) */

/** Interpreters whose program can come inline (`-e`, `-c`) or from a heredoc. */
export const INTERPRETERS = /^(?:python[\d.]*|node|ruby|perl|deno|bun|tsx|php)$/;
/** Code that starts a program: a child process, or the repo's own code loaded (`require('./scripts/x.js')`, `runpy`). */
const SCRIPT_STARTS = /\b(?:subprocess|pty\.spawn|os\.(?:system|popen|exec\w*|spawn\w*)\s*\(|Popen\b|child_process|(?:execSync|execFileSync|spawnSync|execFile|spawn|exec)\s*\(|system\s*\(|IO\.popen|Process\.(?:spawn|run)|Deno\.(?:run|Command)|Bun\.(?:spawn|\$))|require\(\s*['"]\.{1,2}\/(?![^'"]*\.json['"])|\bimport\s*\(\s*['"]\.{1,2}\/|\bexec\s*\(\s*open|\brunpy\b/;
/** Code that writes files. */
const SCRIPT_WRITES = /\bopen\([^)]*,\s*(?:mode\s*=\s*)?['"][^'"]*[wax]|\.write_(?:text|bytes)\(|\bshutil\.(?:copy\w*|move|rmtree)\(|\bos\.(?:rename|replace|remove|unlink|makedirs|mkdir|rmdir)\(|\.(?:mkdir|touch|unlink|rmdir)\(|\.to_(?:csv|json|parquet|excel)\(|\b(?:write|append)File(?:Sync)?\(|\b(?:rename|copyFile|mkdir|rmdir|unlink|mkdtemp|rm|cp)Sync\(|\bfs\.(?:rm|cp|rename|copyFile|mkdir|unlink|write)\w*\(|createWriteStream\(|\bFile\.(?:write|open\([^)]*['"][wa])|\bFileUtils\.|\bopen\s*\(?\s*(?:my\s+)?\$?\w+\s*,\s*['"]?\s*>/;
/** Code that sends to the network (a POST, a body, a socket): work. A plain GET that prints is a look. */
const SCRIPT_SENDS = /\b(?:requests|httpx|session|client|axios)\.(?:post|put|patch|delete)\s*\(|\bmethod\s*[:=]\s*['"](?:POST|PUT|PATCH|DELETE)|\b(?:data|json|body)\s*[:=]\s*(?!None\b|null\b)|\bsocket\b|\bsmtplib\b/i;

/**
 * D51, D58 e: what an interpreter's script does. One line that starts a program is a step
 * (`node -e "require('./scripts/release.js')"`); any other script is work when it writes files, starts
 * programs or sends to the network, and a look when it only reads or prints (a GET that prints is a look). A script over several lines
 * (a heredoc, a multi-line `-e`) is never a step: no one can run it from a skill line.
 */
export function scriptKind(code: string, prog = ''): CallKind {
  const starts = SCRIPT_STARTS.test(code) || (/^(?:ruby|perl|php)$/.test(prog) && /`[^`]*`/.test(code));
  if (starts && !code.includes('\n')) return 'step';
  return starts || SCRIPT_WRITES.test(code) || SCRIPT_SENDS.test(code) ? 'work' : 'look';
}

/** The code of `node -e CODE`, `python3 -c CODE`, `perl -ne CODE`, `php -r CODE`, `deno eval CODE` (unquoted); else null. */
export function inlineScript(w: string[]): string | null {
  const prog = base(w[0] ?? '');
  if (!INTERPRETERS.test(prog)) return null;
  const inline = /^python/.test(prog) ? /^-[a-zA-Z]*c$/ : prog === 'perl' ? /^-[a-zA-Z]*[eE]$/ : prog === 'php' ? /^-r$/
    : /^(?:-[a-zA-Z]*[ep]|--eval|--print)$/;
  for (let i = 1; i < w.length; i++) {
    const a = w[i]!;
    if (prog === 'deno' && i === 1 && a === 'eval') return w[2] === undefined ? null : unquote(w[2]);
    if (inline.test(a)) return w[i + 1] === undefined ? null : unquote(w[i + 1]!);
    // A flag that takes a value (`python3 -W ignore`, `node -r ts-node/register`), else a script file: not inline.
    if (/^-(?:W|X|r|-require|-import|-loader)$/.test(a)) { i++; continue; }
    if (!a.startsWith('-')) return null;
  }
  return null;
}

/** An interpreter fed its program by a heredoc (`python3 - <<'EOF'`, `node <<EOF`), not data for a script file. */
export function heredocInterpreter(w: string[]): string | null {
  const prog = base(w[0] ?? '');
  if (!INTERPRETERS.test(prog)) return null;
  for (const a of w.slice(1)) {
    if (/^(?:\d*[<>]|&>)/.test(a)) break; // the heredoc opener or a redirect: the arguments end
    // `-` reads the program from stdin; the words after it are the program's own arguments.
    if (a === '-') return prog;
    if (!a.startsWith('-')) return null;
  }
  return prog;
}

const KW_LEAD = /^(?:(?:for|select|case)\b.*|(?:while|until|if|elif|do|then|else|!)(?:\s+|$))/;

/** A loop or if, as the simple commands it runs (headers and closing words gone). */
export function keywordFree(text: string): string[] {
  return scan(text, false).segs.map((p) => {
    let t = text.slice(p.start, p.end);
    for (let n = 0; n < 8 && KW_LEAD.test(t); n++) t = t.replace(KW_LEAD, '');
    return t.replace(/^(?:done|fi|esac)$/, '');
  }).filter(Boolean);
}
export const stripKeywords = (text: string) => keywordFree(text).join('; ');

/** The text inside a piece that is a subshell or group. */
export const groupInner = (s: string, p: Piece) => s.slice(p.group!.open + 1, p.group!.close < 0 ? p.end : p.group!.close);

/** One segment's program, and whether it is only plumbing. Subshells, groups, loops and `sh -c` are read inside. */
function segProgram(s: string, p: Piece, depth: number): { prog: string | null; plumbing: boolean } {
  if (p.group) return programOfText(groupInner(s, p), depth + 1);
  const head = s.slice(p.start, p.end);
  const w = programWords(head);
  const first = w[0];
  if (!first) return { prog: null, plumbing: true };
  if (OPEN_KW.has(first)) {
    const inner = stripKeywords(head);
    if (inner !== head) return programOfText(inner, depth + 1);
  }
  const script = shellScript(w);
  if (script !== null) return programOfText(script, depth + 1);
  const prog = base(first);
  if (/^['"$`(]/.test(first) && !/^(['"])[^'"$`]+\1$/.test(first)) return { prog: null, plumbing: false };
  if (shellOnly(prog)) return { prog, plumbing: true };
  if (!RUNNERS.has(prog)) return { prog, plumbing: false };
  const takes = VALUE_FLAGS[prog];
  for (let i = 1; i < w.length; i++) {
    const a = w[i]!;
    if (a.startsWith('-')) { if (takes?.has(a)) i++; continue; }
    // Quotes, a heredoc opener or a redirect: no second word.
    if (/^(?:['"$`]|\d*[<>]|&>)/.test(a)) break;
    return { prog: `${prog} ${base(a).slice(0, 24)}`, plumbing: false };
  }
  return { prog, plumbing: false };
}

/** The first segment's program that isn't plumbing (else the first plumbing one). */
export function programOfText(text: string, depth = 0): { prog: string | null; plumbing: boolean } {
  if (depth > MAX_DEPTH) return { prog: null, plumbing: false };
  const { segs } = scan(text);
  let firstPlumbing: string | null = null;
  for (const p of segs) {
    const r = segProgram(text, p, depth);
    if (!r.plumbing) return r;
    firstPlumbing ??= r.prog;
  }
  return { prog: firstPlumbing, plumbing: true };
}

/** Every simple command in `cmd`, in order: subshells, groups, loops and ifs opened up; heredoc bodies left out. */
export function simpleCommands(cmd: string, depth = 0): string[] {
  const s = String(cmd ?? '');
  if (depth > MAX_DEPTH) return [s];
  const out: string[] = [];
  for (const p of scan(s).segs) {
    if (p.group) {
      out.push(...simpleCommands(groupInner(s, p), depth + 1));
      continue;
    }
    const head = s.slice(p.start, p.end);
    if (OPEN_KW.has(words(head)[0] ?? '')) {
      for (const inner of keywordFree(head)) if (inner !== head) out.push(...simpleCommands(inner, depth + 1));
      continue;
    }
    out.push(head);
  }
  return out;
}

/** One simple command with its env prefixes and wrappers (time, nice, command, nohup, env, sudo, timeout, script -q /dev/null, !) dropped. */
export function bareCommand(simple: string): string {
  return programWords(String(simple ?? '')).join(' ');
}

/* --------------------------------------------- words only quoted text carries (the agent guard, D89) */

/** Programs that only read or print the text they are given (or read from a pipe), by their bare name: a path or a copy could be anything. No pager (`!` runs a shell). */
const TEXT_PROGRAMS = /^(?:grep|egrep|fgrep|rg|ag|echo|printf|cat|sed|awk|gawk|mawk|nawk|git|head|tail|wc|sort|uniq|cut|tr|nl|column)$/;
/** Words that change what a bare program name runs: an alias, a function, PATH. */
const RENAMES = /^(?:alias|function|hash|enable|builtin)$|^[\w.-]+\(\)|^PATH\+?=/;
/** awk that runs a command (`system(…)`, a pipe, getline, an extension), sed's `e` command or `s///e` flag; flags that run a program. */
const AWK_RUNS = /system|getline|\||@load/;
const RUNS_FLAG: Record<string, RegExp> = {
  rg: /^--(?:pre|hostname-bin)/,
  git: /^(?:-O|--open-files-in-pager)/,
  sort: /^--compress/,
  printf: /^-v/,
};
const SED_RUNS = /(?:^|[;\n{}])\s*[\d$,/]*\s*e(?:[\s;}]|$)|[/|#:,@!%][gpIiMmw\d]{0,8}e[gpIiMm\d]{0,8}\s*(?:[;}\n]|$)/;
const CAT_HEREDOC = /^\$\(\s*cat\s+<<-?[ \t]*(?:'(\w{1,64})'|"(\w{1,64})"|(\w{1,64}))[ \t]*\n/;

/**
 * `head` with each `$(cat <<'EOF' … EOF)` (the shape agents write commit
 * messages in) turned into `""`; null when any other substitution is left
 * (`$(…)`, a backtick, `<(…)`, `>(…)`) or a body would expand one. One pass.
 */
function withoutCatHeredocs(head: string): string | null {
  let out = '';
  let i = 0;
  for (;;) {
    const j = head.indexOf('$(', i);
    if (j < 0) { out += head.slice(i); break; }
    const m = CAT_HEREDOC.exec(head.slice(j, j + 160));
    if (!m) return null;
    const delim = (m[1] ?? m[2] ?? m[3])!;
    const bodyStart = j + m[0].length;
    let k = bodyStart;
    let end = -1;
    for (;;) {
      const nl = head.indexOf('\n', k);
      const lineEnd = nl < 0 ? head.length : nl;
      if (head.slice(k, lineEnd).replace(/^\t+/, '') === delim) { end = lineEnd; break; }
      if (nl < 0) break;
      k = nl + 1;
    }
    if (end < 0) return null;
    if (m[3] !== undefined && /\$\(|`/.test(head.slice(bodyStart, k))) return null;
    const close = /^\s*\)/.exec(head.slice(end, end + 64));
    if (!close) return null;
    out += `${head.slice(i, j)}""`;
    i = end + close[0].length;
  }
  return /`|[<>]\(/.test(out) ? null : out;
}

/** `head` with its quoted text ('…', "…", $'…') blanked: the words the shell splits on its own. One pass. */
function unquotedText(head: string): string {
  let out = '';
  for (let i = 0; i < head.length; i++) {
    const c = head[i]!;
    if (c === '\\') { out += head.slice(i, i + 2); i++; continue; }
    let j = -1;
    if (c === "'") j = head.indexOf("'", i + 1);
    else if (c === '$' && head[i + 1] === "'") { j = i + 2; while (j < head.length && head[j] !== "'") j += head[j] === '\\' ? 2 : 1; }
    else if (c === '"') { j = i + 1; while (j < head.length && head[j] !== '"') j += head[j] === '\\' ? 2 : 1; }
    else { out += c; continue; }
    out += ' ';
    i = j < 0 ? head.length : j;
  }
  return out;
}

/**
 * A segment's heredoc bodies run nothing: every opener quotes its word (`<<'EOF'`, so the body is literal text, its
 * backticks and `$(…)` too), or no body holds a substitution (fix-lab5).
 */
function literalBodies(head: string, bodies: string[]): boolean {
  if (!bodies.length) return true;
  const quoted = /<<-?\s*(['"])\w{1,64}\1/g;
  if (quoted.test(head) && !/<<-?\s*\w/.test(head.replace(quoted, ''))) return true;
  return !bodies.some((b) => /\$\(|`/.test(b));
}

/** The command without its literal heredoc bodies. */
function outsideLiterals(s: string, segs: Piece[]): string {
  let out = '';
  let at = 0;
  for (const p of segs) {
    if (!literalBodies(s.slice(p.start, p.end), p.bodies.length ? ['$('] : [])) continue;
    for (const [a, b] of p.bodies) {
      out += s.slice(at, a);
      at = b;
    }
  }
  return out + s.slice(at);
}

/** Whether one simple command that carries the text (or reads it from a pipe) leaves it unrun. */
type Quiet = <T>(head: string, bodies: string[], hitOf: (text: string) => T | null) => boolean;

/** One simple command that only reads or prints its quoted text, with nothing it is given run. */
function textProgram<T>(head: string, bodies: string[], hitOf: (text: string) => T | null): boolean {
  const plain = withoutCatHeredocs(head);
  if (plain === null || !literalBodies(plain, bodies)) return false;
  const w = words(plain);
  const prog = w[0] ?? '';
  if (!TEXT_PROGRAMS.test(prog)) return false;
  if (prog === 'git' && !/^(?:commit|log|grep)$/.test(w[1] ?? '')) return false;
  const runs = RUNS_FLAG[prog];
  if (runs && w.some((x) => runs.test(unquote(x)))) return false;
  if (/awk$/.test(prog) && AWK_RUNS.test(plain)) return false;
  if (prog === 'sed' && w.slice(1).some((x) => SED_RUNS.test(unquote(x)))) return false;
  return hitOf(unquotedText(plain)) === null;
}

/**
 * D89: where a word the agent may not run (`skills on`) sits in `cmd`.
 * `hitOf` says whether a piece of text carries it. Returns the hit of the
 * first simple command that runs it: the program or a word the shell splits
 * on its own (after `;`, `&&`, `|`, a wrapper, a renamed binary, a
 * variable), text given to a shell or an interpreter (`sh -c`, `eval`,
 * `| sh`, `python -c`, a heredoc into a shell), a substitution inside the
 * quotes, or anything a carrying command pipes into that isn't itself a
 * text program. Null when it sits only inside quoted arguments of text
 * programs (grep, rg, ag, git commit/log/grep, echo, printf, sed, awk
 * patterns, cat) or in a `$(cat <<'EOF' …)` body. `whole` is the answer
 * when no single command carries it, or past `MAX_DEPTH`. Linear: one scan
 * per nesting level.
 */
export function quotedTextHit<T>(cmd: string, hitOf: (text: string) => T | null, whole: T, depth = 0, quiet: Quiet = textProgram): T | null {
  if (depth > MAX_DEPTH) return whole;
  const s = String(cmd ?? '');
  const { segs } = scan(s);
  // A process substitution anywhere can be where the text goes (`exec > >(sh); echo "…"`); not one inside a literal
  // heredoc body (`<<'EOF'`: source text an interpreter edits, fix-lab5).
  if (/[<>]\(/.test(s) && /[<>]\(/.test(outsideLiterals(s, segs))) return whole;
  let fed = false;
  let carried = false;
  for (const p of segs) {
    const head = s.slice(p.start, p.end);
    const w = words(head);
    if (w.some((x) => RENAMES.test(x))) return whole;
    const bodies = p.bodies.map(([a, b]) => s.slice(a, b));
    const own = hitOf([head, ...bodies].join('\n'));
    if (own !== null || fed) {
      carried ||= own !== null;
      if (p.group) {
        const tail = s.slice(p.group.close < 0 ? p.end : p.group.close + 1, p.end);
        if (fed || (tail && hitOf(tail) !== null)) return own ?? whole;
        const inner = quotedTextHit(groupInner(s, p), hitOf, own ?? whole, depth + 1, quiet);
        if (inner !== null) return inner;
      } else if (!quiet(head, bodies, hitOf)) return own ?? whole;
    }
    fed = p.sep === '|' && (own !== null || fed);
  }
  return carried ? null : whole;
}

/* --------------------------------------------- files a command only reads (the hook-script guard, D116 item 2) */

/** Programs that only read the files they are named, by their bare name. Pagers too: what runs a shell there is typed at a terminal. */
const FILE_READERS = /^(?:grep|egrep|fgrep|rg|ag|cat|sed|less|more|head|tail|wc|nl|file|stat|ls|diff|cmp|shasum|sha1sum|sha256sum|md5|md5sum|od|hexdump|xxd|strings|sort|uniq|cut|tr|column|git)$/;
const GIT_READS = /^(?:log|show|diff|blame|grep|ls-files|status)$/;
/** An output redirect to anything but /dev/null or another descriptor: the read becomes a copy. */
const COPIES = /(?:^|[^<>&\d])\d*(?:&>>?|>>?\|?)\s*(?!\s|\/dev\/null(?:\s|$)|&\d)/;

/**
 * D116 item 2: one simple command that only reads the files it names (grep, sed without -i or `e`, cat, a pager,
 * head, tail, wc, git log/show/diff), with no substitution, no copy to a file and no flag that runs a program.
 * Given to `quotedTextHit` as its `quiet`, a name sits unrun as such a command's argument or in what it reads.
 */
export function readsFiles<T>(head: string, bodies: string[], _hitOf: (text: string) => T | null): boolean {
  const plain = withoutCatHeredocs(head);
  if (plain === null || !literalBodies(plain, bodies)) return false;
  const w = words(plain);
  const prog = w[0] ?? '';
  if (!FILE_READERS.test(prog)) return false;
  if (prog === 'git' && !GIT_READS.test(w[1] ?? '')) return false;
  if (prog === 'git' && w.some((x) => /^--(?:ext-diff|textconv)$/.test(unquote(x)))) return false;
  const runs = RUNS_FLAG[prog];
  if (runs && w.some((x) => runs.test(unquote(x)))) return false;
  if (prog === 'sed' && w.slice(1).some((x) => /^-[a-zA-Z]*i|^--in-place/.test(unquote(x)) || SED_RUNS.test(unquote(x)))) return false;
  if (prog === 'sort' && w.some((x) => /^(?:-[a-zA-Z]*o|--output)/.test(unquote(x)))) return false;
  if ((prog === 'less' || prog === 'more') && w.slice(1).some((x) => unquote(x).startsWith('+'))) return false;
  return !COPIES.test(unquotedText(plain));
}

/* --------------------------------------------- a hook script named, not run (the hook-script guard, fix-lab5) */

/** A hook script's name as code or prose writes it (`join(dir, '.claude', 'helpers', 'graft-hooks.cjs')`). */
const HOOK_IN_CODE = String.raw`(?:(?:trail|graft)-hooks?[\w-]{0,64}\.cjs|hooks?\.cjs|claude\/[\w-]{1,64}\.js)`;
const HOOK_NAMED = new RegExp(HOOK_IN_CODE, 'i');
/** Code that runs it: loaded (a require or a dynamic import of it), or handed to a child process or eval, inside the same call. */
const CODE_RUNS_HOOK = [
  new RegExp(String.raw`\b(?:require|import)\s*\(\s*[^)]{0,300}?${HOOK_IN_CODE}`, 'i'),
  new RegExp(String.raw`\b(?:spawn|spawnSync|exec|execSync|execFile|execFileSync|fork|execa|Popen|run|call|check_call|check_output|getoutput|system|popen|eval|run_path)\s*\(\s*[^)]{0,300}?${HOOK_IN_CODE}`, 'i'),
];
/** A shell line inside code (`'node .claude/helpers/trail-hooks.cjs stop'`): it runs when the code starts programs. */
const SHELL_LINE_RUNS_HOOK = new RegExp(String.raw`\b(?:node|nodejs|bun|deno|sh|bash|zsh|source)\s+[^\n;|&]{0,200}?${HOOK_IN_CODE}`, 'i');
/** Deleting, an existence test, git bookkeeping: what these do with a file never runs it. */
const NEVER_RUNS = /^(?:rm|unlink|rmdir|test|\[|\[\[)$/;
const GIT_KEEPS = /^(?:add|rm|checkout|restore|commit|check-ignore|ls-files|ls-tree|status|log|show|diff|blame|grep)$/;
/** `node --check`/`-c` only parses; any of these makes it run code too. */
const NODE_RUNS = /^(?:-e|-p|--eval|--print|-r|--require|--import|--loader|--experimental-loader)$/;

/** Text with its '…' parts removed: a `$(…)` or backtick left in it is a substitution the shell runs. */
function substitutes(text: string): boolean {
  return /\$\(|`|[<>]\(/.test(text.replace(/'[^']*'/g, "''"));
}

/** Whether code an interpreter is given (`node -e`, `python3 - <<EOF`) runs a hook script it names. */
function codeRunsHook(code: string): boolean {
  if (!HOOK_NAMED.test(code)) return false;
  return CODE_RUNS_HOOK.some((re) => re.test(code)) || (SCRIPT_STARTS.test(code) && SHELL_LINE_RUNS_HOOK.test(code));
}

/**
 * fix-lab5: one simple command that names a Trail hook script and leaves it unrun, as `quotedTextHit`'s quiet for the
 * hook-script guard. A read (readsFiles); deleting it or a stale copy (`rm`), an existence test, `node --check`, git
 * bookkeeping (add, checkout, commit …); code an interpreter is given that only edits text naming it (a python
 * heredoc that rewrites a source file); a heredoc written to another file (`cat >> notes.md <<EOF`). Never when the
 * shell substitutes something, a file is written to the hook (`cat > trail-hooks.cjs <<EOF`), or the code loads it or
 * hands it to a child process. `hookNamed` is how the guard names one (risk.ts HOOK_SCRIPT).
 */
export function hookUnrun<T>(head: string, bodies: string[], hitOf: (text: string) => T | null, hookNamed: (text: string) => boolean): boolean {
  if (readsFiles(head, bodies, hitOf)) return true;
  const plain = withoutCatHeredocs(head);
  if (plain === null || substitutes(plain)) return false;
  const w = programWords(plain);
  const prog = base(w[0] ?? '');
  const args = w.slice(1).map((x) => unquote(x));
  const quietBodies = literalBodies(plain, bodies);
  if (NEVER_RUNS.test(prog) || (prog === 'git' && GIT_KEEPS.test(args[0] ?? ''))) return !bodies.length && !writesFile(plain);
  if (/^node(?:js)?$/.test(prog) && args.some((a) => a === '--check' || a === '-c')) return !args.some((a) => NODE_RUNS.test(a)) && !bodies.length && !writesFile(plain);
  const inline = inlineScript(w);
  if (inline !== null) {
    // The code is text, unless it runs the hook; the interpreter's other words must not name one (a script, a -r).
    const others = w.filter((x) => unquote(x) !== inline).join(' ');
    return !hookNamed(others) && !codeRunsHook(inline) && !bodies.length && !writesFile(plain);
  }
  // Its program from a heredoc only: from a pipe (`cat trail-hooks.cjs | node -`) the program is the hook.
  if (bodies.length && heredocInterpreter(w)) return quietBodies && !hookNamed(plain) && !codeRunsHook(bodies.join('\n'));
  // A heredoc only written to a file that isn't a hook script: prose, a JSON config, source text. One that writes a
  // script running it (`cat > run.sh <<EOF` with `node …/trail-hooks.cjs stop` in it) is the run itself.
  if ((prog === 'cat' || prog === 'tee') && bodies.length) {
    const body = bodies.join('\n');
    const runs = HOOK_NAMED.test(body) && (CODE_RUNS_HOOK.some((re) => re.test(body)) || SHELL_LINE_RUNS_HOOK.test(body));
    const into = /(?:^|\s)(?:\d?>>?|tee(?:\s+-a)?)\s*(['"]?)([^\s'"]{1,400})\1/.exec(plain)?.[2] ?? '';
    return quietBodies && !hookNamed(plain) && (!runs || TEXT_FILE.test(into));
  }
  return false;
}

/** Files that hold text, never run as a script: what a heredoc writes into them only names a hook. */
const TEXT_FILE = /\.(?:md|txt|json|jsonl|ya?ml|toml|ts|tsx|html|csv|log)$/i;
