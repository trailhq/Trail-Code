/**
 * Is the person at their own terminal (design 1.4 `personAtTerminal`)?
 * `trail skills keep`, `skills on` and `offers on` are the person's: an
 * agent that runs them is refused before they run (the agent guard), and the
 * CLI checks again here.
 *
 * The person: stdin and stdout are TTYs, CLAUDECODE is unset, and no process
 * above this one (up to 12 levels) is an agent's CLI (a program named exactly
 * `claude`, or node running `@anthropic-ai/claude-code`; Codex's `codex`, its
 * `codex-<target>` builds, or node running `@openai/codex`, whose exec tool can
 * give a command a terminal) or a pty wrapper an agent could use to fake a
 * terminal (`script`, `expect`, `unbuffer`, python running `pty`). The desktop
 * apps are `Claude` and `Codex`, with a capital C: their own windows are the
 * person's. (`claudeAncestor` keeps its 1a name: any agent ancestor.)
 *
 * When the process table can't be read, the answer is no: a person can run
 * the command again, an agent must not get through on an error.
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { basename } from 'node:path';

export interface PersonCheck { ok: boolean; tty: boolean; claudeCodeEnv: boolean; claudeAncestor: boolean }
/** One row of the process table: `comm` is the executable (a full path on macOS), `args` the command line. */
export interface PsRow { pid: number; ppid: number; comm: string; args: string }
/** Seams for tests: the TTYs, the process table, and the process to start from. */
export interface PersonDeps { stdinTTY?: boolean; stdoutTTY?: boolean; ps?: () => PsRow[] | null; pid?: number }

const LEVELS = 12;
const PTY_WRAPPERS = new Set(['script', 'expect', 'unbuffer']);
/** `python3`, and the macOS framework builds (Homebrew's, Xcode's), which run as `Python`. */
const PYTHON = /^python[\d.]*$/i;
const NODE = /^(?:node|nodejs|bun)(?:\.exe)?$/;

const firstWord = (args: string) => args.trim().split(/\s+/)[0] ?? '';
/** Codex's CLI: `codex`, and the per-target builds its npm package ships (`codex-x86_64-unknown-linux-musl`). */
const CODEX = /^codex(?:-(?:aarch64|x86_64|arm64|amd64)-[\w-]{1,60})?(?:\.exe)?$/;

/** An agent's CLI (Claude Code's, Codex's) or a pty wrapper. */
export function isAgentProcess(r: PsRow): boolean {
  const exe = basename(r.comm.trim());
  const argv0 = basename(firstWord(r.args));
  if (exe === 'claude' || argv0 === 'claude') return true;
  if (CODEX.test(exe) || CODEX.test(argv0)) return true;
  if (NODE.test(exe) && /@anthropic-ai[/\\]claude-code\b|@openai[/\\]codex\b/.test(r.args)) return true;
  if (PTY_WRAPPERS.has(exe) || PTY_WRAPPERS.has(argv0)) return true;
  return (PYTHON.test(exe) || PYTHON.test(argv0)) && /\bpty\b/.test(r.args);
}

/** True when an agent process is among the 12 above `pid`, or when `pid` isn't in the table (can't tell). */
export function agentAncestor(rows: PsRow[], pid: number): boolean {
  const byPid = new Map(rows.map((r) => [r.pid, r]));
  const self = byPid.get(pid);
  if (!self) return true;
  let at = self.ppid;
  for (let level = 0; level < LEVELS && at > 1; level++) {
    const r = byPid.get(at);
    if (!r) break;
    if (isAgentProcess(r)) return true;
    at = r.ppid;
  }
  return false;
}

const PS = ['/bin/ps', '/usr/bin/ps'];

/** The whole process table from `ps` at its own path (never from PATH, which a caller sets), or null. */
export function readProcessTable(): PsRow[] | null {
  const ps = PS.find((p) => existsSync(p));
  if (!ps || process.platform === 'win32') return null;
  const run = (fields: string) => execFileSync(ps, ['-A', '-o', fields], {
    encoding: 'utf8', timeout: 3000, maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'], env: { LC_ALL: 'C', PATH: '/usr/bin:/bin' },
    windowsHide: true,
  });
  try {
    const rows = new Map<number, PsRow>();
    for (const line of run('pid=,ppid=,comm=').split('\n')) {
      const m = /^\s*(\d+)\s+(\d+)\s(.*)$/.exec(line);
      if (m) rows.set(Number(m[1]), { pid: Number(m[1]), ppid: Number(m[2]), comm: m[3]!.trim(), args: '' });
    }
    for (const line of run('pid=,args=').split('\n')) {
      const m = /^\s*(\d+)\s(.*)$/.exec(line);
      const r = m ? rows.get(Number(m[1])) : undefined;
      if (r) r.args = m![2]!.trim();
    }
    return rows.size ? [...rows.values()] : null;
  } catch {
    return null;
  }
}

/**
 * stdin and stdout are TTYs, CLAUDECODE is unset, and no ancestor process (ps, up to 12 levels) is the claude CLI
 * (basename exactly `claude`, or node running an `@anthropic-ai/claude-code` cli) or a pty wrapper an agent could use
 * (`script`, `expect`, `unbuffer`, python running `pty`). The desktop app (`Claude`, capital C) is not the CLI, so its
 * terminal panel counts as the person's.
 */
export function personAtTerminal(env: NodeJS.ProcessEnv = process.env, deps: PersonDeps = {}): PersonCheck {
  const tty = (deps.stdinTTY ?? process.stdin.isTTY === true) && (deps.stdoutTTY ?? process.stdout.isTTY === true);
  const claudeCodeEnv = env.CLAUDECODE !== undefined;
  const rows = (deps.ps ?? readProcessTable)();
  const claudeAncestor = rows === null ? true : agentAncestor(rows, deps.pid ?? process.pid);
  return { ok: tty && !claudeCodeEnv && !claudeAncestor, tty, claudeCodeEnv, claudeAncestor };
}
