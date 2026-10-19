import { mkdirSync, writeFileSync, readFileSync, chmodSync, rmSync, rmdirSync, existsSync, appendFileSync } from 'node:fs';
import { join, dirname, resolve, isAbsolute } from 'node:path';
import { homedir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { disableGraftServerIn, installClaudeGlobal, type GlobalWrite } from '../hosts/claude-global.js';
import { mergeGraftSettings, mergeTrailShared, mergeTrailLocal } from './settings-merge.js';
import { statuslineShim, hooksShim, rememberInstall } from './shim-template.js';
import { skillTemplate } from './skill-template.js';
import { mergeJsonKey, serverEntry, type McpWrite } from '../hosts/mcp-config.js';
import { readJsonObject } from '../hosts/config-write.js';
import { ignoreInTrailDir } from '../notes/repo-trail.js';
export { ignoreInTrailDir };
import { hasGraftIndex } from '../graph/root.js';
import type { PlannedWrite } from '../hosts/plan.js';
import { repoWiredForTrail, type Brand } from '../brand.js';

/** trail's committed hook, inside `.trail/` where a `.claude/*` ignore rule can't drop it. */
export const TRAIL_HOOK = join('.trail', 'hook.cjs');
/** The status line's shim. Also in `.trail/`, but ignored there: only people with trail draw it. */
export const TRAIL_STATUSLINE = join('.trail', 'statusline.cjs');
/** Where trail's skill goes: the user's own `~/.claude`, never the repo. */
export function trailSkillPath(home: string = homedir()): string {
  return join(home, '.claude', 'skills', 'trail', 'SKILL.md');
}

/**
 * The files `runInit` writes — pure, no writes, so `--dry-run` and the picker
 * can report them up front.
 */
export function claudeTargets(dir: string, initBrand?: Brand, home?: string): PlannedWrite[] {
  return claudeTargetsFor(dir, wiringName(dir, initBrand), home);
}

/**
 * The name the Claude Code wiring goes by in `dir`: trail's where `trail init`
 * is wiring it now (`initBrand`) or already did, graft's everywhere else.
 * Otherwise decided by the repo, not the machine, so a teammate on graft
 * refreshing the wiring writes the same files and never flips them back.
 */
export function wiringName(dir: string, initBrand?: Brand): Brand {
  return initBrand === 'trail' || repoWiredForTrail(dir) ? 'trail' : 'graft';
}

/**
 * `claudeTargets` under one name.
 *
 * trail splits what it writes in two. Shared, committed once by whoever sets
 * the repo up: `.trail/hook.cjs` and one SessionStart entry in
 * `.claude/settings.json`, which is all a teammate without trail needs to be
 * shown the learnings and offered trail. Personal, where git never looks: the
 * status line and allowlist in `.claude/settings.local.json`, the skill in
 * `~/.claude/skills/`, and the other hooks in `~/.claude` (hosts/claude-global.ts).
 * No MCP server: the hooks and the `trail` command do what it did.
 */
export function claudeTargetsFor(dir: string, name: Brand, home: string = homedir()): PlannedWrite[] {
  if (name !== 'trail') return legacyClaudeTargets(dir, name);
  const t = (path: string, what: string): PlannedWrite => ({ hostId: 'claude', id: 'claude', path, scope: 'repo', kind: 'claude', what });
  return [
    t(join(dir, '.claude', 'settings.json'), 'trail SessionStart hook, shared'),
    t(join(dir, TRAIL_HOOK), 'hooks shim, shared'),
    t(join(dir, '.claude', 'settings.local.json'), 'trail statusline + allowlist, yours'),
    t(join(dir, TRAIL_STATUSLINE), 'statusline shim, git-ignored'),
    { hostId: 'claude', id: 'claude', path: trailSkillPath(home), scope: 'global', kind: 'claude', what: 'trail skill' },
  ];
}

/**
 * The layout every graft repo has, and trail repos had before 0.23: shims in
 * `.claude/helpers/`, the skill in `.claude/skills/`, the server in `.mcp.json`,
 * in that order. `runInit` writes it for graft; for trail it's what a refresh
 * clears away, and what uninstall removes under both names.
 */
export function legacyClaudeTargets(dir: string, name: Brand): PlannedWrite[] {
  const t = (path: string, what: string, kind: PlannedWrite['kind'] = 'claude'): PlannedWrite =>
    ({ hostId: 'claude', id: 'claude', path, scope: 'repo', kind, what });
  return [
    t(join(dir, '.claude', 'settings.json'), `${name} statusline + hook blocks`),
    t(join(dir, '.claude', 'helpers', `${name}-statusline.cjs`), 'statusline shim'),
    t(join(dir, '.claude', 'helpers', `${name}-hooks.cjs`), 'hooks shim'),
    t(join(dir, '.claude', 'skills', name, 'SKILL.md'), `${name} skill`),
    // Tagged 'mcp' so the picker doesn't label Claude Code as having no MCP.
    t(join(dir, '.mcp.json'), `mcpServers.${name}`, 'mcp'),
  ];
}

/**
 * Build the graph if it isn't there yet. Not Claude-specific: the wiring for any
 * host points at `graft/`, so `graft init` builds whichever hosts were selected —
 * this lives beside `runInit` only because that's the caller that owns `built`.
 * Best-effort; the user can always run `graft build` (the epilogue says so).
 */
export function buildGraphIfMissing(dir: string, opts: { build?: boolean; cliPath?: string }): boolean {
  // `hasGraftIndex`, not just wiring.json: a workspace parent's graph IS its
  // `workspace.json` (nodes live in the children), so testing for wiring.json
  // alone would call it unbuilt and rebuild every child on each init.
  if (opts.build === false || !opts.cliPath || hasGraftIndex(dir)) return false;
  try {
    // execArgv carries the loader graft itself was started with (tsx, when run
    // from source), so the child can run a .ts entry point too.
    execFileSync(process.execPath, [...process.execArgv, opts.cliPath, 'build', '.'], { cwd: dir, stdio: 'inherit', timeout: 300000 });
    return true;
  } catch {
    return false;
  }
}

export interface InitResult {
  settingsPath: string;
  shims: string[];
  /** Where the skill went; '' when nothing was written (trail under `--no-global`). */
  skill: string;
  /** the `.mcp.json` write registering the graft MCP server for Claude Code; trail writes none. */
  mcp: McpWrite | null;
  /** the user-level writes under `~/.claude`, empty when `global: false`. */
  global: GlobalWrite[];
  warnings: string[];
  built: boolean;
}

export function runInit(
  dir: string,
  opts: { build?: boolean; cliPath?: string; statusline?: boolean; global?: boolean; home?: string; brand?: Brand } = {},
): InitResult {
  if (wiringName(dir, opts.brand) === 'trail') return runTrailInit(dir, opts);
  // Same list `--dry-run` and the picker report, so the two can't drift apart.
  const [settings, statusline, hooks, skill, mcpTarget] = legacyClaudeTargets(dir, 'graft').map((t) => t.path);

  mkdirSync(dirname(statusline), { recursive: true });

  const settingsPath = settings;
  const existing = readSettings(settingsPath);
  const { merged, warnings } = mergeGraftSettings(existing, { statusline: opts.statusline, name: 'graft' });
  writeFileSync(settingsPath, `${JSON.stringify(merged, null, 2)}\n`);

  const sl = statusline;
  const hk = hooks;
  // The shims are committed, so they name nothing about this machine; where the
  // package lives here goes to the trail home instead, for them to find first.
  writeFileSync(sl, statuslineShim()); chmodSync(sl, 0o755);
  writeFileSync(hk, hooksShim()); chmodSync(hk, 0o755);
  rememberInstall(opts.home ?? homedir());

  // Install the graft skill — the piece that redirects the agent to graft/ before it
  // greps source. Overwritten each run (graft owns this file), like the shims above.
  const skillPath = skill;
  mkdirSync(dirname(skillPath), { recursive: true });
  writeFileSync(skillPath, skillTemplate('graft'));

  // Register the graft MCP server in the project's .mcp.json so Claude Code
  // exposes graft_find_code/graft_trace_calls/etc. as tools — the same keyed merge the
  // other hosts use (existing servers preserved; unparseable files skipped).
  const mcp = mergeJsonKey('claude', mcpTarget, 'mcpServers', serverEntry({ brand: 'graft' }), 'graft');

  // The same wiring again, one level up in `~/.claude`, because everything above
  // this line can be erased by a `.gitignore` and lost to `git worktree add`. See
  // hosts/claude-global.ts for the failure that motivates it. Gated on the same
  // flag `registerMcpConfigs` uses, so `--no-global` still means "nothing outside
  // this repo".
  const global = opts.global === false ? [] : installClaudeGlobal(opts.home ?? homedir(), 'graft');

  const built = buildGraphIfMissing(dir, opts);
  return { settingsPath, shims: [sl, hk], skill: skillPath, mcp, global, warnings, built };
}

function readSettings(path: string): Record<string, any> {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return {}; } // none/invalid → start fresh
}

/**
 * `runInit` for a repo on trail. Shared: `.trail/hook.cjs` and its one
 * SessionStart entry in `.claude/settings.json`. Personal: everything else.
 * Run again over a repo set up the old way, it moves it: the old shims, the
 * repo skill and trail's `.mcp.json` server go.
 */
function runTrailInit(
  dir: string,
  opts: { build?: boolean; cliPath?: string; statusline?: boolean; global?: boolean; home?: string },
): InitResult {
  const home = opts.home ?? homedir();
  const global = opts.global !== false;
  const [settings, hook, local, statusline, skill] = claudeTargetsFor(dir, 'trail', home).map((t) => t.path);

  mkdirSync(dirname(hook), { recursive: true });
  writeFileSync(hook, hooksShim()); chmodSync(hook, 0o755);
  writeFileSync(statusline, statuslineShim()); chmodSync(statusline, 0o755);
  ignoreInTrailDir(dir, 'statusline.cjs');
  rememberInstall(home);

  const shared = mergeTrailShared(readSettings(settings));
  mkdirSync(dirname(settings), { recursive: true });
  writeFileSync(settings, `${JSON.stringify(shared, null, 2)}\n`);

  // Hooks for every other event come from `~/.claude`. Only when that's off do
  // they go in the personal file, beside the status line.
  const { merged, warnings } = mergeTrailLocal(readSettings(local), { statusline: opts.statusline, hooks: !global });
  writeFileSync(local, `${JSON.stringify(merged, null, 2)}\n`);
  keepOutOfGit(dir, join('.claude', 'settings.local.json'));

  let skillPath = '';
  if (global) {
    mkdirSync(dirname(skill), { recursive: true });
    writeFileSync(skill, skillTemplate('trail'));
    skillPath = skill;
  }

  clearOldLayout(dir);

  const globalWrites = global ? installClaudeGlobal(home, 'trail') : [];
  // A trail repo on a machine with graft's server installed for everything:
  // graft goes off in this folder, so its tools don't show here.
  if (global) globalWrites.push(disableGraftServerIn(home, resolve(dir)));

  const built = buildGraphIfMissing(dir, opts);
  return { settingsPath: settings, shims: [statusline, hook], skill: skillPath, mcp: null, global: globalWrites, warnings, built };
}

/**
 * What trail wrote before 0.23 and doesn't any more: both names' shims in
 * `.claude/helpers/`, the skill in `.claude/skills/`, and trail's server in
 * `.mcp.json`. Settings entries are already gone: the merges replace them.
 */
function clearOldLayout(dir: string): void {
  for (const n of ['graft', 'trail'] as const) {
    const [, oldSl, oldHk, oldSkill] = legacyClaudeTargets(dir, n).map((t) => t.path);
    rmSync(oldSl, { force: true });
    rmSync(oldHk, { force: true });
    rmSync(dirname(oldSkill), { recursive: true, force: true });
  }
  // The folders they were in, once nothing else is: rmdir refuses a non-empty one.
  for (const d of [join(dir, '.claude', 'helpers'), join(dir, '.claude', 'skills')]) {
    try { rmdirSync(d); } catch { /* holds the user's files, or was never there */ }
  }
  dropServer(join(dir, '.mcp.json'), ['trail', 'graft']);
}

/** Take trail's (or graft's) server out of an `.mcp.json`; the file goes if nothing else was in it. */
function dropServer(path: string, names: string[]): void {
  try {
    const loaded = readJsonObject(path);
    if (loaded === 'unparseable' || !loaded.existed) return;
    const root = loaded.root;
    const servers = root.mcpServers;
    if (!servers || typeof servers !== 'object' || !names.some((n) => n in servers)) return;
    for (const n of names) delete servers[n];
    if (Object.keys(servers).length === 0) delete root.mcpServers;
    if (Object.keys(root).length === 0) rmSync(path, { force: true });
    else writeFileSync(path, `${JSON.stringify(root, null, 2)}\n`);
  } catch { /* leave it as the user has it */ }
}

/**
 * Keep a personal file out of git without touching the repo's `.gitignore`:
 * if nothing ignores it already, it goes in `.git/info/exclude`, which is
 * never committed. A folder that isn't a git checkout is left alone.
 */
export function keepOutOfGit(dir: string, rel: string): void {
  try {
    execFileSync('git', ['check-ignore', '-q', '--', rel], { cwd: dir, stdio: 'ignore' });
    return; // exit 0: already ignored
  } catch (e) {
    if ((e as { status?: number }).status !== 1) return; // 128: not a git checkout
  }
  try {
    let exclude = execFileSync('git', ['rev-parse', '--git-path', 'info/exclude'], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    if (!isAbsolute(exclude)) exclude = join(dir, exclude);
    const line = `/${rel.split('\\').join('/')}`;
    const text = existsSync(exclude) ? readFileSync(exclude, 'utf8') : '';
    if (text.split('\n').some((l) => l.trim() === line)) return;
    mkdirSync(dirname(exclude), { recursive: true });
    appendFileSync(exclude, `${text && !text.endsWith('\n') ? '\n' : ''}${line}\n`);
  } catch { /* best-effort: git status shows the file, and nothing else breaks */ }
}
