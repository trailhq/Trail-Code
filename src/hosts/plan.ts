/**
 * What `graft init` *would* write, computed before anything is written.
 *
 * The picker and `--dry-run` both need the exact path list up front, so every
 * writer in the init path (instruction files, MCP configs, hooks, the Claude
 * Code layer) exposes a pure `*Targets()` function and then consumes that same
 * list to do its writing. One source of truth, so a plan can never drift from
 * what a real run touches.
 */
import { join } from 'node:path';
import { homedir } from 'node:os';
import { statSync } from 'node:fs';
import { HOSTS, detectHosts, hostRelPath, hostWiringName, type DetectProbe, type HostTarget } from './registry.js';
import { mcpTargets } from './mcp-config.js';
import { hookTargets } from './codex-hooks.js';
import { cursorHookTargets } from './cursor-hooks.js';
import { antigravitySkillTargets } from './antigravity.js';
import { claudeTargets } from '../claude/init.js';
import { brand, type Brand } from '../brand.js';
import { claudeGlobalTargets } from './claude-global.js';

/** Where a write lands. 'global' = outside the repo, affects every project. */
export type WriteScope = 'repo' | 'global';

export interface PlannedWrite {
  /** The selectable host this write belongs to ('claude', 'agents', 'cursor', …). */
  hostId: string;
  /** Reporting id — differs from hostId where one host writes several configs
   *  (the 'agents' host covers both 'codex' and 'opencode'). */
  id: string;
  path: string;
  scope: WriteScope;
  kind: 'instruction' | 'mcp' | 'hook' | 'claude' | 'skill';
  /** Short human label for what changes in that file. */
  what: string;
}

export interface HostPlan {
  id: string;
  name: string;
  detected: boolean;
  writes: PlannedWrite[];
}

function probeFor(home: string, repo: string): DetectProbe {
  return {
    home, repo,
    dirExists: (p) => { try { return statSync(p).isDirectory(); } catch { return false; } },
  };
}

/** The instruction-file write for one host, derived from its registry entry. */
function instructionTarget(repo: string, host: HostTarget, name: Brand): PlannedWrite {
  return {
    hostId: host.id,
    id: host.id,
    path: join(repo, hostRelPath(host, name)),
    scope: 'repo',
    kind: 'instruction',
    what: host.kind === 'owned' ? `${name}-owned file` : `fenced ${name} section`,
  };
}

/**
 * Every host graft can wire, each with the full set of files selecting it would
 * touch. Claude Code comes first — it's the deep integration and the picker's
 * default. `ids`, when given, restricts the plan to those hosts.
 */
export function planInit(repo: string, opts: { home?: string; ids?: string[] } = {}): HostPlan[] {
  const home = opts.home ?? homedir();
  const probe = probeFor(home, repo);
  const detected = new Set(detectHosts(probe).map((h) => h.id));
  const name = hostWiringName(repo, brand());

  const plans: HostPlan[] = [
    // Repo writes plus the user-level copy under `~/.claude` — the picker and
    // `--dry-run` render 'global' writes in their own section, so a user sees
    // what lands outside the repo before agreeing to it.
    { id: 'claude', name: 'Claude Code', detected: true, writes: [...claudeTargets(repo, brand()), ...claudeGlobalTargets(home, brand())] },
    ...HOSTS.map((host) => ({
      id: host.id,
      name: host.name,
      detected: detected.has(host.id),
      writes: [
        instructionTarget(repo, host, name),
        ...mcpTargets(repo, [host.id], { home, name }),
        ...(host.id === 'agents' ? hookTargets(home) : []),
        ...(host.id === 'cursor' ? cursorHookTargets(repo, name) : []),
        ...(host.id === 'antigravity' ? antigravitySkillTargets(home, name) : []),
      ],
    })),
  ];

  return opts.ids ? plans.filter((p) => opts.ids!.includes(p.id)) : plans;
}

/** Flatten a plan down to the writes for the selected host ids. */
export function selectedWrites(plan: HostPlan[], ids: string[]): PlannedWrite[] {
  return plan.filter((p) => ids.includes(p.id)).flatMap((p) => p.writes);
}
