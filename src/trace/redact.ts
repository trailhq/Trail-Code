/**
 * The fold-time secret rule (design 4.10). A command that ran is kept only in
 * a form with no secret in it: a secret assigned to a name (`NPM_TOKEN=…`,
 * `--token …`) becomes `${NAME:?set NAME}`, which still runs and says what to
 * set; anything else secret-shaped makes the whole command unusable, stored
 * as null. Nothing secret-shaped reaches `sessions/`, `runs/`, marks or a
 * skill.
 *
 * A named value ends where the shell word ends (`;`, `&&`, `|` stay put), and
 * its placeholder is always double-quoted so it expands. A command over 2,000
 * characters is never compiled (the fold marks it truncated), so it is stored
 * as null without a look.
 */
import { flatLine } from '../notes/flatten.js';
import { secretReason } from '../notes/secrets.js';

const placeholder = (name: string) => `\${${name}:?set ${name}}`;
/** A value: quoted (anything but its quote), or a bare word (up to a space, a quote or a shell operator). */
const VALUE = String.raw`(?:'([^']*)'|"([^"]*)"|([^\s'"\x60;&|<>()]+))`;
const ASSIGNED = new RegExp(String.raw`\b([A-Z][A-Z0-9_]{2,})=${VALUE}`, 'g');
const FLAG = new RegExp(String.raw`--(token|password|api-key|apikey|secret|key)([= ])${VALUE}`, 'g');
const BEARER = /(\bBearer\s+)([^\s'"]+)/gi;
/** Commands longer than this are never compiled (4.1 `truncated`) and are not scanned. */
const MAX_SCANNED = 2000;

/** The fold-time secret rule (4.10). */
export function redactSecrets(cmd: string): { cmd: string | null; secret?: 'named' | 'refused' } {
  const raw = String(cmd ?? '');
  if (raw.length > MAX_SCANNED) return { cmd: null, secret: 'refused' };
  if (secretReason(raw) === null) return { cmd: raw };
  // Values assigned to a name, so a later `Bearer <value>` can take that name.
  const named = new Map<string, string>();
  let out = raw.replace(ASSIGNED, (whole, name: string, sq?: string, dq?: string, bare?: string) => {
    const value = sq ?? dq ?? bare ?? '';
    if (secretReason(`${name}=${value}`) === null && secretReason(value) === null) return whole;
    named.set(value, name);
    // Double quotes, or none: a placeholder in single quotes would never expand.
    return `${name}=${bare === undefined ? '"' : ''}${placeholder(name)}${bare === undefined ? '"' : ''}`;
  });
  out = out.replace(FLAG, (whole, flag: string, sep: string, sq?: string, dq?: string, bare?: string) => {
    const value = sq ?? dq ?? bare ?? '';
    if (secretReason(`--${flag} ${value}`) === null && secretReason(value) === null) return whole;
    return `--${flag}${sep}"${placeholder(flag.toUpperCase().replace(/-/g, '_'))}"`;
  });
  out = out.replace(BEARER, (whole, lead: string, value: string) => {
    const name = named.get(value);
    return name ? `${lead}${placeholder(name)}` : whole;
  });
  if (out === raw || secretReason(out) !== null) return { cmd: null, secret: 'refused' };
  return { cmd: out, secret: 'named' };
}

/** What stands where a secret was, in a text sent whole (`redactText`). */
export const REDACTED = '[redacted]';

/** A private key from its BEGIN line to its END line, or to the end of the text when it was cut. */
const PRIVATE_KEY_BLOCK = /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----|$)/g;
/** A word, for finding where on a line the secret is: a run between spaces, quotes and brackets. `=`, `:` and `/` stay in it. */
const WORD = /[^\s'"`,;{}()[\]<>]+/g;
/** The ways to take a secret out of one word and keep the rest, tried in order: a link's password, a link's key, a name's value. */
const IN_WORD: Array<[RegExp, string]> = [
  [/([a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)[^\s@/]+(?=@)/gi, `$1${REDACTED}`],
  [/([?&#](?:key|sig|signature|x-amz-signature|x-goog-signature|auth|token|access_token|api_key)=)[^&#\s]+/gi, `$1${REDACTED}`],
  [/^([^=:]+[=:]+)(?=.)[\s\S]*$/, `$1${REDACTED}`],
];

/** One secret taken out: its kind, as secretReason names it, and the text that went (to count each secret once). */
export interface Redaction {
  kind: string;
  what: string;
}

/**
 * `text` with every secret `secretReason` finds taken out, for a text sent
 * whole rather than refused (a Claude Code session a person chose to send).
 * The rule stays secretReason's; this only finds where on the line the secret
 * is: a private key block, then each word secretReason flags on its own (a
 * name keeps its `NAME=`, a link its host), then a word that is a secret only
 * after the word or two before it (`Bearer …`, `--token …`, `"password": …`).
 * A line still flagged after that goes whole. Lines with nothing flagged are
 * never touched.
 */
export function redactText(text: string): { text: string; found: Redaction[] } {
  const found: Redaction[] = [];
  if (typeof text !== 'string' || secretReason(text) === null) return { text, found };
  let out = text.replace(PRIVATE_KEY_BLOCK, (what) => {
    found.push({ kind: 'a private key', what });
    return `${REDACTED} private key`;
  });
  if (secretReason(out) === null) return { text: out, found };
  out = out
    .split('\n')
    .map((line) => {
      const why = secretReason(line);
      return why === null ? line : redactLine(line, why, found);
    })
    .join('\n');
  return { text: out, found };
}

function redactLine(line: string, why: string, found: Redaction[]): string {
  const words = [...line.matchAll(WORD)].map((m) => ({ at: m.index!, word: m[0], out: m[0] }));
  /** Words `a` to `b` as they now read, with what was between them. */
  const now = (a: number, b: number) => {
    let s = words[a]!.out;
    for (let j = a + 1; j <= b; j++) s += line.slice(words[j - 1]!.at + words[j - 1]!.word.length, words[j]!.at) + words[j]!.out;
    return s;
  };
  for (const w of words) {
    const kind = secretReason(w.word);
    if (kind === null) continue;
    w.out = IN_WORD.map(([re, to]) => w.word.replace(re, to)).find((x) => x !== w.word && secretReason(x) === null) ?? REDACTED;
    found.push({ kind, what: w.word });
  }
  // `Bearer abc…`, `--token abc…`, `"api_key": "abc…"`: the word with the one or two before it.
  for (let i = 1; i < words.length; i++) {
    const w = words[i]!;
    if (w.out !== w.word) continue;
    for (const back of [1, 2]) {
      if (i - back < 0) break;
      const kind = secretReason(now(i - back, i));
      if (kind === null) continue;
      w.out = REDACTED;
      found.push({ kind, what: w.word });
      break;
    }
  }
  const out = words.length ? line.slice(0, words[0]!.at) + now(0, words.length - 1) + line.slice(words.at(-1)!.at + words.at(-1)!.word.length) : line;
  if (secretReason(out) === null) return out;
  found.push({ kind: why, what: line });
  return `${REDACTED} line (${why})`;
}

/** flatLine(text, max), or undefined when secretReason finds anything in it. */
export function cleanLine(text: string, max: number): string | undefined {
  const raw = typeof text === 'string' ? text : '';
  if (secretReason(raw) !== null) return undefined;
  const line = flatLine(raw, max);
  return secretReason(line) === null ? line : undefined;
}
