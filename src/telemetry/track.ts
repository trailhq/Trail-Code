/**
 * `track()` — the only way an event is ever created, and the place the contract
 * is enforced.
 *
 * Call sites pass a name and some properties; this drops anything the contract
 * (contract.ts) does not list, stamps the common properties, and appends to the
 * local queue. It never sends, never blocks, and never throws — a telemetry bug
 * must be incapable of failing a build or a query.
 *
 * Two rules do the actual privacy work, and both are enforced here rather than
 * asked of callers:
 *
 *   • unknown event → dropped whole; unknown property key → dropped, the rest of
 *     the event survives. A careless `track('query', { path })` sends `query`
 *     without a path.
 *   • non-string values → dropped. Everything that crosses the wire is a bucket
 *     label or an enum member, so a raw count or a raw message cannot get out
 *     even under a key that happens to be allowed. Where the contract fixes a
 *     key's values (`VALUES`), a value outside them is dropped too.
 */
import { EVENTS, allowedValue } from './contract.js';
import type { AgentHost } from './contract.js';
import { enqueue } from './queue.js';
import { telemetryOn } from './gate.js';
import { installId, patchState, readState, repoId } from './identity.js';
import { runningVersion } from '../upkeep.js';
import { brand } from '../brand.js';

/** One queued event, exactly as it will be sent. */
export interface QueuedEvent {
  event: string;
  properties: Record<string, string>;
  /** ISO timestamp, so a batch flushed a day late still lands on the right day. */
  timestamp: string;
  /** The install id, used as PostHog's `distinct_id` at send time. */
  distinct_id: string;
}

export interface TrackContext {
  /** Repo root, when the call site has one — supplies `repo_id`. */
  repo?: string;
  /** Which surface is calling. Defaults to the CLI. */
  host?: AgentHost;
  /** Test seam: a scratch `$HOME`. Production callers never pass this. */
  home?: string;
  /** Test seam: an environment to gate against. Production callers never pass
   *  this — a real run must be gated on the real `DO_NOT_TRACK` and `CI`. */
  env?: NodeJS.ProcessEnv;
}

/** Variables Codex sets in the shell it runs commands in (as hosts/auto.ts reads them). */
const CODEX_ENV = ['CODEX_THREAD_ID', 'CODEX_SESSION_ID', 'CODEX_SANDBOX', 'CODEX_SANDBOX_NETWORK_DISABLED'];

/** Set by a hook for itself and the trail commands it starts: the agent its payload came from. */
export const HOST_ENV = 'TRAIL_AGENT_HOST';
const AGENT_HOSTS: readonly string[] = ['claude-code', 'claude-desktop', 'codex', 'cursor', 'copilot', 'mcp', 'cli'];

/** Claude Code in the desktop app's Code tab, or anywhere else. */
export function claudeHost(env: NodeJS.ProcessEnv = process.env): 'claude-desktop' | 'claude-code' {
  return env.CLAUDE_CODE_ENTRYPOINT === 'claude-desktop' ? 'claude-desktop' : 'claude-code';
}

/**
 * Which agent graft is running under, from the surface plus env probes.
 *
 * Only the PRESENCE of `CLAUDECODE` and Codex's variables is read, and
 * `CLAUDE_CODE_ENTRYPOINT` and `TRAIL_AGENT_HOST` only as equal or not to
 * fixed names — the distinction matters: a value could be anything a user's
 * shell profile put there, and none of it travels. Anything unrecognised is
 * `cli`, which is the honest answer.
 */
export function detectHost(explicit?: AgentHost, env: NodeJS.ProcessEnv = process.env): AgentHost {
  if (explicit) return explicit;
  const fromHook = env[HOST_ENV];
  if (fromHook && AGENT_HOSTS.includes(fromHook)) return fromHook as AgentHost;
  if (env.CLAUDECODE !== undefined || env.CLAUDE_CODE_ENTRYPOINT !== undefined) return claudeHost(env);
  if (CODEX_ENV.some((k) => env[k] !== undefined)) return 'codex';
  return 'cli';
}

/** The properties every event carries. Kept in one place so no call site can
 *  disagree about them. */
function commonProps(ctx: TrackContext): Record<string, string> {
  const props: Record<string, string> = {
    app_version: runningVersion(),
    os: process.platform,
    arch: process.arch,
    node_major: String(process.versions.node.split('.')[0]),
    ci: 'false', // an event only exists at all when the CI gate passed
    agent_host: detectHost(ctx.host, ctx.env ?? process.env),
    // `trail` or `graft`: which name started this process. The share of
    // queries under `trail` is how the rename is measured, and both names
    // share one install id, so nobody is counted twice.
    cli_name: brand(ctx.env ?? process.env),
  };
  if (ctx.repo) {
    try { props.repo_id = repoId(ctx.repo); } catch { /* unwritable cache — omit */ }
  }
  return props;
}

/**
 * Record one event, if the contract allows it and the gates are open.
 *
 * Returns the event that was queued, or null — the return value exists for
 * tests and for `graft telemetry debug`, not for control flow at call sites.
 */
export function track(
  event: string,
  props: Record<string, string | undefined> = {},
  ctx: TrackContext = {},
): QueuedEvent | null {
  try {
    if (!telemetryOn(ctx.home, ctx.env)) return null;
    // `Object.hasOwn`, not `EVENTS[event]`: a bare object literal inherits from
    // Object.prototype, so `EVENTS['constructor']` is truthy and would sail past
    // a plain existence check — only failing later, on a TypeError swallowed by
    // the catch below. The allowlist must reject by design, not by exception.
    if (!Object.hasOwn(EVENTS, event)) return null;
    const allowed = EVENTS[event];

    const properties = commonProps(ctx);
    for (const [k, v] of Object.entries(props)) {
      if (allowed.has(k) && typeof v === 'string' && allowedValue(event, k, v)) properties[k] = v;
    }

    const queued: QueuedEvent = {
      event,
      properties,
      timestamp: new Date().toISOString(),
      distinct_id: installId(ctx.home).id,
    };
    enqueue(queued, ctx.home);
    return queued;
  } catch {
    return null; // telemetry never surfaces as a user-visible failure
  }
}

/**
 * The `first_run` event, fired the once. Separate from `track` because its
 * trigger is a comparison against persisted state rather than anything a call
 * site knows.
 *
 * Gated on `firstRunAt` and NOT on `installId().firstRun`, which is the whole
 * reason this field exists: the npm postinstall hook mints the install id before
 * any command runs, so "did this call mint the id" is false on the genuine first
 * command and would have silenced this event permanently.
 */
export function trackFirstRunIfNew(ctx: TrackContext = {}): void {
  try {
    if (!telemetryOn(ctx.home, ctx.env)) return;
    if (readState(ctx.home)?.firstRunAt) return;
    track('first_run', {}, ctx);
    patchState({ firstRunAt: new Date().toISOString() }, ctx.home);
  } catch { /* never */ }
}

/**
 * The `install` event, fired from the npm postinstall hook.
 *
 * Once per machine per version: an upgrade is a real install and worth counting,
 * a second `npm install` of a version already recorded is not. Unique machines
 * are then distinct install ids, exactly as for every other event.
 *
 * Nothing here is an exception to the gates — a fork with no key, CI,
 * `DO_NOT_TRACK` and `graft telemetry disable` all still close it. It is only a
 * call site that happens to run outside a command.
 */
export function trackInstallIfNew(ctx: TrackContext & { global?: boolean } = {}): void {
  try {
    if (!telemetryOn(ctx.home, ctx.env)) return;
    const version = runningVersion();
    if (readState(ctx.home)?.installedVersion === version) return;
    track('install', { global: String(ctx.global ?? false) }, ctx);
    patchState({ installedVersion: version }, ctx.home);
  } catch { /* never */ }
}
