/**
 * Multi-host init: write each selected host's instruction file.
 * Selection = explicit ids > all > detected. Claude Code is handled
 * separately by src/claude/init.ts (hooks + statusline + skill).
 */
import { statSync, writeFileSync, readFileSync, mkdirSync, existsSync, rmSync, rmdirSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { HOSTS, detectHosts, hostRelPath, hostWiringName, type DetectProbe, type HostTarget } from './registry.js';
import { GRAFT_MARKERS, markersFor, upsertSection } from './sections.js';
import type { Brand } from '../brand.js';
import { registerMcpConfigs, type McpWrite } from './mcp-config.js';
import { installCodexHooks } from './codex-hooks.js';
import { installCursorHooks } from './cursor-hooks.js';
import type { ConfigWrite } from './config-write.js';
import { installAntigravitySkill } from './antigravity.js';
import { rememberInstall } from '../claude/shim-template.js';

export interface HostsInitResult {
  written: { id: string; path: string; action: string }[];
  skipped: string[];
  unknown: string[];
  mcp: McpWrite[];
  hooks: ConfigWrite[];
}

function probeFor(home: string, repo: string): DetectProbe {
  return {
    home, repo,
    dirExists: (p) => { try { return statSync(p).isDirectory(); } catch { return false; } },
  };
}

function writeOwned(path: string, content: string): string {
  if (existsSync(path) && readFileSync(path, 'utf8') === content) return 'unchanged';
  mkdirSync(dirname(path), { recursive: true });
  const existed = existsSync(path);
  writeFileSync(path, content);
  return existed ? 'replaced' : 'created';
}

/**
 * A graft-named file a host owned, gone now that the repo uses trail's names,
 * with its `graft/` folder when that was all the folder held.
 */
function removeGraftCopy(path: string): void {
  rmSync(path, { force: true });
  if (basename(dirname(path)) === 'graft') {
    try { rmdirSync(dirname(path)); } catch { /* not empty, or not there */ }
  }
}

export function runHostsInit(
  repo: string,
  opts: {
    agents?: string[];
    all?: boolean;
    home?: string;
    mcp?: boolean;
    hooks?: boolean;
    /** false → skip every write outside the repo (the ~/.codex/ targets). */
    global?: boolean;
    /** The name `init` runs under; trail's moves the repo to trail's names (see `hostWiringName`). */
    brand?: Brand;
  } = {},
): HostsInitResult {
  const home = opts.home ?? homedir();
  const probe = probeFor(home, repo);
  const name = hostWiringName(repo, opts.brand);

  let selected: HostTarget[];
  let unknown: string[] = [];
  if (opts.agents !== undefined) {
    const byId = new Map(HOSTS.map((h) => [h.id, h]));
    selected = opts.agents.flatMap((id) => byId.get(id) ?? []);
    unknown = opts.agents.filter((id) => !byId.has(id));
  } else if (opts.all) {
    selected = HOSTS;
  } else {
    selected = detectHosts(probe);
  }

  const written: HostsInitResult['written'] = [];
  for (const host of selected) {
    const path = join(repo, hostRelPath(host, name));
    // Under trail, graft's copy of an owned file goes and graft's fenced
    // block becomes trail's, so the agent reads the instructions once.
    const action =
      host.kind === 'owned'
        ? writeOwned(path, host.content(name))
        : upsertSection(path, host.content(name), markersFor(name), name === 'trail' ? [GRAFT_MARKERS] : []).action;
    if (name === 'trail' && host.kind === 'owned') removeGraftCopy(join(repo, host.relPath));
    written.push({ id: host.id, path, action });
  }
  const skipped = HOSTS.filter((h) => !selected.includes(h)).map((h) => h.id);
  const mcp =
    opts.mcp === false
      ? []
      : registerMcpConfigs(repo, selected.map((h) => h.id), { home, global: opts.global, name });
  // The Codex hook targets are user-level (~/.codex), so --no-global suppresses them.
  const hooks =
    opts.hooks === false || opts.global === false || !selected.some((h) => h.id === 'agents')
      ? []
      : installCodexHooks(home);
  // Cursor's hooks are repo-local (.cursor/hooks.json), matching the Cursor-only,
  // no-global posture — so --no-global does NOT suppress them; only --no-hooks does.
  const cursorHooks =
    opts.hooks === false || !selected.some((h) => h.id === 'cursor')
      ? []
      : installCursorHooks(repo, name);
  // Both write the hooks shim, which finds this install through the trail home.
  if (hooks.length > 0 || cursorHooks.length > 0) rememberInstall(home);
  // Antigravity's skill is a global write too, so --no-global suppresses it as well.
  const antigravitySkill =
    opts.global === false || !selected.some((h) => h.id === 'antigravity')
      ? []
      : installAntigravitySkill(home, name);
  return { written, skipped, unknown, mcp, hooks: [...hooks, ...cursorHooks, ...antigravitySkill] };
}
