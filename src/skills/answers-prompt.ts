/**
 * A step that answers a login or confirmation prompt for the person (D101
 * item 4): keystrokes piped or fed into `script`, `expect` or a login or
 * publish (`(sleep 15; printf '\n'; sleep 300) | script -q /dev/null npm
 * login`, `yes | npm publish`, `printf 'y\n' | npm login`, `npm login <<<
 * ...`), or `expect` run at all. Such a step is never kept: the prompt it
 * answers is the person's, and an agent rightly reads a kept one as a way
 * round their confirmation.
 *
 * Linear: one top-level split per level, groups `( … )` and `{ …; }` read
 * at most 3 levels deep, and patterns with no nested repetition.
 */
import { bareCommand, splitTop } from '../trace/shell.js';
import { gatedKind, loginOf } from './risk.js';

const MAX_DEPTH = 3;
/** A program that writes keystrokes: `printf`, `echo` or `yes` at a command's start. */
const FEEDER = /(?:^|[;&|({]\s*)(?:printf|echo|yes)(?![\w.-])/;
/** Programs that drive another program's terminal prompt. */
const PROMPT_DRIVER = /^(?:script|expect|unbuffer)(?![\w.-])/;
const EXPECT = /^expect(?![\w.-])/;
const HERE_STRING = /<<</;
const STDIN_FLAG = /\s--(?:password-stdin|with-token|stdin)(?![\w-])/;

/** The command, a whole Bash call, answers a login or confirmation prompt for the person. */
export function answersPrompt(cmd: string): boolean {
  return within(String(cmd ?? ''), 0);
}

function within(text: string, depth: number): boolean {
  const segs = splitTop(text);
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i]!;
    const t = seg.text.trim();
    if (EXPECT.test(bareCommand(t))) return true;
    if (depth < MAX_DEPTH && (t.startsWith('(') || t.startsWith('{'))) {
      const inner = t.replace(/^[({]/, '').replace(/[)}]$/, '');
      if (within(inner, depth + 1)) return true;
    }
    if (HERE_STRING.test(t) && promptTarget(t)) return true;
    const next = segs[i + 1];
    if (seg.sep === '|' && next && FEEDER.test(t) && promptTarget(next.text)) return true;
  }
  return false;
}

/** What a fed keystroke would answer: a prompt driver, or a login or publish (through its wrappers, risk.ts). */
function promptTarget(text: string): boolean {
  const t = text.trim();
  if (PROMPT_DRIVER.test(bareCommand(t))) return true;
  // A flag made to read stdin (`docker login --password-stdin`, `gh auth login --with-token`) is input, not a prompt.
  if (STDIN_FLAG.test(t)) return false;
  const kind = gatedKind(t);
  return kind === 'login' || kind === 'publish';
}

/** A group or a command that only waits and types: `(sleep 15; printf '\n'; sleep 300)`, `printf 'y\n'`, `yes`. */
const KEYSTROKES = /^(?:[({]\s*)?(?:(?:sleep\s+[\d.]+|printf\s+(?:'[^']*'|"[^"]*"|[^\s;&|()'"])+|echo(?:\s+(?:'[^']*'|"[^"]*"|[^\s;&|()'"])+)*|yes)\s*(?:;\s*|$|(?=[)}])))+(?:[)}]\s*)?$/;

/**
 * D116 item 5: the whole call only feeds keystrokes into a login (`(sleep 15; printf '\n'; sleep 300) | script -q
 * /dev/null npm login`, `yes | npx vercel login`, `npm login <<< ...`): the login and its service, else null. Such a
 * step is dropped from a skill and the login becomes a "Before you start" line for the person; what was fed is never
 * kept. A feed into a publish, `expect`, or a login inside a longer call is not one (still `answersPrompt`).
 */
export function loginFeed(cmd: string): { service: string; login: string } | null {
  const text = String(cmd ?? '').trim();
  if (!answersPrompt(text)) return null;
  const segs = splitTop(text);
  let target: string;
  if (segs.length === 1 && HERE_STRING.test(text)) target = text.slice(0, text.search(HERE_STRING));
  else if (segs.length === 2 && segs[0]!.sep === '|' && segs[0]!.text.length <= 4096 && KEYSTROKES.test(segs[0]!.text.trim())) target = segs[1]!.text;
  else return null;
  const bare = bareCommand(target.trim());
  if (EXPECT.test(bare) || gatedKind(bare) !== 'login') return null;
  return loginOf(bare);
}
