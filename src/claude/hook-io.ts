/**
 * What every hook shares for talking back to the host and for running the CLI
 * as a child: the one JSON shape a hook answers in, and the `graft` child with
 * its time budget. Kept apart from hooks.ts so each event's handler can live in
 * its own file.
 */
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { resolveContextDir } from './state.js';
import { graftCliPath } from './paths.js';
import type { HookOut } from '../skills/types.js';

/** Default budget for a graft child process invoked from a hook, matching the 8s
 * the installed hook entries carry. */
export const CHILD_TIMEOUT_MS = 8000;

/**
 * Append `--dir <contextDir>` for the hooks' own `graft ask` child (post-edit's
 * `graft check` runs in stale-count-run.ts, which does the same) — the one place the hooks spawn the CLI itself rather
 * than reading `graft/` off disk (which already resolves through
 * `resolveContextDir` inside `util/state.ts` and `claude/stats.ts`). A no-op
 * when `GRAFT_DIR` isn't set, so an unconfigured repo's spawned CLI sees
 * byte-identical argv to before this existed.
 */
export function withContextDirArg(dir: string, args: string[]): string[] {
  return process.env.GRAFT_DIR ? [...args, '--dir', resolveContextDir(dir)] : args;
}

/** The graft child's JSON answer, or null. `input` goes to it on stdin: for anything the person typed, which argv would show to `ps`. */
export function graftJson(dir: string, args: string[], timeout: number = CHILD_TIMEOUT_MS, input?: string): any | null {
  try {
    // GRAFT_TEST_CLI is a test seam (mirrors GRAFT_TEST_STDIN/GRAFT_TEST_SYNC_RUN) so
    // tests can point the prompt hook's `graft ask`/`graft check` calls at a stub
    // script and observe the exact args it was invoked with, instead of shelling
    // out to the real CLI (which isn't built relative to the TS source under test).
    const cliPath = process.env.GRAFT_TEST_CLI ?? graftCliPath();
    const out = execFileSync(process.execPath, [cliPath, ...args],
      { cwd: dir, encoding: 'utf8', timeout, input, stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'ignore'], windowsHide: true });
    return JSON.parse(out);
  } catch (e: any) {
    // `graft check` exits non-zero when the graph is stale (by design) but still
    // prints valid JSON to stdout; recover it from the thrown error before giving up.
    if (e && typeof e.stdout === 'string' && e.stdout.trim()) {
      try { return JSON.parse(e.stdout); } catch { /* not JSON — fall through */ }
    }
    return null;
  }
}

/**
 * The graft child's JSON answer within `timeout` ms, or null. Unlike
 * {@link graftJson}, the wait really ends at `timeout`: `execFileSync` sends
 * SIGTERM and then waits for the child to exit, and a `graft ask` refreshing
 * the graph takes SIGTERM (to release its lock) only once its synchronous
 * parse is done, which on a large repo is half a minute. Here the child is
 * sent SIGTERM and let go: it releases its lock and exits on its own, and is
 * never waited on, so the hook ends on time. `input` goes on stdin.
 */
export function graftJsonWithin(dir: string, args: string[], timeout: number, input?: string): Promise<any | null> {
  return new Promise((resolve) => {
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const done = (value: any | null) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(value);
    };
    try {
      const cliPath = process.env.GRAFT_TEST_CLI ?? graftCliPath();
      const child = spawn(process.execPath, [cliPath, ...args], { cwd: dir, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
      let out = '';
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => { out += chunk; });
      child.stdout.on('error', () => { /* cut off: nothing more to read */ });
      child.stdin.on('error', () => { /* the child left before reading: its answer says the rest */ });
      child.on('error', () => done(null));
      child.on('close', () => {
        try { done(JSON.parse(out)); } catch { done(null); }
      });
      timer = setTimeout(() => {
        try { child.kill('SIGTERM'); } catch { /* already gone */ }
        child.stdout.destroy();
        child.stdin.destroy();
        child.unref();
        done(null);
      }, Math.max(0, timeout));
      child.stdin.end(input ?? '');
    } catch {
      done(null);
    }
  });
}

/** A hook's answer: `additionalContext` for the event, as Claude Code (and Codex) read it. */
export function emit(eventName: string, additionalContext: string): void {
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: eventName, additionalContext } }));
}

/**
 * A hook's whole answer as one JSON object, or nothing when `out` is empty.
 * A block (Stop: the agent goes on with `reason`; UserPromptSubmit: the
 * prompt goes no further) is the whole answer, never beside a notice or
 * context. Otherwise context is `hookSpecificOutput.additionalContext`, which
 * the agent reads (Stop has none), and a notice is the top-level
 * `systemMessage`, which the person reads.
 */
export function emitHook(eventName: string, out: HookOut): void {
  if (out.block) {
    process.stdout.write(JSON.stringify({ decision: 'block', reason: out.block }));
    return;
  }
  const context = eventName === 'Stop' ? '' : out.context ?? '';
  const answer: Record<string, unknown> = {};
  if (context) answer.hookSpecificOutput = { hookEventName: eventName, additionalContext: context };
  if (out.notice) answer.systemMessage = out.notice;
  if (Object.keys(answer).length) process.stdout.write(JSON.stringify(answer));
}

/**
 * The session a payload belongs to, in every host's shape: Claude Code's
 * `session_id`, Copilot CLI's `sessionId`, Cursor's `conversation_id`;
 * 'default' when none. It names a file, so anything but a plain name (a path,
 * a dot first, very long) is hashed into one.
 */
export function payloadSessionId(input: unknown): string {
  const p = input && typeof input === 'object' && !Array.isArray(input) ? (input as Record<string, unknown>) : {};
  const raw = [p.session_id, p.sessionId, p.conversation_id].find((v): v is string => typeof v === 'string' && v !== '');
  if (raw === undefined) return 'default';
  if (/^[A-Za-z0-9_-][A-Za-z0-9._-]{0,127}$/.test(raw)) return raw;
  return `h-${createHash('sha256').update(raw).digest('hex').slice(0, 16)}`;
}
