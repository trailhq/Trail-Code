/**
 * Self-maintenance: keeping an installed graft, and the wiring it wrote, current.
 *
 * Two independent kinds of staleness, both invisible to the user today:
 *
 *   1. **Binary staleness** — they installed once and never upgraded. `graft
 *      version` would tell them, but nobody runs it. So we keep a cached,
 *      machine-global registry answer and let every entry point surface a
 *      one-line nudge from it.
 *
 *   2. **Wiring staleness** — `graft init` copies hooks, shims, skill text and
 *      rule files INTO the repo. `npm i -g` replaces the binary but touches none
 *      of them, so a repo wired by 0.7 keeps 0.7's prompts and 0.7's hook
 *      timeouts forever (see the comment on `promptAskTimeout`, which exists
 *      only to work around exactly this). A version stamp written next to the
 *      graph lets any entry point notice the skew and re-run the writes.
 *
 * Everything here is fail-soft by construction: it runs inside hooks and inside
 * the MCP server's boot path, where a throw is a broken session, and it must
 * never block on the network — the registry is only ever read from cache, and
 * the refresh happens in a detached child.
 *
 * Called from all three hosts' entry points so no editor is left out:
 *   • Claude Code   — `session-start` hook (src/claude/hooks.ts)
 *   • Cursor/Codex  — MCP server boot (src/mcp/server.ts), and any CLI command
 */
import { existsSync, readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { readJson, writeJsonAtomic, cacheDir } from './util/state.js';
import { HOSTS, hostRelPath } from './hosts/registry.js';
import { markersFor } from './hosts/sections.js';
import { getNpmViewVersion, readCurrentVersion } from './cli-meta.js';
import { brand } from './brand.js';
import { graftCliPath } from './claude/paths.js';

/**
 * The version of the graft package this code was loaded from.
 *
 * Resolved from *this* module rather than the caller's: `readCurrentVersion`
 * looks one level up from the module URL it's given, which lands on the package
 * root for `dist/upkeep.js` but misses entirely for `dist/claude/hooks.js` and
 * `dist/mcp/server.js`. Every caller asking here instead of passing its own
 * `import.meta.url` is what keeps the hook and the MCP server from reading
 * `0.0.0` and re-initing on every single session.
 */
export function runningVersion(): string {
  try { return readCurrentVersion(import.meta.url); } catch { return '0.0.0'; }
}

/** How long a registry answer is considered current. A day: graft ships far less
 * often than that, and this is a nudge, not a security update. */
export const UPDATE_TTL_MS = 24 * 60 * 60 * 1000;

/* -------------------------------------------------------------------------- */
/* version comparison                                                         */
/* -------------------------------------------------------------------------- */

/** Numeric-dotted compare of the release part only (`1.2.3-beta.1` → `1.2.3`).
 * Prerelease ordering doesn't matter here: the only question either caller asks
 * is "is the thing on npm ahead of what's on disk", and a prerelease that
 * compares equal simply produces no nudge. */
export function compareVersions(a: string, b: string): number {
  const parts = (v: string) => String(v).split('-')[0].split('.').map((n) => Number(n) || 0);
  const pa = parts(a);
  const pb = parts(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

export function isNewer(candidate: string | null | undefined, current: string): boolean {
  if (!candidate) return false;
  return compareVersions(candidate, current) > 0;
}

/* -------------------------------------------------------------------------- */
/* the cached registry answer (machine-global)                                */
/* -------------------------------------------------------------------------- */

export interface UpdateCache {
  /** Latest version seen on npm, or null when the last fetch failed. */
  latest: string | null;
  /** Epoch ms of the last *attempt* — written by the parent before it spawns the
   * fetch, so a repeatedly-failing fetch can't make every command spawn a child. */
  checkedAt: number;
}

/** Machine-global, not per-repo: "what's the latest graft" is one fact, and a
 * dev with twelve repos should cost the registry one request a day, not twelve. */
export function updateCachePath(home: string = homedir()): string {
  return join(home, '.graft', 'update-check.json');
}

export function readUpdateCache(home?: string): UpdateCache | null {
  return readJson<UpdateCache>(updateCachePath(home));
}

function writeUpdateCache(cache: UpdateCache, home?: string): void {
  try { writeJsonAtomic(updateCachePath(home), cache); } catch { /* unwritable home — skip */ }
}

/**
 * The `graft _update-check` command body: hit the registry, store the answer.
 * Runs in a detached child so nothing user-facing ever waits on the network.
 */
export function refreshUpdateCache(home?: string, now = Date.now()): UpdateCache {
  const res = getNpmViewVersion();
  const cache: UpdateCache = { latest: res.ok ? (res.version ?? null) : null, checkedAt: now };
  writeUpdateCache(cache, home);
  return cache;
}

/** True when the cached answer is missing or older than the TTL. */
export function needsRefresh(cache: UpdateCache | null, now = Date.now()): boolean {
  return !cache || typeof cache.checkedAt !== 'number' || now - cache.checkedAt >= UPDATE_TTL_MS;
}

/**
 * Kick off a background registry check if the cache has gone stale. Touches
 * `checkedAt` first so concurrent callers (and a child that dies) don't spawn a
 * fetch per invocation. Never waits, never throws.
 *
 * Only called from long-lived or already-slow contexts (a CLI command, MCP
 * boot) — never from a hook, which reads the cache and nothing else.
 */
export function maybeRefreshInBackground(home?: string, now = Date.now()): boolean {
  const cache = readUpdateCache(home);
  if (!needsRefresh(cache, now)) return false;
  writeUpdateCache({ latest: cache?.latest ?? null, checkedAt: now }, home);
  try {
    const child = spawn(process.execPath, [graftCliPath(), '_update-check'], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.unref();
    return true;
  } catch {
    return false; // no spawn (sandbox, ENOMEM) — the nudge just uses the old cache
  }
}

/** One line, or nothing. Nothing is the common case — don't spend context on
 * "you're up to date". */
export function formatUpdateNudge(current: string, latest: string | null | undefined): string | null {
  if (!isNewer(latest, current)) return null;
  // `upgrade`, not a bare npm install: under graft it brings the trail command along.
  return `⬆ ${brand()} ${current} → ${latest} available: run \`${brand()} upgrade\` (restart your agent after).`;
}

/* -------------------------------------------------------------------------- */
/* the wiring stamp                                                           */
/* -------------------------------------------------------------------------- */

/**
 * The subset of `graft init`'s flags a refresh has to replay.
 *
 * Without these, an auto-refresh would install things the user explicitly
 * declined: someone who ran `graft init --no-global` (or `--no-hooks`, or
 * `--no-statusline`) said "keep out of `~/.codex`" / "leave my statusline
 * alone", and a later session silently writing there would be graft overriding a
 * decision rather than maintaining one. Absent from an older stamp → all true,
 * which is what plain `graft init` does.
 */
export interface WiringOpts {
  /** false → never write outside the repo (`--no-global`). */
  global: boolean;
  /** false → skip MCP server registration (`--no-mcp`). */
  mcp: boolean;
  /** false → skip hook installation (`--no-hooks`). */
  hooks: boolean;
  /** false → skip Claude Code statusLine (`--no-statusline` / GRAFT_NO_STATUSLINE). */
  statusline: boolean;
}

export const DEFAULT_WIRING_OPTS: WiringOpts = { global: true, mcp: true, hooks: true, statusline: true };

/** An older stamp has no `opts`; a plain `graft init` wired everything. */
export function wiringOpts(stamp: WiringStamp | null): WiringOpts {
  return { ...DEFAULT_WIRING_OPTS, ...(stamp?.opts ?? {}) };
}

export interface WiringStamp {
  /** The graft version whose `init` wrote this repo's agent files. */
  version: string;
  /** Host ids that were wired, so a refresh re-writes exactly those and never
   * silently adopts an agent the user declined in the picker. */
  hosts: string[];
  /** The init flags to replay — see {@link WiringOpts}. */
  opts?: Partial<WiringOpts>;
  at: string;
}

/** Under `graft/.cache/`, beside the other derived state: git-ignored, per-clone,
 * and cheap to lose — a missing stamp just means one idempotent refresh. */
export function stampPath(repo: string): string {
  return join(cacheDir(repo), 'wiring-stamp.json');
}

export function readStamp(repo: string): WiringStamp | null {
  return readJson<WiringStamp>(stampPath(repo));
}

export function writeStamp(
  repo: string,
  version: string,
  hosts: string[],
  opts: Partial<WiringOpts> = {},
  at = new Date().toISOString(),
): void {
  try {
    writeJsonAtomic(stampPath(repo), {
      version,
      hosts: [...hosts].sort(),
      opts: { ...DEFAULT_WIRING_OPTS, ...opts },
      at,
    } satisfies WiringStamp);
  } catch { /* unwritable graft/ — a refresh will just be retried next session */ }
}

/**
 * Which agents this repo is *already* wired for, read off disk rather than
 * re-detected. Detection answers "which editors does this machine have"; for a
 * refresh we need "which files did a previous init actually write" — otherwise
 * installing Windsurf once would silently add graft rules to every repo.
 */
export function wiredHostIds(repo: string): string[] {
  const ids: string[] = [];
  if (existsSync(join(repo, '.trail', 'hook.cjs')) || ['graft', 'trail'].some((n) => existsSync(join(repo, '.claude', 'helpers', `${n}-hooks.cjs`)))) ids.push('claude');
  for (const host of HOSTS) {
    // Under either name: a repo on trail has trail's files and blocks.
    const wired = (['graft', 'trail'] as const).some((n) => {
      const path = join(repo, hostRelPath(host, n));
      if (!existsSync(path)) return false;
      // A shared file (AGENTS.md, GEMINI.md) counts only if graft's fenced section
      // is in it — the user may own the file for entirely unrelated reasons.
      if (host.kind === 'section') {
        try { return readFileSync(path, 'utf8').includes(markersFor(n).start); } catch { return false; }
      }
      return true;
    });
    if (wired) ids.push(host.id);
  }
  return ids;
}

export interface WiringRefresh {
  from: string;
  to: string;
  hosts: string[];
  /** True when the refresh included writes outside the repo (`~/.codex/`), so the
   * caller can say so — a session changing machine-wide config should be visible. */
  global: boolean;
  /** True when it moved a repo wired as graft over to trail. */
  switched?: boolean;
}

/**
 * Re-run init's writes when the stamp and the running binary disagree.
 *
 * Deliberately narrow: it refreshes the hosts already wired, replays the flags
 * that init was given, never builds the graph (this runs at session start — a
 * rebuild there would stall the agent's first turn), and no-ops when the repo has
 * no graft wiring at all.
 *
 * `toTrail` says whether this repo should move from graft's wiring to trail's
 * (see upkeep-run.ts). When it should, the refresh runs whatever the stamp says:
 * the person installed trail, which is the signal, whether or not graft's own
 * version moved.
 */
export function reconcileWiring(
  repo: string,
  current: string,
  deps: {
    wired?: (repo: string) => string[];
    rewrite: (repo: string, hosts: string[], opts: WiringOpts, toTrail: boolean) => void;
    toTrail?: (repo: string) => boolean;
  },
): WiringRefresh | null {
  try {
    const stamp = readStamp(repo);
    const toTrail = deps.toTrail?.(repo) ?? false;
    if (stamp && stamp.version === current && !toTrail) return null;
    // The stamp is the record of *intent* (what the picker chose); disk is the
    // fallback for repos wired before stamps existed. Union, not just disk:
    // otherwise a host whose rule file went missing — deleted by hand, lost to a
    // merge, or clobbered by another tool — is silently dropped from every future
    // refresh, and that file is precisely what a refresh exists to restore.
    const onDisk = (deps.wired ?? wiredHostIds)(repo);
    const hosts = [...new Set([...(stamp?.hosts ?? []), ...onDisk])].sort();
    if (hosts.length === 0) return null; // never wired here — not our business
    const opts = wiringOpts(stamp);
    deps.rewrite(repo, hosts, opts, toTrail);
    writeStamp(repo, current, hosts, opts);
    return { from: stamp?.version ?? 'unwired', to: current, hosts, global: opts.global, ...(toTrail ? { switched: true } : {}) };
  } catch {
    return null; // a refresh is an optimization; never fail the caller over it
  }
}

export function formatWiringRefresh(r: WiringRefresh | null): string | null {
  if (!r) return null;
  // Said to the agent at session start, which is who can tell the person.
  if (r.switched)
    return (
      `[trail] graft is now trail, and this repo just moved to it: the same commands under the new name, plus learnings in .trail/learnings/ that the whole team shares. ` +
      `trail is reading the user's past Claude sessions here in the background, and what it learns is there from the next session. ` +
      `Tell the user this once, in a line at the end of your first reply, and that committing .trail/ and .claude/settings.json once moves their team over too.`
    );
  // Name the out-of-repo writes explicitly: those are machine-wide and shared by
  // every repo, so a user seeing this line should not have to guess what moved.
  const scope = r.global && r.hosts.includes('agents') ? " (including this machine's ~/.codex config)" : '';
  return `· graft refreshed this repo's agent wiring${scope} (written by ${r.from}, now ${r.to}): ${r.hosts.join(', ')}.`;
}
