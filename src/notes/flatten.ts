/**
 * One line of text, for anything a learning carries into what an agent or a
 * person reads.
 *
 * A learning's title, author and section leads come from whoever wrote the
 * file, a teammate's unmerged branch included. A newline in a title used to
 * print as a line of its own, and a line that starts `[trail] ...` reads
 * exactly like trail's own instructions. So every such field goes through
 * `flatLine` on its way out: breaks collapse to spaces, a `[trail]`-style
 * marker at the start or after a collapsed break is dropped, invisible and
 * control characters go (they can hide a marker or rewrite a terminal), and
 * the line is capped.
 *
 * The hooks shim committed into repos runs as plain Node and can't import
 * this, so `FLAT_LINE_JS` is the same function as source text, and a test
 * holds the two to the same output.
 */

/**
 * Characters nobody sees: every Unicode format character (zero-width ones,
 * direction marks and overrides, the soft hyphen, tag characters that can
 * spell out text only an agent reads) and the variation selectors.
 */
const INVISIBLE = /[\p{Cf}\ufe00-\ufe0f\u{e0100}-\u{e01ef}]/gu;
/** Control characters other than tab and the line breaks below (ESC, BEL, DEL, C1 but NEL). */
const CONTROL = /[\u0000-\u0008\u000e-\u001f\u007f-\u0084\u0086-\u009f]/g;
/** Every line break JavaScript, YAML or a terminal might honour. */
const BREAK = /\r\n|[\n\r\u000b\u000c\u0085\u2028\u2029]/;
/** `[trail]`, `[graft]`, `[trail-code]`, any case, once or more, at the start. */
const MARKER = /^\s*(?:\[(?:trail|graft|trail-code)\]\s*)+/i;

/**
 * `text` as one line of at most `max` characters, ending in "…" when cut.
 * Anything but a string, a number or a boolean reads as "".
 */
export function flatLine(text: unknown, max = 160): string {
  const raw = typeof text === "string" ? text : typeof text === "number" || typeof text === "boolean" ? String(text) : "";
  const line = raw
    .replace(INVISIBLE, "")
    .replace(CONTROL, "")
    .split(BREAK)
    .map((part) => part.replace(MARKER, ""))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  const chars = Array.from(line);
  return chars.length > max ? `${chars.slice(0, Math.max(0, max - 1)).join("").trimEnd()}…` : line;
}

/**
 * The words of `text` as one line, none of them starting with a marker: for
 * text wrapped onto several lines, where any word can start one. A marker in
 * the middle of a word stays, since no line can start there.
 */
export function unmarkedWords(text: unknown): string[] {
  return flatLine(text, Number.POSITIVE_INFINITY)
    .split(" ")
    .map((word) => word.replace(MARKER, ""))
    .filter(Boolean);
}

/** `flatLine` as plain JS source, for the generated hooks shim. Keep the two in step. */
export const FLAT_LINE_JS = `function flatLine(text, max) {
  if (max === undefined) max = 160;
  const raw = typeof text === 'string' ? text : typeof text === 'number' || typeof text === 'boolean' ? String(text) : '';
  const line = raw
    .replace(/[\\p{Cf}\\ufe00-\\ufe0f\\u{e0100}-\\u{e01ef}]/gu, '')
    .replace(/[\\u0000-\\u0008\\u000e-\\u001f\\u007f-\\u0084\\u0086-\\u009f]/g, '')
    .split(/\\r\\n|[\\n\\r\\u000b\\u000c\\u0085\\u2028\\u2029]/)
    .map((part) => part.replace(/^\\s*(?:\\[(?:trail|graft|trail-code)\\]\\s*)+/i, ''))
    .join(' ')
    .replace(/\\s+/g, ' ')
    .trim();
  const chars = Array.from(line);
  return chars.length > max ? chars.slice(0, Math.max(0, max - 1)).join('').trimEnd() + '\\u2026' : line;
}`;
