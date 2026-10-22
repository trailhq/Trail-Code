/**
 * The lexer under `shell.ts`: one pass over a command that finds its
 * top-level segments the way the shell would. Quotes, `$'…'`, `$(…)`,
 * `$((…))`, backticks, `${…}`, `(…)` subshells, `{ …; }` groups, `[[ … ]]`,
 * comments, and loops and ifs (when asked) are opaque; a heredoc body is
 * skipped as text and, at the top level, belongs to the segment whose line
 * opened it. Ranges into the original text are returned, so callers can cut
 * a command without retyping any of it.
 *
 * The PreToolUse fast path loads this file through `shell.ts`: it imports
 * nothing.
 */

export type Sep = '&&' | '||' | ';' | '|' | '&' | '';
/** One top-level segment, as ranges of the original text. */
export interface Piece {
  start: number; end: number; sep: Sep; nl: boolean;
  /** Heredoc bodies that sit after the line this segment ended on. */
  bodies: Array<[number, number]>;
  /** The segment starts with a subshell or group: where it opens and closes. */
  group: { open: number; close: number } | null;
}
export interface Scan { segs: Piece[]; heredoc: boolean; newline: boolean; keep: Array<[number, number]> }

export const OPEN_KW = new Set(['for', 'while', 'until', 'if', 'case', 'select']);
const CLOSE_KW = new Set(['done', 'fi', 'esac']);
const MID_KW = new Set(['do', 'then', 'else', 'elif', '!']);
const HEREDOC_OPEN = /^<<([-~]?)[ \t]*(?:'([^'\n]*)'|"([^"\n]*)"|\\?([^\s;&|<>()'"`]+))/;

/**
 * The one scanner. `compounds`: a loop or an if is one segment (false splits
 * inside them, to look at what they run).
 */
export function scan(s: string, compounds = true): Scan {
  const segs: Piece[] = [];
  const keep: Array<[number, number]> = [];
  const stack: string[] = [];
  const pending: Array<{ delim: string; strip: boolean; owner: number | null }> = [];
  let cur: Piece | null = null;
  let compound = 0;
  let cmdStart = true;
  let sawNl = false;
  let heredoc = false;
  let newline = false;
  const close = (sep: Sep, nl: boolean) => {
    if (!cur) return;
    cur.sep = sep;
    cur.nl = nl;
    segs.push(cur);
    cur = null;
  };
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    const ctx = stack.length ? stack[stack.length - 1]! : '';
    if (c === '\n' && ctx !== '"' && ctx !== '`') {
      const atTop = ctx === '' && compound === 0;
      if (atTop) close(';', true);
      sawNl = true;
      cmdStart = true;
      if (!pending.length) continue;
      heredoc = true;
      let j = i + 1;
      let last = i;
      for (const h of pending) {
        const bodyStart = j;
        let end = s.length;
        while (j < s.length) {
          const nl = s.indexOf('\n', j);
          const lineEnd = nl < 0 ? s.length : nl;
          const line = s.slice(j, lineEnd);
          // <<- strips leading tabs only, as bash and zsh do.
          if ((h.strip ? line.replace(/^\t+/, '') : line).replace(/\r$/, '') === h.delim) { end = lineEnd; break; }
          j = nl < 0 ? s.length : nl + 1;
        }
        if (atTop && h.owner !== null) (segs[h.owner] ?? cur)?.bodies.push([bodyStart, end]);
        last = end;
        j = end + 1;
      }
      if (atTop) keep.push([i, last]);
      pending.length = 0;
      i = last - 1;
      continue;
    }
    if (c === ' ' || c === '\t' || c === '\r') continue;
    if (ctx === '') {
      let sep: Sep | null = null;
      let len = 1;
      if (c === '&' && s[i + 1] === '&') { sep = '&&'; len = 2; }
      else if (c === '|' && s[i + 1] === '|') { sep = '||'; len = 2; }
      else if (c === '|' && s[i - 1] !== '>') { sep = '|'; len = s[i + 1] === '&' ? 2 : 1; }
      else if (c === ';') { sep = ';'; len = s[i + 1] === ';' ? 2 : 1; }
      else if (c === '&' && s[i + 1] !== '>' && s[i - 1] !== '>' && s[i - 1] !== '<') sep = '&';
      if (sep !== null) {
        if (compound === 0) close(sep, false);
        i += len - 1;
        cmdStart = true;
        continue;
      }
    }
    if (sawNl) newline = true;
    if (!cur) cur = { start: i, end: i, sep: '', nl: false, bodies: [], group: null };
    const seg: Piece = cur;
    const was = cmdStart;
    cmdStart = false;
    if (ctx === '"') {
      if (c === '\\') i++;
      else if (c === '"') stack.pop();
      else if (c === '`') stack.push('`');
      else if (c === '$' && s[i + 1] === '(') {
        stack.push(s[i + 2] === '(' ? 'A' : '(');
        i += s[i + 2] === '(' ? 2 : 1;
      } else if (c === '$' && s[i + 1] === '{') { stack.push('$'); i++; }
      seg.end = i + 1;
      continue;
    }
    if (c === '\\') {
      i++;
    } else if (c === "'") {
      const q = s.indexOf("'", i + 1);
      i = q < 0 ? s.length - 1 : q;
    } else if (c === '$' && s[i + 1] === "'") {
      let j = i + 2;
      while (j < s.length && s[j] !== "'") j += s[j] === '\\' ? 2 : 1;
      i = Math.min(j, s.length - 1);
    } else if (c === '"') {
      stack.push('"');
    } else if (c === '`') {
      if (ctx === '`') stack.pop();
      else stack.push('`');
    } else if (c === '$' && s[i + 1] === '(' && s[i + 2] === '(') {
      stack.push('A');
      i += 2;
    } else if (c === '$' && s[i + 1] === '(') {
      stack.push('(');
      i++;
    } else if (c === '$' && s[i + 1] === '{') {
      stack.push('$');
      i++;
    } else if (c === '(') {
      if (stack.length === 0 && seg.start === i) seg.group = { open: i, close: -1 };
      stack.push('(');
      cmdStart = true;
    } else if (c === ')') {
      if (ctx === 'A' && s[i + 1] === ')') { stack.pop(); i++; }
      else if (ctx === '(') stack.pop();
      if (stack.length === 0 && seg.group && seg.group.close < 0) seg.group.close = i;
    } else if (c === '{' && was && /\s/.test(s[i + 1] ?? '')) {
      if (stack.length === 0 && seg.start === i) seg.group = { open: i, close: -1 };
      stack.push('{');
      cmdStart = true;
    } else if (c === '}' && (ctx === '$' || (ctx === '{' && /[\s;&]/.test(s[i - 1] ?? '')))) {
      stack.pop();
      if (stack.length === 0 && seg.group && seg.group.close < 0) seg.group.close = i;
    } else if (c === '[' && s[i + 1] === '[' && was && /\s/.test(s[i + 2] ?? '')) {
      stack.push('[');
      i++;
    } else if (c === ']' && s[i + 1] === ']' && ctx === '[') {
      stack.pop();
      i++;
    } else if (c === '#' && (i === 0 || /[\s;&|(]/.test(s[i - 1]!)) && ctx !== 'A' && ctx !== '$') {
      const nl = s.indexOf('\n', i);
      i = (nl < 0 ? s.length : nl) - 1;
    } else if (c === '<' && s[i + 1] === '<' && s[i + 2] !== '<' && s[i - 1] !== '<' && ctx !== 'A' && ctx !== '[') {
      const m = HEREDOC_OPEN.exec(s.slice(i));
      if (m) {
        pending.push({ delim: m[2] ?? m[3] ?? m[4]!, strip: m[1] !== '', owner: stack.length === 0 && compound === 0 ? segs.length : null });
        i += m[0].length - 1;
      } else i++;
    } else if (stack.length === 0 && was) {
      // A keyword only counts where a command starts.
      const word = /^(?:[a-z]+|!)/.exec(s.slice(i, i + 7))?.[0] ?? '';
      const kw = word && /^[\s;&|)]|^$/.test(s[i + word.length] ?? '') ? word : '';
      if (compounds && OPEN_KW.has(kw)) { compound++; cmdStart = true; i += kw.length - 1; }
      else if (compounds && compound > 0 && CLOSE_KW.has(kw)) { compound--; i += kw.length - 1; }
      else if (MID_KW.has(kw)) { cmdStart = true; i += kw.length - 1; }
    }
    seg.end = Math.min(i + 1, s.length);
  }
  close('', false);
  const last = segs[segs.length - 1];
  if (last && last.sep !== '&') last.sep = '';
  return { segs, heredoc, newline, keep };
}

/** A piece's head text plus its detached heredoc bodies. */
export function pieceText(s: string, p: Piece): string {
  return [s.slice(p.start, p.end), ...p.bodies.map(([a, b]) => s.slice(a, b))].join('\n');
}

/**
 * `s` with `ranges` removed, except what `keep` protects (heredoc bodies and
 * the newline before them), trimmed.
 */
export function cut(s: string, ranges: Array<[number, number]>, keep: Array<[number, number]>): string {
  const drop = new Uint8Array(s.length);
  for (const [a, b] of ranges) for (let i = Math.max(0, a); i < Math.min(b, s.length); i++) drop[i] = 1;
  for (const [a, b] of keep) for (let i = Math.max(0, a); i <= Math.min(b, s.length - 1); i++) drop[i] = 0;
  let out = '';
  for (let i = 0; i < s.length; i++) if (!drop[i]) out += s[i];
  return out.trim();
}

/** Words of one segment's head, split on unquoted spaces; quotes kept; a `#` comment is not a word. */
export function words(text: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < text.length) {
    // A backslash-newline joins lines: space between words.
    while (i < text.length && (/\s/.test(text[i]!) || (text[i] === '\\' && text[i + 1] === '\n'))) i += text[i] === '\\' ? 2 : 1;
    if (i >= text.length) break;
    if (text[i] === "#") {
      const nl = text.indexOf("\n", i);
      if (nl < 0) break;
      i = nl;
      continue;
    }
    const start = i;
    let depth = 0;
    for (; i < text.length; i++) {
      const c = text[i]!;
      if (c === '\\' && text[i + 1] === '\n' && depth === 0) break;
      if (c === '\\') { i++; continue; }
      if (c === "'") { const q = text.indexOf("'", i + 1); i = q < 0 ? text.length : q; continue; }
      if (c === '"') { let j = i + 1; while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1; i = j; continue; }
      if (c === '(' || c === '{') depth++;
      else if ((c === ')' || c === '}') && depth > 0) depth--;
      else if (depth === 0 && /\s/.test(c)) break;
    }
    out.push(text.slice(start, i));
  }
  return out;
}

export const unquote = (w: string) => w.replace(/^(['"])([\s\S]*)\1$/, '$2');
export const base = (w: string) => unquote(w).replace(/\/+$/, '').split('/').pop() ?? '';
export const ASSIGN = /^[A-Za-z_][A-Za-z0-9_]*=/;

