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

/** flatLine(text, max), or undefined when secretReason finds anything in it. */
export function cleanLine(text: string, max: number): string | undefined {
  const raw = typeof text === 'string' ? text : '';
  if (secretReason(raw) !== null) return undefined;
  const line = flatLine(raw, max);
  return secretReason(line) === null ? line : undefined;
}
