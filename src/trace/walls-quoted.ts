/**
 * Quoted output (D147): a wall's error text that sits inside quoted or
 * JSON-escaped output is something printed, not something hit. The labels
 * found it as a driver command printing another session's record (`$ [Bash]
 * cmd` then `   -> output`, indented), and the same error can arrive as a
 * JSON string (`"content":"...\nCannot connect ..."`) or a quoted value.
 *
 * Read at the error's own place in the result window:
 *   - on its line, an odd count of unescaped `"` before it (inside a JSON or
 *     shell string), a JSON escape before it (`\n`, `\"`: the newline is text,
 *     so this is one long string, not a line), or a single quote or backtick
 *     opening right before it (`'rootless Docker not found'`);
 *   - the line, or the block it is indented under, starting with a record or
 *     quote marker (`->`, `>`, `│`).
 * A real line, even an indented one under a test runner's `--- FAIL`, has
 * none of these. Pure, bounded by the window (8 KB) and MAX_BACK lines.
 */

/** A printed record's or quote's lead: `-> out`, `> quoted`, `│ boxed`. */
const MARKER = /^\s*(?:->|>|│)(?:\s|$)/;
/** JSON escapes that mean the "line" is the inside of one string. */
const ESCAPED = /\\(?:n|r|"|u00)/;
/** A single quote or backtick that opens right before the error (a closing one follows a word: `'a.tar': No space`). */
const OPENS = /(?:^|[\s:=(\[{,])['`]$/;
/** How far up an indented block is followed to its head. */
const MAX_BACK = 64;

const indentOf = (line: string) => /^[ \t]*/.exec(line)![0].length;

/** Unescaped `"` in s. */
function dquotes(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\') i++;
    else if (s[i] === '"') n++;
  }
  return n;
}

/** True when the text at `at` in `text` is inside quoted or JSON-escaped output. */
export function quotedAt(text: string, at: number): boolean {
  const start = text.lastIndexOf('\n', at - 1) + 1;
  const prefix = text.slice(start, at);
  if (dquotes(prefix) % 2 === 1 || ESCAPED.test(prefix) || OPENS.test(prefix)) return true;
  const end = text.indexOf('\n', at);
  const line = text.slice(start, end < 0 ? text.length : end);
  if (MARKER.test(line)) return true;
  // The head of the indented block this line sits in: the nearest line above with less indent.
  let indent = indentOf(line);
  let pos = start - 1;
  for (let n = 0; indent > 0 && pos > 0 && n < MAX_BACK; n++) {
    const s = text.lastIndexOf('\n', pos - 1) + 1;
    const above = text.slice(s, pos);
    pos = s - 1;
    if (!above.trim()) continue;
    const ind = indentOf(above);
    if (ind >= indent) continue;
    if (MARKER.test(above)) return true;
    indent = ind;
  }
  return false;
}

/**
 * The first match of `re` in `text` whose error text is not quoted, or null. The error's place is the match's start
 * after a leading `: ` (enospc's `(?:^|: )`). At most `max` matches are read.
 */
export function unquotedMatch(re: RegExp, text: string, max = 64): RegExpExecArray | null {
  const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
  let m: RegExpExecArray | null;
  for (let n = 0; n < max && (m = g.exec(text)); n++) {
    if (!quotedAt(text, m.index + /^[:\s]*/.exec(m[0])![0].length)) return m;
    if (m[0] === '') g.lastIndex++;
  }
  return null;
}
