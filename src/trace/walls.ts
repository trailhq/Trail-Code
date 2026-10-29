/**
 * The wall catalog (design 4.10): seven errors that a command keeps hitting
 * on a machine for reasons outside the code, each with the fix a person
 * wrote, appended to the agent's context when the error comes back.
 *
 * A class matches only on its own line-anchored patterns, in the first and
 * last 4 KB of the result, never inside quoted or JSON-escaped output (D147:
 * a printed record of another session), and (for four classes) only when a segment of the
 * command runs the program the error belongs to (R28): a log printed by
 * `cat`, or an `echo` an agent writes, matches nothing.
 *
 * The fix texts are constants. Nothing from the command's output reaches
 * them; the only value put in is the remote's SSH address, rebuilt from its
 * https URL and checked. They read as information about the failed command
 * (D88): Trail is the tool the person installed, this is the error it knows,
 * and this command usually fixes it, because. They never tell the agent what
 * to say.
 *
 * Pure. Not on the PreToolUse fast path.
 */
import { flatLine } from '../notes/flatten.js';
import { WALL_CLASSES } from '../notes/learning-fields.js';
import { isLookOnly } from './shell.js';
import { afterTimeout, shellScript, simpleCommands } from './shell-words.js';
import { ASSIGN, base, words } from './shell-scan.js';
import { globWallTied } from './walls-glob.js';
import { unquotedMatch } from './walls-quoted.js';
import type { WallClass } from './types.js';

export interface WallCtx {
  hasProgram(p: string): boolean;
  /** The remote's SSH address (sshRemoteFor), or null. */
  remoteSsh: string | null;
}

export interface WallEntry {
  cls: WallClass;
  /** Line-anchored patterns, tried on the first and last 4 KB of the result (4.10). */
  patterns: readonly RegExp[];
  /** Programs one of whose segments must be in the command for the class to match, or null for any (R28). */
  programs: readonly string[] | null;
  /** Fixed words naming the wall, for offers and the screen. */
  words: string;
  /** The human-written fix (4.10 table). ctx says which form applies (colima on PATH, the remote's ssh form). */
  fix(ctx: WallCtx): string;
  /** A guardrail init may offer for it, or null. `does`: what keeping it makes Claude do, in words for the offer. */
  guardrail: { title: string; text: string; does: string; fileName: string; check?: 'no-timeout'; applies: 'every repo' | 'this repo' } | null;
}

/** Where a shell puts its name before its own error: `zsh:1: `, `bash: line 3: `, `bash: `, `(eval):1: `, `/bin/zsh:1: `. */
const SHELL = String.raw`(?:(?:\/[\w./-]*\/)?(?:zsh|bash|sh)(?::\d+)?:(?: line \d+:)? |\(eval\):\d+: )?`;
const at = (body: string) => new RegExp(`^${SHELL}${body}`, 'm');

const DOCKER_ENV = 'DOCKER_HOST=unix://$HOME/.colima/default/docker.sock TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE=/var/run/docker.sock TESTCONTAINERS_RYUK_DISABLED=true';

/** The parts every fix line shares (b7 holds them to the words rules with the other copy constants). */
export const WALL_COPY: Record<string, string> = {
  lead: '[trail] Trail, the tool this person installed, recognizes this error',
  lastTime: '[trail] What fixed this here before (a learning this person kept in Trail, worked on {date1} and {date2}): {lesson}',
};

const lead = (what: string, words: string) => `${WALL_COPY.lead}${what}: ${words}.`;

export const WALLS: readonly WallEntry[] = Object.freeze([
  {
    cls: 'timeout-missing',
    patterns: [at(String.raw`command not found: timeout\s*$`), at(String.raw`timeout: command not found\s*$`)],
    programs: ['timeout'],
    words: '"timeout: command not found"',
    fix: () => `${lead(' from the timeout command', '"timeout: command not found"')} This Mac has no timeout program. `
      + "The usual fix is the same command without timeout, using the Bash tool's own timeout parameter or run_in_background, since neither needs that program.",
    guardrail: {
      title: 'No timeout on this Mac', fileName: 'no-timeout.md', check: 'no-timeout', applies: 'every repo',
      text: "This Mac has no `timeout`. Run long commands in the background, or use the Bash tool's own timeout.",
      does: "Claude won't use the timeout command, which this Mac doesn't have",
    },
  },
  {
    cls: 'zsh-no-match',
    patterns: [/^(?:(?:\/[\w./-]*\/)?zsh|\(eval\)):\d*:? no matches found: /m],
    programs: null,
    words: 'zsh "no matches found"',
    fix: () => `${lead('', 'zsh "no matches found"')} zsh expanded an unquoted glob before the command ran. `
      + "The usual fix is to quote that argument ('...*...') or put noglob in front of the command, so the glob reaches the program as written.",
    guardrail: null,
  },
  {
    cls: 'git-https-auth',
    patterns: [at("fatal: could not read Username for 'https://"), /^remote: Invalid username or password/m, /^(?:fatal: )?Authentication failed for 'https:\/\//m],
    programs: ['git', 'gh'],
    words: 'the HTTPS push asking for a username',
    fix: (ctx) => {
      const ssh = goodSsh(ctx.remoteSsh);
      const push = ssh
        ? `The usual fix is git push ${ssh} HEAD, because an SSH push uses this machine's SSH key, not HTTPS credentials.`
        : "The usual fix is to push to the remote's SSH address (git@host:owner/repo.git), because an SSH push uses this machine's SSH key, not HTTPS credentials.";
      const gh = ctx.hasProgram('gh') ? ' gh auth setup-git, run once by the person in their own terminal, also fixes it.' : '';
      return `${lead(' from git', 'the HTTPS push asking for a username')} This remote is HTTPS and git has no credentials for it here. ${push}${gh}`;
    },
    guardrail: {
      title: 'Push over SSH in this repo', fileName: 'push-over-ssh.md', applies: 'this repo',
      text: "This repo's remote is HTTPS and git has no credentials for it here. Push over SSH, to the remote's git@ address.",
      does: 'Claude pushes this repo over SSH, since HTTPS asks for a username here',
    },
  },
  {
    cls: 'docker-rootless',
    // Anywhere on a line (a test runner's `Failed to get provider: ...`), so the match starts at the error's words.
    patterns: [/\brootless Docker not found\b/m, /\bCannot connect to the Docker daemon at unix:\/\//m],
    programs: null,
    words: '"rootless Docker not found"',
    fix: (ctx) => ctx.hasProgram('colima')
      ? `${lead(' from Docker', '"rootless Docker not found"')} Docker on this Mac runs in Colima. The usual fix is colima start if it isn't running, `
        + `then the same command with ${DOCKER_ENV} in front, because test tools look for Docker's default socket and Colima's is elsewhere.`
      : `${lead(' from Docker', '"rootless Docker not found"')} No Docker daemon is running here. It needs Docker Desktop or Colima started on this machine, `
        + 'which is the person\'s step; after that the same command usually works, since only the daemon was missing.',
    guardrail: null,
  },
  {
    cls: 'npm-e401-eotp',
    patterns: [/^npm (?:ERR!|error) code (?:E401|EOTP|ENEEDAUTH)\b/m],
    programs: ['npm', 'npx', 'pnpm', 'yarn'],
    words: 'npm asking for a login or one-time password',
    fix: () => `${lead(' from npm', 'npm asking for a login or one-time password')} Only the person can give npm a fresh login or a one-time password, `
      + 'so the same npm command fails the same way until then. The usual fix is npm login, or the publish itself, run by the person in their own terminal.',
    guardrail: null,
  },
  {
    cls: 'claude-not-logged-in',
    patterns: [/^(?:Error: )?Invalid API key · Please run \/login/m, /^(?:Error: )?Failed to authenticate\b/m, /^(?:Error: )?OAuth session expired\b/m],
    programs: ['claude'],
    words: 'claude not signed in',
    fix: () => `${lead(' from the claude CLI', 'claude not signed in')} The claude CLI isn't signed in on this terminal, `
      + 'so the same claude command fails the same way until it is. The usual fix is the person running claude in their own terminal and signing in there.',
    guardrail: null,
  },
  {
    cls: 'enospc',
    patterns: [/(?:^|: )[Nn]o space left on device\b/m, /(?:^|Error: |code )ENOSPC\b/m],
    programs: null,
    words: '"No space left on device"',
    fix: () => `${lead('', '"No space left on device"')} The disk is full, so writes fail whatever the command is. `
      + 'df -h . shows what is left; the usual fix is freeing space, and which files go is the person\'s call, since deleting can\'t be undone.',
    guardrail: null,
  },
] satisfies WallEntry[]) as readonly WallEntry[];

const BY_CLASS = new Map(WALLS.map((w) => [w.cls, w]));
/** Classes matched on a command that exited 0 (P23): the three that hide behind `| tail` in the corpus. */
const EXIT_ZERO: ReadonlySet<WallClass> = new Set(['timeout-missing', 'zsh-no-match', 'docker-rootless']);
const END = 4 * 1024;
const MAX_CHAIN = 16;
const MAX_DEPTH = 4;
/** A longer command is no wall: parsing it would cost more than the hook has (2 MB took 0.9 s), and no real one is this long. */
const MAX_COMMAND = 64 * 1024;
/** A colour or cursor code (CSI): npm and git colour their error lines under FORCE_COLOR. */
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
/**
 * Programs that only print what they were given or read. A command made of these alone (and no redirect, so
 * look-only) can't hit the disk or Docker: an error it shows is quoted from a log, a README or an echo (planted text).
 */
const PRINTERS: ReadonlySet<string> = new Set([
  'echo', 'printf', 'cat', 'head', 'tail', 'grep', 'egrep', 'fgrep', 'rg', 'less', 'more', 'wc', 'true', 'false',
  'exit', 'return', 'test', '[', '[[', ':', 'cd', 'pwd', 'sleep',
]);

/** An SSH remote as sshRemoteFor makes them: `git@host:owner/repo.git`, plain characters only. */
const SSH_REMOTE = /^git@[A-Za-z0-9.-]{1,253}:[A-Za-z0-9._-]{1,100}(?:\/[A-Za-z0-9._-]{1,100}){1,4}\.git$/;
/** No part may start with '-': git and ssh would read `git@-oProxyCommand…` or `:-upload-pack…` as an option. */
const goodSsh = (s: string | null) => (typeof s === 'string' && SSH_REMOTE.test(s) && !s.includes('..') && !/[@:/.]-/.test(s) ? s : null);

/** `https://host/owner/repo(.git)` to `git@host:owner/repo.git`; never a user or token; null for anything else. */
export function sshRemoteFor(url: string): string | null {
  const m = /^https:\/\/(?:[^@/\s]+@)?([A-Za-z0-9.-]{1,253})\/([A-Za-z0-9._-]{1,100}(?:\/[A-Za-z0-9._-]{1,100}){1,4}?)(?:\.git)?\/?$/.exec(String(url ?? '').trim());
  if (!m) return null;
  return goodSsh(`git@${m[1]}:${m[2]!.replace(/\.git$/, '')}.git`);
}

/** The words after one wrapper (time, nohup, env, sudo, timeout, ...), or null when `w` doesn't start with one. */
function unwrap(w: string[]): string[] | null {
  const p = w[0];
  if (p === 'time') return w.slice(w[1] === '-p' ? 2 : 1);
  if (p === 'nohup' || p === '!' || p === 'exec' || p === 'noglob' || p === 'caffeinate') return w.slice(1);
  if (p === 'command') return w[1] && !w[1].startsWith('-') ? w.slice(1) : null;
  if (p === 'nice') return w.slice(w[1] === '-n' ? 3 : w[1]?.startsWith('-') ? 2 : 1);
  if (p === 'timeout' || p === 'gtimeout') return afterTimeout(w);
  if (p === 'env' || p === 'sudo' || p === 'doas') {
    let i = 1;
    while (i < w.length && (w[i]!.startsWith('-') || ASSIGN.test(w[i]!))) i += /^-[uCgDhprtUT]$/.test(w[i]!) ? 2 : 1;
    return w.slice(i);
  }
  return null;
}

/** Every program a simple command runs through its wrappers, and inside `sh -c '...'`. */
function programsOf(simple: string, depth: number, out: Set<string>): void {
  let w = words(simple);
  for (let n = 0; n < MAX_CHAIN && w.length; n++) {
    while (w.length && ASSIGN.test(w[0]!)) w = w.slice(1);
    if (!w.length) return;
    out.add(base(w[0]!));
    const script = shellScript(w);
    if (script !== null) {
      if (depth < MAX_DEPTH) for (const s of simpleCommands(script)) programsOf(s, depth + 1, out);
      return;
    }
    const next = unwrap(w);
    if (!next) return;
    w = next;
  }
}

function programsIn(command: string): Set<string> {
  const out = new Set<string>();
  for (const s of simpleCommands(command)) programsOf(s, 0, out);
  return out;
}

/** The command outside its quotes and escapes, in one pass (a regex over nested quotes can backtrack). */
function unquoted(command: string): string {
  let out = '';
  let q = '';
  for (let i = 0; i < command.length; i++) {
    const c = command[i]!;
    if (q === "'") { if (c === "'") q = ''; continue; }
    if (c === '\\') { i++; continue; }
    if (q === '"') { if (c === '"') q = ''; continue; }
    if (c === "'" || c === '"') { q = c; continue; }
    out += c;
  }
  return out;
}

/**
 * The first and last 4 KB of the result, colour codes gone. A line the window's edge cuts is no line: the tail
 * window starts at its first whole line, and the head window's cut end is kept off a line end (NUL before the
 * joining newline), so `^` and `$` see only real line edges.
 */
function windows(result: string): string {
  if (result.length <= 2 * END) return result.replace(ANSI, '');
  const head = result.slice(0, END);
  let tail = result.slice(-END);
  const before = result[result.length - END - 1];
  if (before !== '\n' && before !== '\r') {
    const nl = tail.search(/[\r\n]/);
    tail = nl < 0 ? '' : tail.slice(nl + 1);
  }
  return `${head}\u0000\n${tail}`.replace(ANSI, '');
}

/** Null unless one class matches. `failed` false means the command exited 0 (P23 limits apply). */
export function matchWall(result: string, command: string, failed: boolean): WallClass | null {
  try {
    if (typeof result !== 'string' || typeof command !== 'string' || !result || command.length > MAX_COMMAND) return null;
    const ends = windows(result);
    // The patterns first: they read at most 8 KB, and most results match none, so the command is parsed only for a hit.
    // A match inside quoted or JSON-escaped output (a printed record of another session) is no hit (D147).
    const hits = WALLS.filter((w) => (failed || EXIT_ZERO.has(w.cls)) && w.patterns.some((re) => unquotedMatch(re, ends)));
    if (!hits.length) return null;
    const look = isLookOnly(command);
    if (!failed && look) return null;
    const programs = programsIn(command);
    // Planted text: a look-only command made only of printers shows an error, it doesn't hit one (zsh's own glob aside).
    const printsOnly = look && programs.size > 0 && [...programs].every((p) => PRINTERS.has(p));
    for (const w of hits) {
      if (w.programs && !w.programs.some((p) => programs.has(p))) continue;
      if (w.cls === 'zsh-no-match') {
        // zsh says it only for a glob the command itself left unquoted, and it is a wall only when that glob was
        // never a file path: a flag's value, a URL or query, a git grep/log/diff pathspec, a grep pattern (D147).
        if (!/[*?[]/.test(unquoted(command)) || !globWallTied(ends, command)) continue;
      } else if (!w.programs && printsOnly) continue;
      return w.cls;
    }
    return null;
  } catch {
    return null;
  }
}

/** '[trail] Trail, the tool this person installed, recognizes this error ...' (4.10, D88); '' for an unknown class. */
export function wallFixText(cls: WallClass, ctx: WallCtx): string {
  const w = BY_CLASS.get(cls);
  if (!w) return '';
  try {
    return w.fix(ctx);
  } catch {
    return w.fix({ hasProgram: () => false, remoteSsh: null });
  }
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
const shortDay = (d: string) => {
  const m = DAY.exec(d)!;
  return `${MONTHS[Number(m[2]) - 1] ?? m[2]} ${Number(m[3])}`;
};

/**
 * '[trail] What fixed this here before (...worked on {date1} and {date2}): {lesson text}', only when the lesson
 * worked on 2 or more days given as local dates (4.10); the newest two are said. '' otherwise.
 */
export function lastTimeText(lessonText: string, workedOn: string[]): string {
  // Only real days count as epochs: junk in the list is no second epoch.
  const valid = (Array.isArray(workedOn) ? workedOn : []).filter((d) => typeof d === 'string' && DAY.test(d));
  const days = [...new Set(valid)].sort();
  const text = flatLine(lessonText, 200);
  if (!text || valid.length < 2) return '';
  const [d1, d2] = days.slice(-2);
  if (!d1) return '';
  // Two epochs on one day: 'worked twice on Oct 2'.
  const when = d2 ? WALL_COPY.lastTime! : WALL_COPY.lastTime!.replace('on {date1} and {date2}', 'twice on {date1}');
  // Functions, so a `$'` or `$&` in the lesson is text, not a replacement pattern.
  return when.replace('{date1}', () => shortDay(d1)).replace('{date2}', () => (d2 ? shortDay(d2) : '')).replace('{lesson}', () => text);
}

// The catalog and the closed list agree (a test holds them equal too).
if (WALLS.map((w) => w.cls).join() !== WALL_CLASSES.join()) throw new Error('walls.ts: the catalog and WALL_CLASSES differ');
