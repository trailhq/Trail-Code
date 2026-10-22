/**
 * The tamper check's reading of program code (design 4.1, split from
 * `tamper.ts`): whether code an interpreter runs hands a protected path to a
 * call that writes it, and where that code comes from (`-c`/`-e`, a heredoc,
 * a here-string, or the pipeline feeding its stdin). A literal path is judged
 * by the caller (`guardedLiteral`); a home folder joined with `.trail` or the
 * host's transcripts folder is judged here.
 */
import { unquote } from './shell-scan.js';

export const SHELLS = /^(?:ba|z|da)?sh$/;
const HOME_REF = /\b(?:homedir\(\)|Path\.home\(\)|expanduser\(|environ(?:\.get\(|\[)\s*['"]HOME|process\.env\.HOME\b|getenv\(\s*['"]HOME|ENV\[\s*['"]HOME|Dir\.home\b|ENV\{\s*['"]?HOME)/;
const TRAIL_PART = /['"`/]\.trail(?![\w.-])/;
/** The host's transcripts joined onto a home folder, outside a project's memory/ folder (Claude Code's own notes). */
const PROJECTS_PART = /['"`/]\.claude\/projects\b(?![^'"`\n]*\/memory\/)/;
const TRAIL_ENV = /\b(?:environ(?:\.get\(|\[)\s*['"]TRAIL_HOME|process\.env\.TRAIL_HOME\b|getenv\(\s*['"]TRAIL_HOME|ENV\[\s*['"]TRAIL_HOME)/;
const ASSIGNMENT = /^\s*(?:(?:const|let|var|my|local)\s+)?\$?([A-Za-z_]\w*)\s*(?::\s*[\w.[\]]+\s*)?=(?!=)\s*([^\n]+)$/;
/** Calls that build a path around what they are given: `Path(`, `os.path.expanduser(`, `path.join(`. */
const WRAPS = String.raw`^\s*(?:(?:[\w.]+\.)?(?:Path|PurePath|expanduser|expandvars|abspath|realpath|join|resolve|expand_path|normpath)\(\s*)*`;
const PATHY_LITERAL = new RegExp(`${WRAPS}[frbFRB]?(['"\`])((?:(?!\\1)[^\\\\\\n]|\\\\.)*)\\1`);
/** A path expression that starts from a variable: `os.path.join(base, 'x')`, `root / 'runs'`. */
const HELD_FROM = new RegExp(`${WRAPS}([A-Za-z_]\\w*)\\b`);
/** What may follow the path in a path expression: closing parens, joins, more parts; never a read or a parse. */
const PATH_REST = /^(?:[\s)/+,\w]|\.(?:resolve|expanduser|absolute)\(\)|'[^'\n]*'|"[^"\n]*")*$/;

/** Calls whose path argument(s) they write: `first` arg, both of the first `two` (copy, move), or a write `mode`. */
const ARG_CALLS: Array<[RegExp, 'first' | 'two' | 'mode']> = [
  [/\b(?:open|fopen|openSync)\(/g, 'mode'],
  [/\b(?:writeFile|appendFile|createWriteStream|outputFile|writeJson|truncate|rmSync|rmdir|unlink|mkdir|makedirs|removedirs|remove|rmtree|to_csv|to_json|to_parquet|to_excel)(?:Sync)?\(/g, 'first'],
  [/\b(?:fs|fsp|promises)\.rm\(/g, 'first'],
  [/\bFile\.(?:write|delete|unlink)\(/g, 'first'],
  [/\b(?:rename|renameSync|copyFile|copyFileSync|cpSync|copy|copy2|copyfile|copytree|move|symlink|symlinkSync|link)\(/g, 'two'],
  [/\b(?:fs|fsp|promises)\.cp\(|\bos\.replace\(|\bFileUtils\.\w+\(/g, 'two'],
];
/** Methods that write their receiver: `Path(x).write_text(...)`. */
const RECEIVER_CALLS = /\.(?:write_text|write_bytes|unlink|touch|mkdir|rmdir|rename|open)\(/g;
const WRITE_MODE = /^\s*(?:mode\s*=\s*)?[rbuf]?['"][^'"]*[wax+]/;

/** The arguments of the call whose `(` is at `open`, split at top-level commas (at most 2000 characters read). */
function callArgs(code: string, open: number): string[] {
  const out: string[] = [];
  let depth = 0;
  let from = open + 1;
  const end = Math.min(code.length, open + 2000);
  for (let i = open + 1; i < end; i++) {
    const c = code[i]!;
    if (c === '"' || c === "'" || c === '`') {
      for (i++; i < end && code[i] !== c; i++) if (code[i] === '\\') i++;
      continue;
    }
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') {
      if (depth === 0) { out.push(code.slice(from, i)); return out; }
      depth--;
    } else if (c === ',' && depth === 0) {
      out.push(code.slice(from, i));
      from = i + 1;
    }
  }
  out.push(code.slice(from, end));
  return out;
}

/** The expression a method is called on: `Path(x)`, `(home / '.trail')`, `p`. */
function receiverBefore(code: string, dot: number): string {
  let j = dot - 1;
  while (j >= 0) {
    const c = code[j]!;
    if (c === ')' || c === ']') {
      let depth = 0;
      for (; j >= 0; j--) {
        if (code[j] === ')' || code[j] === ']') depth++;
        else if ((code[j] === '(' || code[j] === '[') && --depth === 0) break;
      }
      j--;
    } else if (/[\w.$]/.test(c)) j--;
    else break;
  }
  return code.slice(j + 1, dot);
}

/** Program code that hands a guarded path to a call that writes it. `guardedLiteral`: a string literal names one. */
export function codeWrites(code: string, guardedLiteral: (literal: string) => boolean): boolean {
  const pathy = (text: string) => {
    const m = PATHY_LITERAL.exec(text);
    const v = m?.[2];
    if (v && PATH_REST.test(text.slice(m!.index + m![0].length)) && guardedLiteral(v)) return true;
    return (HOME_REF.test(text) && (TRAIL_PART.test(text) || PROJECTS_PART.test(text))) || TRAIL_ENV.test(text);
  };
  // Variables set to a guarded path, or a path built from one (assignments in order, twice for a late one).
  const held = new Set<string>();
  const statements = code.split(/\n|;/);
  for (let pass = 0; pass < 2; pass++) {
    for (const s of statements) {
      const m = ASSIGNMENT.exec(s);
      if (!m || held.has(m[1]!)) continue;
      const value = m[2]!;
      const from = HELD_FROM.exec(value);
      if (pathy(value) || (from !== null && held.has(from[1]!) && PATH_REST.test(value.slice(from[0].length)))) held.add(m[1]!);
    }
  }
  const mentionsHeld = (arg: string) => held.size > 0 && (arg.match(/[A-Za-z_]\w*/g) ?? []).some((id) => held.has(id));
  const target = (arg: string | undefined) => arg !== undefined && (pathy(arg) || mentionsHeld(arg));
  for (const [re, which] of ARG_CALLS) {
    for (const m of code.matchAll(re)) {
      const args = callArgs(code, m.index! + m[0].length - 1);
      if (which === 'mode' ? args.slice(1).some((a) => WRITE_MODE.test(a)) && target(args[0]) : target(args[0]) || (which === 'two' && target(args[1]))) return true;
    }
  }
  for (const m of code.matchAll(RECEIVER_CALLS)) {
    if (m[0] === '.open(' && !callArgs(code, m.index! + m[0].length - 1).some((a) => WRITE_MODE.test(a))) continue;
    if (target(receiverBefore(code, m.index!))) return true;
  }
  return false;
}

/** Flags whose next word is the program, per interpreter family. */
function codeFlag(prog: string, a: string): boolean {
  if (SHELLS.test(prog)) return /^-[a-z]*c$/.test(a);
  if (/^python/.test(prog)) return a === '-c';
  if (prog === 'php') return a === '-r';
  if (prog === 'ruby' || prog === 'perl') return a === '-e' || a === '-E';
  return a === '-e' || a === '--eval' || a === '-p' || a === '--print';
}

/** A redirect whose target is the next word (`>`, `2>`, `<<`), not one written onto it (`>out.txt`). */
const BARE_REDIRECT = /^(?:\d+|&)?(?:>>?|>\||<<?|<>|&>>?)$/;

/**
 * The code an interpreter or shell runs from its own words (`-c`, `-e`), else from its stdin: a here-string, its
 * heredoc bodies, or what the pipeline's earlier stages hand it (`piped`, g5 review); null when it runs a file.
 */
export function programCode(prog: string, w: string[], bodies: string[], piped: string | null = null): string | null {
  const parts: string[] = [];
  let script = false;
  let here: string | null = null;
  for (let i = 1; i < w.length; i++) {
    const a = w[i]!;
    if (a.startsWith('<<<')) {
      here = unquote(a.length > 3 ? a.slice(3) : (w[++i] ?? ''));
      continue;
    }
    if (/^(?:\d*[<>]|&>)/.test(a)) {
      if (BARE_REDIRECT.test(a)) i++;
      continue;
    }
    if (codeFlag(prog, a) && w[i + 1] !== undefined) parts.push(unquote(w[++i]!));
    else if (!a.startsWith('-')) script = true;
  }
  if (parts.length) return parts.join('\n');
  if (script) return null;
  const stdin = [here, ...bodies, piped].filter((x): x is string => !!x);
  return stdin.length ? stdin.join('\n') : null;
}
