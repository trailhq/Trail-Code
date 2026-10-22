/**
 * zsh-no-match, narrowed (D147). zsh says "no matches found: WORD" for any
 * unquoted glob that matches no file, and for a filesystem path given to a
 * file-handling command (ls, rm, cp, mv, du, wc, cat, a for-in list ...)
 * that is the right answer: the files aren't there, and quoting the glob
 * fixes nothing. The labels found half the matches were that shape.
 *
 * The wall is real only when the word zsh names was never meant as a file
 * glob, so quoting it makes the command work:
 *   - a flag's value: `--include=*.ts`, or `--include *.ts`, `find -name *.ts`,
 *     `rg -g *.go` as two words;
 *   - a URL, or a `?key=` query argument (`gh api repos/x?per_page=100`);
 *   - a pathspec or `ref:path` given to git grep, git log or git diff;
 *   - a grep or rg pattern argument (`grep 2026[34]`, `grep -e foo.*`).
 * The word is found by matching the error's WORD against each candidate word
 * of the command, its expansions (`$VAR`, `${...}`, `$(...)`, `~`) read as
 * anything. An error that ties to no such word is no hit.
 *
 * Pure. Runs only after the zsh pattern matched (at most 8 KB of output, a
 * command of at most 64 KB).
 */
import { base } from './shell-scan.js';
import { VALUE_FLAGS, programWords, simpleCommands } from './shell-words.js';
import { quotedAt } from './walls-quoted.js';

/** zsh's own line (the wall's pattern), with the word it names. */
const NO_MATCH = /^(?:(?:\/[\w./-]*\/)?zsh|\(eval\)):\d*:? no matches found: (.+)$/gm;
const MAX_WORDS = 32;
const MAX_WORD = 2048;
const MAX_ANY = 6;

/** Flags whose next word is a glob pattern, for every program (rsync, tar, grep ...). */
const PATTERN_FLAGS = new Set(['--include', '--exclude', '--exclude-dir', '--glob', '--iglob']);
/** Per program: flags whose next word is a pattern (find's tests, rg's -g). */
const PATTERN_FLAGS_OF: Record<string, ReadonlySet<string>> = {
  find: new Set(['-name', '-iname', '-path', '-ipath', '-wholename', '-iwholename', '-regex', '-iregex', '-lname', '-ilname']),
  rg: new Set(['-g']),
};
const GREPS = new Set(['grep', 'egrep', 'fgrep', 'zgrep', 'rg']);
/** grep and rg flags that take the next word as a value (so it isn't the pattern). */
const GREP_VALUES = new Set([
  '-A', '-B', '-C', '-m', '-d', '-D', '--include', '--exclude', '--exclude-dir', '--label', '--max-count', '--context',
  '--after-context', '--before-context', '--binary-files', '--devices', '--directories',
]);
const RG_VALUES = new Set([
  '-A', '-B', '-C', '-m', '-g', '-t', '-T', '-j', '-M', '-E', '-r', '-d', '--glob', '--iglob', '--type', '--type-not',
  '--max-count', '--max-depth', '--replace', '--sort', '--sortr', '--colors', '--encoding', '--context', '--after-context',
  '--before-context', '--threads', '--max-columns', '--type-add', '--pre', '--pre-glob', '--ignore-file', '--path-separator',
]);
const GIT_SUBS = new Set(['grep', 'log', 'diff']);
const WRAPPERS = new Set(['noglob', 'caffeinate', 'nohup', 'exec', 'xargs']);
const REDIRECT = /^(?:\d*[<>]|&>)/;

const esc = (c: string) => c.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

/** The index after the bracket that closes the one at `i` (`(` or `{`), or the end. */
function closeOf(w: string, i: number): number {
  const open = w[i]!, close = open === '(' ? ')' : '}';
  let depth = 0;
  for (let j = i; j < w.length; j++) {
    if (w[j] === '\\') { j++; continue; }
    if (w[j] === open) depth++;
    else if (w[j] === close && --depth === 0) return j + 1;
  }
  return w.length;
}

/**
 * A word as zsh would print it in its error: quotes gone, expansions as `.*`, glob characters literal. `glob` says
 * whether the word holds an unquoted glob character (only those make zsh's error). Null for a word too long to read.
 */
export function wordShape(w: string): { re: RegExp; glob: boolean } | null {
  if (w.length > MAX_WORD) return null;
  let src = '';
  let glob = false;
  const any = () => { if (!src.endsWith('.*')) src += '.*'; };
  for (let i = 0; i < w.length;) {
    const c = w[i]!;
    if (c === "'") {
      const q = w.indexOf("'", i + 1);
      const end = q < 0 ? w.length : q;
      src += esc(w.slice(i + 1, end));
      i = end + 1;
    } else if (c === '"') {
      let j = i + 1;
      while (j < w.length && w[j] !== '"') {
        const d = w[j]!;
        if (d === '\\' && j + 1 < w.length) { src += esc(w[j + 1]!); j += 2; }
        else if (d === '$' && (w[j + 1] === '(' || w[j + 1] === '{')) { any(); j = closeOf(w, j + 1); }
        else if (d === '$' && /\w/.test(w[j + 1] ?? '')) { any(); j += 1 + /^\w+/.exec(w.slice(j + 1))![0].length; }
        else if (d === '`') { any(); const b = w.indexOf('`', j + 1); j = b < 0 ? w.length : b + 1; }
        else { src += esc(d); j++; }
      }
      i = j + 1;
    } else if (c === '\\') {
      src += esc(w[i + 1] ?? '');
      i += 2;
    } else if (c === '$' && (w[i + 1] === '(' || w[i + 1] === '{')) {
      any();
      i = closeOf(w, i + 1);
    } else if (c === '$' && /[\w#?@*!$-]/.test(w[i + 1] ?? '')) {
      any();
      i += /\w/.test(w[i + 1]!) ? 1 + /^\w+/.exec(w.slice(i + 1))![0].length : 2;
    } else if (c === '`') {
      any();
      const b = w.indexOf('`', i + 1);
      i = b < 0 ? w.length : b + 1;
    } else if (c === '~' && (i === 0 || /[=:]/.test(w[i - 1]!))) {
      any();
      i++;
    } else if (c === '{' && /^\{[^{}\s]*(?:,|\.\.)[^{}\s]*\}/.test(w.slice(i))) {
      any();
      i = closeOf(w, i);
    } else {
      if (c === '*' || c === '?' || c === '[') glob = true;
      src += esc(c);
      i++;
    }
  }
  // Each expansion is a `.*`; past a few, a non-matching error line could backtrack for long.
  if ((src.match(/\.\*/g) ?? []).length > MAX_ANY) return null;
  return { re: new RegExp(`^${src}$`), glob };
}

/** The program words of a simple command, through env, sudo, timeout, time, noglob, xargs and the like. */
function bare(simple: string): string[] {
  let w = programWords(simple);
  for (let n = 0; n < 8 && w.length && WRAPPERS.has(w[0]!); n++) {
    let i = 1;
    if (w[0] === 'xargs') while (i < w.length && w[i]!.startsWith('-')) i++;
    w = programWords(w.slice(i).join(' '));
  }
  return w;
}

/** Indices of a grep or rg command's pattern words. */
function grepPatterns(w: string[], prog: string): Set<number> {
  const values = prog === 'rg' ? RG_VALUES : GREP_VALUES;
  const out = new Set<number>();
  let explicit = false;
  let positional = -1;
  let ended = false;
  for (let i = 1; i < w.length; i++) {
    const a = w[i]!;
    if (!ended && a === '--') { ended = true; continue; }
    if (!ended && a.startsWith('-') && a.length > 1) {
      if (a === '-e' || a === '--regexp') { explicit = true; out.add(i + 1); i++; continue; }
      if (/^(?:-e.|--regexp=)/.test(a)) { explicit = true; out.add(i); continue; }
      if (a === '-f' || a === '--file' || a.startsWith('--file=')) { explicit = true; if (a === '-f' || a === '--file') i++; continue; }
      if (values.has(a)) i++;
      continue;
    }
    if (REDIRECT.test(a)) continue;
    if (positional < 0) positional = i;
  }
  if (!explicit && positional > 0) out.add(positional);
  return out;
}

/** The index of git's subcommand (after -C dir, -c k=v, --no-pager ...), or -1. */
function gitSub(w: string[]): number {
  const takes = VALUE_FLAGS.git!;
  for (let i = 1; i < w.length; i++) {
    if (!w[i]!.startsWith('-')) return i;
    if (takes.has(w[i]!)) i++;
  }
  return -1;
}

/** The words of one simple command that zsh's error may name and that make it a real wall (see the header). */
function candidates(simple: string, out: RegExp[]): void {
  const w = bare(simple);
  if (w.length < 2) return;
  const prog = base(w[0]!);
  const greps = GREPS.has(prog) ? grepPatterns(w, prog) : null;
  const sub = prog === 'git' ? gitSub(w) : -1;
  const gitPaths = sub > 0 && GIT_SUBS.has(w[sub]!);
  const progFlags = PATTERN_FLAGS_OF[prog];
  for (let i = 1; i < w.length && out.length < MAX_WORDS; i++) {
    const a = w[i]!;
    if (!/[*?[]/.test(a)) continue;
    const shape = wordShape(a);
    if (!shape?.glob) continue;
    const prev = w[i - 1]!;
    const hit = /^--?[A-Za-z][\w-]*=[^*?[]*[*?[]/.test(a) && !/^['"]/.test(a) // a flag's value: --include=*.ts
      || PATTERN_FLAGS.has(prev) || !!progFlags?.has(prev) // --include *.ts, find -name *.ts, rg -g *.go
      || a.includes('://') || /\?[\w.%-]+=/.test(a) // a URL or a ?key= query
      || (gitPaths && i > sub) // git grep/log/diff pathspec or ref:path
      || !!greps?.has(i); // grep/rg pattern
    if (hit) out.push(shape.re);
  }
}

/** True when a zsh "no matches found" line in `ends` (not quoted) names a word of `command` that makes it a real wall. */
export function globWallTied(ends: string, command: string): boolean {
  const named: string[] = [];
  NO_MATCH.lastIndex = 0;
  let m: RegExpExecArray | null;
  for (let n = 0; n < 16 && (m = NO_MATCH.exec(ends)); n++) if (!quotedAt(ends, m.index)) named.push(m[1]!.trim());
  if (!named.length) return false;
  const shapes: RegExp[] = [];
  for (const s of simpleCommands(command)) {
    candidates(s, shapes);
    if (shapes.length >= MAX_WORDS) break;
  }
  return shapes.some((re) => named.some((x) => re.test(x)));
}
