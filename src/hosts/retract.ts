/**
 * Retraction: undo every edit graft has ever made to a repo.
 *
 * `init` is additive — it writes the files the *currently selected* hosts need
 * and never looks at the rest. So a repo wired by an older version (or by the
 * same version with different `--agents`) keeps the files that run produced,
 * and the two sets accumulate. Retraction is the missing half: it walks every
 * target graft could ever have written and removes graft's contribution, so
 * `retract` + `init` converges the repo on exactly this version's intent.
 *
 * The target list is derived from the same registries `init` writes through
 * (`HOSTS`, `mcpTargets`, `hookTargets`, `claudeTargets`), so a host added
 * later is retractable for free — there is no second list to keep in sync.
 * Only {@link LEGACY_TARGETS} is hand-maintained, and only for paths that have
 * been *removed* from those registries: once a host is gone, nothing else
 * remembers the file it used to write.
 *
 * Two invariants, both load-bearing:
 *   1. Never delete what graft did not write. Inside a file the user owns, only
 *      the marker-fenced region and graft-named keys are touched; foreign MCP
 *      servers, hooks, and settings are preserved byte for byte.
 *   2. Never leave an empty shell. A file that held nothing but graft's
 *      contribution is deleted, not truncated to `{}` or a blank document —
 *      an orphan file is the very residue this exists to remove.
 */
import { readFileSync, writeFileSync, existsSync, rmSync, rmdirSync, statSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { HOSTS, hostRelPath } from './registry.js';
import { ALL_MARKERS, type Markers } from './sections.js';
import { mcpTargets, stripTomlSection } from './mcp-config.js';
import { hookTargets } from './codex-hooks.js';
import { cursorHookTargets } from './cursor-hooks.js';
import { piHookTargets } from './pi-hooks.js';
import { antigravitySkillTargets } from './antigravity.js';
import { claudeGlobalTargets } from './claude-global.js';
import { claudeTargetsFor, legacyClaudeTargets, TRAIL_HOOK, TRAIL_STATUSLINE, trailSkillPath } from '../claude/init.js';
import { isGraftAllowEntry, isGraftFooterRegex } from '../claude/settings-merge.js';
import type { WriteScope } from './plan.js';
import type { Brand } from '../brand.js';

/** Both names a file can go by: graft's, and trail's in a repo that uses trail. */
const NAMES: readonly Brand[] = ['graft', 'trail'];

/** What a retraction did to one target. */
export type RetractAction =
  /** graft's contribution was there and is now gone. */
  | 'removed'
  /** the whole file was graft's, so the file itself is gone. */
  | 'deleted'
  /** nothing of graft's here. */
  | 'absent'
  /** file exists but can't be parsed — left untouched rather than risk it. */
  | 'skipped-unparseable';

export interface Retraction {
  /** The host this target belongs to, for grouping the report. */
  hostId: string;
  path: string;
  /** Short human label for what was removed from that file. */
  what: string;
  scope: WriteScope;
  action: RetractAction;
}

export interface RetractOpts {
  home?: string;
  /** false → report only, touch nothing. Defaults to false: a destructive
   *  operation must be asked for, never assumed. */
  apply?: boolean;
  /** false → skip targets outside the repo (the ~/.codex and ~/.gemini writes). */
  global?: boolean;
  /** false → keep `graft/` and the ignore entries. `init` sets this: the cache is
   *  regenerable but re-parsing a large repo costs minutes, and init is about to
   *  use it. */
  cache?: boolean;
  /** Host ids about to be re-written, so their targets are left alone. `init`
   *  passes its selection: retracting a file it is one step from rewriting is
   *  pure churn (and would report every write as `created`). */
  exclude?: string[];
}

/**
 * Paths that older versions wrote and the live registries no longer mention.
 * Empty today — every host in `HOSTS` since the multi-host layer landed is
 * still there, and the marker string and the `graft` name have never changed,
 * so the derived list covers every version to date.
 *
 * This is where a *removed* host's file goes. Deleting an entry from `HOSTS`
 * without adding it here is what strands a file in every existing repo.
 */
const LEGACY_TARGETS: { relPath: string; kind: 'owned' | 'section'; what: string }[] = [];

// ---------------------------------------------------------------------------
// primitive operations
// ---------------------------------------------------------------------------

/** True when a file has no non-whitespace content left. */
function isBlank(text: string): boolean {
  return text.trim() === '';
}

function removeFile(path: string, apply: boolean): RetractAction {
  if (!existsSync(path)) return 'absent';
  if (apply) {
    rmSync(path, { force: true });
    pruneEmptyDirs(dirname(path));
  }
  return 'deleted';
}

/**
 * Walk up from a just-emptied directory removing empty ancestors, so retracting
 * `.claude/skills/graft/SKILL.md` doesn't leave a hollow `skills/graft/` behind.
 * Stops at the first non-empty directory — never climbs out of the repo, because
 * any ancestor that far up has other content in it.
 */
function pruneEmptyDirs(dir: string): void {
  for (let d = dir, i = 0; i < 6; i++) {
    try {
      if (readdirSync(d).length > 0) return;
      rmdirSync(d); // throws on a non-empty dir — exactly the guard we want
    } catch {
      return; // not a dir, not empty, or not ours to remove
    }
    const parent = dirname(d);
    if (parent === d) return;
    d = parent;
  }
}

/**
 * Strip the marker-fenced graft block from a file the user owns.
 *
 * Paragraph spacing around the removed block is collapsed back to a single
 * blank line, so a file that had prose either side of the block reads exactly
 * as it did before graft appended to it.
 */
function stripSection(path: string, apply: boolean, markers: Markers[] = ALL_MARKERS): RetractAction {
  if (!existsSync(path)) return 'absent';
  const text = readFileSync(path, 'utf8');
  // Every region graft may own, not just the instruction block. A file can hold
  // both the instructions and a brain's rules, and leaving one behind would
  // strand rules in a repo the user has uninstalled graft from.
  if (!markers.some((m) => text.includes(m.start))) return 'absent';
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r\n|\n/);
  const out: string[] = [];
  let closing: string | null = null;
  let found = false;
  for (const line of lines) {
    const t = line.trim();
    if (closing === null) {
      const open = markers.find((m) => m.start === t);
      if (open) { closing = open.end; found = true; continue; }
    } else {
      if (t === closing) closing = null;
      continue;
    }
    out.push(line);
  }
  if (!found) return 'absent';
  // Collapse the run of blank lines the block left behind, and trim the edges.
  const collapsed = out
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^\n+/, '')
    .replace(/\n+$/, '\n');
  if (!apply) return isBlank(collapsed) ? 'deleted' : 'removed';
  if (isBlank(collapsed)) return removeFile(path, true);
  writeFileSync(path, eol === '\n' ? collapsed : collapsed.replace(/\n/g, '\r\n'));
  return 'removed';
}

/**
 * Delete `<topKey>.graft` from a JSON config, preserving every other server.
 * An unparseable file is reported and left alone — the user may have comments or
 * a half-finished edit in there, and rewriting it would lose more than it fixes.
 */
function removeJsonKey(path: string, topKey: string, apply: boolean): RetractAction {
  if (!existsSync(path)) return 'absent';
  let root: Record<string, unknown>;
  try {
    root = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return 'skipped-unparseable';
  }
  if (typeof root !== 'object' || root === null || Array.isArray(root)) return 'skipped-unparseable';
  const bucket = root[topKey];
  if (typeof bucket !== 'object' || bucket === null || Array.isArray(bucket)) return 'absent';
  const map = bucket as Record<string, unknown>;
  // Either name: a repo that uses trail registers the server as `trail`.
  const ours = ['graft', 'trail'].filter((k) => k in map);
  if (ours.length === 0) return 'absent';
  if (!apply) {
    return Object.keys(map).length === ours.length && Object.keys(root).length === 1 ? 'deleted' : 'removed';
  }
  for (const k of ours) delete map[k];
  if (Object.keys(map).length === 0) delete root[topKey];
  if (Object.keys(root).length === 0) return removeFile(path, true);
  writeFileSync(path, `${JSON.stringify(root, null, 2)}\n`);
  return 'removed';
}

/**
 * Delete the `[mcp_servers.graft]` and `[mcp_servers.trail]` tables from a TOML config.
 *
 * Line-based on purpose: a real TOML parse-and-reserialize would reformat the
 * user's whole file. The table runs from its header to the next `[`-header or
 * EOF, which is exactly what `upsertCodexToml` appends.
 */
function removeTomlSection(path: string, apply: boolean): RetractAction {
  if (!existsSync(path)) return 'absent';
  const graft = stripTomlSection(readFileSync(path, 'utf8'), 'graft');
  const trail = stripTomlSection(graft.rest, 'trail');
  const kept = trail.rest;
  if (!graft.found && !trail.found) return 'absent';
  if (!apply) return isBlank(kept) ? 'deleted' : 'removed';
  if (isBlank(kept)) return removeFile(path, true);
  writeFileSync(path, kept.endsWith('\n') ? kept : `${kept}\n`);
  return 'removed';
}

/**
 * Remove graft's fragments from `.claude/settings.json`, keeping the user's.
 *
 * The statusline check is by *shim path*, not exact string equality: an older
 * version's command differed in shape, and `mergeGraftSettings` would read that
 * as a hand-written statusline and refuse to touch it forever. Matching the
 * helper path recognizes graft's own output across every version that wrote it.
 */
function stripClaudeSettings(path: string, apply: boolean): RetractAction {
  if (!existsSync(path)) return 'absent';
  let root: Record<string, any>;
  try {
    root = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return 'skipped-unparseable';
  }
  if (typeof root !== 'object' || root === null || Array.isArray(root)) return 'skipped-unparseable';
  const before = JSON.stringify(root);
  const isGraftCmd = (v: unknown) => /(graft|trail)-statusline\.cjs|\.trail\/statusline\.cjs/.test(JSON.stringify(v ?? ''));

  for (const key of ['statusLine', 'subagentStatusLine']) {
    if (root[key] !== undefined && isGraftCmd(root[key])) delete root[key];
  }

  if (root.hooks && typeof root.hooks === 'object' && !Array.isArray(root.hooks)) {
    for (const event of Object.keys(root.hooks)) {
      const prior = root.hooks[event];
      if (!Array.isArray(prior)) continue;
      const kept = prior.filter((e: unknown) => !/(graft|trail)-hooks\.cjs|\/\.trail\/hook\.cjs/.test(JSON.stringify(e ?? '')));
      if (kept.length === 0) delete root.hooks[event];
      else root.hooks[event] = kept;
    }
    if (Object.keys(root.hooks).length === 0) delete root.hooks;
  }

  if (Array.isArray(root.footerLinksRegexes)) {
    const kept = root.footerLinksRegexes.filter((r: unknown) => !isGraftFooterRegex(r));
    if (kept.length === 0) delete root.footerLinksRegexes;
    else root.footerLinksRegexes = kept;
  }

  if (root.permissions && Array.isArray(root.permissions.allow)) {
    const kept = root.permissions.allow.filter((a: unknown) => !isGraftAllowEntry(a));
    if (kept.length === 0) delete root.permissions.allow;
    else root.permissions.allow = kept;
    if (Object.keys(root.permissions).length === 0) delete root.permissions;
  }

  const after = JSON.stringify(root);
  if (after === before) return 'absent';
  if (!apply) return Object.keys(root).length === 0 ? 'deleted' : 'removed';
  if (Object.keys(root).length === 0) return removeFile(path, true);
  writeFileSync(path, `${JSON.stringify(root, null, 2)}\n`);
  return 'removed';
}

/**
 * Remove graft's hook entries from a hooks config: Codex's `~/.codex/hooks.json`
 * (PostToolUse/SessionStart/etc.), or Cursor's `.cursor/hooks.json`, whose
 * schema `version` is graft's too, so a file holding nothing else goes.
 */
function stripHookEntries(path: string, apply: boolean, ours: string[] = []): RetractAction {
  if (!existsSync(path)) return 'absent';
  let root: Record<string, any>;
  try {
    root = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return 'skipped-unparseable';
  }
  if (typeof root !== 'object' || root === null || Array.isArray(root)) return 'skipped-unparseable';
  if (!root.hooks || typeof root.hooks !== 'object' || Array.isArray(root.hooks)) return 'absent';
  const before = JSON.stringify(root);
  for (const event of Object.keys(root.hooks)) {
    const prior = root.hooks[event];
    if (!Array.isArray(prior)) continue;
    const kept = prior.filter((e: unknown) => !/(graft|trail)-hooks\.cjs/.test(JSON.stringify(e ?? '')));
    if (kept.length === 0) delete root.hooks[event];
    else root.hooks[event] = kept;
  }
  if (Object.keys(root.hooks).length === 0) delete root.hooks;
  if (JSON.stringify(root) === before) return 'absent';
  const empty = Object.keys(root).every((k) => ours.includes(k));
  if (!apply) return empty ? 'deleted' : 'removed';
  if (empty) return removeFile(path, true);
  writeFileSync(path, `${JSON.stringify(root, null, 2)}\n`);
  return 'removed';
}

/**
 * Drop graft's block from `.gitignore` / `.ignore`.
 *
 * Both are written as a comment line plus entries; the comment is graft's own
 * wording, so it identifies the block. Entries are matched individually too, so
 * a hand-tidied file (comment deleted, entry kept) still retracts cleanly.
 */
function stripIgnoreEntries(path: string, entries: RegExp[], apply: boolean): RetractAction {
  if (!existsSync(path)) return 'absent';
  const text = readFileSync(path, 'utf8');
  const kept = text
    .split('\n')
    .filter((l) => {
      const t = l.trim();
      if (t.startsWith('#') && t.includes('graft')) return false;
      return !entries.some((re) => re.test(t));
    })
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^\n+/, '')
    .replace(/\n+$/, '\n');
  if (kept === text) return 'absent';
  if (!apply) return isBlank(kept) ? 'deleted' : 'removed';
  if (isBlank(kept)) return removeFile(path, true);
  writeFileSync(path, kept.endsWith('\n') ? kept : `${kept}\n`);
  return 'removed';
}

function removeDir(path: string, apply: boolean): RetractAction {
  try {
    if (!statSync(path).isDirectory()) return 'absent';
  } catch {
    return 'absent';
  }
  if (apply) {
    rmSync(path, { recursive: true, force: true });
    pruneEmptyDirs(dirname(path));
  }
  return 'deleted';
}

// ---------------------------------------------------------------------------
// the target list
// ---------------------------------------------------------------------------

type Op = (apply: boolean) => RetractAction;
interface Target extends Omit<Retraction, 'action'> {
  run: Op;
}

/**
 * Every target graft could have written, in removal order.
 *
 * Derived from the live registries, NOT hand-listed: `HOSTS` gives the
 * instruction files, `mcpTargets` over *all* host ids gives the MCP configs
 * (with the format and top-level key each one needs), and `claudeTargets`
 * gives the Claude Code layer. That's what keeps this complete as hosts are
 * added — see the module note.
 */
function targets(repo: string, opts: RetractOpts): Target[] {
  const home = opts.home ?? homedir();
  const exclude = new Set(opts.exclude ?? []);
  const out: Target[] = [];

  /**
   * Paths a *kept* host also writes, which must survive even though some other,
   * unselected host names them too.
   *
   * Three hosts share `AGENTS.md` (agents, hermes, antigravity). Excluding by host
   * id alone would strip that shared block on behalf of a host nobody selected,
   * and the only reason the end state came out right was that `init` happened to
   * rewrite it immediately afterwards. Exclude by path as well, so retraction
   * never depends on what runs next.
   */
  // Under both names: init rewrites a kept host under the repo's name and
  // clears the other name's copy itself.
  const keptPaths = new Set<string>();
  for (const host of HOSTS) {
    if (exclude.has(host.id)) for (const n of NAMES) keptPaths.add(join(repo, hostRelPath(host, n)));
  }
  for (const t of mcpTargets(repo, [...exclude], { home })) keptPaths.add(t.path);
  if (exclude.has('claude')) {
    for (const n of NAMES) for (const t of [...claudeTargetsFor(repo, n, home), ...legacyClaudeTargets(repo, n)]) keptPaths.add(t.path);
    for (const t of claudeGlobalTargets(home)) keptPaths.add(t.path);
  }
  if (exclude.has('agents')) for (const t of hookTargets(home)) keptPaths.add(t.path);
  if (exclude.has('cursor')) for (const n of NAMES) for (const t of cursorHookTargets(repo, n)) keptPaths.add(t.path);
  if (exclude.has('pi')) for (const n of NAMES) for (const t of piHookTargets(home, n)) keptPaths.add(t.path);
  if (exclude.has('antigravity')) for (const n of NAMES) for (const t of antigravitySkillTargets(home, n)) keptPaths.add(t.path);

  /** Queue a target unless a kept host owns that path, or it's already queued. */
  const seen = new Set<string>();
  const add = (t: Target): void => {
    if (keptPaths.has(t.path) || seen.has(t.path)) return;
    seen.add(t.path);
    out.push(t);
  };

  // 1. Instruction files, one per host and name. Owned files go wholesale;
  //    shared files lose only their fenced block (either name's).
  for (const host of HOSTS) {
    if (exclude.has(host.id)) continue;
    for (const n of NAMES) {
      const path = join(repo, hostRelPath(host, n));
      add(
        host.kind === 'owned'
          ? { hostId: host.id, path, what: `${n}-owned instruction file`, scope: 'repo', run: (a) => removeFile(path, a) }
          : { hostId: host.id, path, what: 'fenced graft section', scope: 'repo', run: (a) => stripSection(path, a) },
      );
    }
  }

  // 1b. Instruction files from hosts that no longer exist in the registry.
  for (const legacy of LEGACY_TARGETS) {
    const path = join(repo, legacy.relPath);
    add({
      hostId: 'legacy', path, what: legacy.what, scope: 'repo',
      run: (a) => (legacy.kind === 'owned' ? removeFile(path, a) : stripSection(path, a)),
    });
  }

  // 2. MCP registrations. Asking for every host id at once yields the union of
  //    config files, each already carrying its format and top-level key.
  const allIds = HOSTS.map((h) => h.id).filter((id) => !exclude.has(id));
  for (const t of mcpTargets(repo, allIds, { home })) {
    if (opts.global === false && t.scope === 'global') continue;
    add({
      hostId: t.hostId, path: t.path, what: t.what, scope: t.scope,
      run: (a) => (t.format === 'toml' ? removeTomlSection(t.path, a) : removeJsonKey(t.path, t.topKey!, a)),
    });
  }

  // 3. Claude Code: settings fragments, both shims, the skill, and the .mcp.json key.
  if (!exclude.has('claude')) {
    const [settings, , , , mcp] = legacyClaudeTargets(repo, 'graft').map((t) => t.path);
    const local = join(repo, '.claude', 'settings.local.json');
    const trailHook = join(repo, TRAIL_HOOK);
    const trailSl = join(repo, TRAIL_STATUSLINE);
    // The shims and skill under both names: a repo that moved to trail's names
    // still comes out clean, and so does one a teammate on graft re-wired.
    const named = (['graft', 'trail'] as const).flatMap((n) => {
      const [, statusline, hooks, skill] = legacyClaudeTargets(repo, n).map((t) => t.path);
      return [
        { hostId: 'claude', path: statusline, what: 'statusline shim', scope: 'repo', run: (a: boolean) => removeFile(statusline, a) },
        { hostId: 'claude', path: hooks, what: 'hooks shim', scope: 'repo', run: (a: boolean) => removeFile(hooks, a) },
        { hostId: 'claude', path: skill, what: `${n} skill`, scope: 'repo', run: (a: boolean) => removeFile(skill, a) },
      ];
    });
    for (const t of [
      { hostId: 'claude', path: settings, what: 'statusline + hooks + allowlist + footer regex', scope: 'repo', run: (a) => stripClaudeSettings(settings, a) },
      { hostId: 'claude', path: local, what: 'trail statusline + allowlist', scope: 'repo', run: (a) => stripClaudeSettings(local, a) },
      { hostId: 'claude', path: trailHook, what: 'hooks shim', scope: 'repo', run: (a) => removeFile(trailHook, a) },
      { hostId: 'claude', path: trailSl, what: 'statusline shim', scope: 'repo', run: (a) => removeFile(trailSl, a) },
      ...named,
      { hostId: 'claude', path: mcp, what: 'mcpServers entry', scope: 'repo', run: (a) => removeJsonKey(mcp, 'mcpServers', a) },
    ] as Target[]) add(t);
  }

  // 3b. Cursor's repo-local hooks: the shim under either name, and the entries.
  if (!exclude.has('cursor')) {
    for (const n of NAMES) {
      const [shim, config] = cursorHookTargets(repo, n);
      add({ hostId: 'cursor', path: shim.path, what: shim.what, scope: 'repo', run: (a) => removeFile(shim.path, a) });
      add({ hostId: 'cursor', path: config.path, what: config.what, scope: 'repo', run: (a) => stripHookEntries(config.path, a, ['version']) });
    }
  }

  // 4. Global: Claude Code's user-level copy, Codex's hook shim + entries, and
  //    Antigravity's shared skill.
  if (opts.global !== false) {
    if (!exclude.has('claude')) {
      const [shim, settings, mcp] = claudeGlobalTargets(home);
      for (const t of [
        { hostId: 'claude', path: shim.path, what: shim.what, scope: 'global', run: (a) => removeFile(shim.path, a) },
        { hostId: 'claude', path: settings.path, what: settings.what, scope: 'global', run: (a) => stripClaudeSettings(settings.path, a) },
        { hostId: 'claude', path: mcp.path, what: mcp.what, scope: 'global', run: (a) => removeJsonKey(mcp.path, 'mcpServers', a) },
        { hostId: 'claude', path: trailSkillPath(home), what: 'trail skill', scope: 'global', run: (a) => removeFile(trailSkillPath(home), a) },
      ] as Target[]) add(t);
    }
    if (!exclude.has('agents')) {
      for (const t of hookTargets(home)) {
        add({
          hostId: t.hostId, path: t.path, what: t.what, scope: 'global',
          run: (a) => (t.path.endsWith('.json') ? stripHookEntries(t.path, a) : removeFile(t.path, a)),
        });
      }
    }
    // Pi's user-level hook layer: the extension and its shim, both graft-owned files.
    if (!exclude.has('pi')) {
      for (const n of NAMES) {
        for (const t of piHookTargets(home, n)) {
          add({ hostId: t.hostId, path: t.path, what: t.what, scope: 'global', run: (a) => removeFile(t.path, a) });
        }
      }
    }
    if (!exclude.has('antigravity')) {
      for (const t of NAMES.flatMap((n) => antigravitySkillTargets(home, n))) {
        add({ hostId: t.hostId, path: t.path, what: t.what, scope: 'global', run: (a) => removeFile(t.path, a) });
      }
    }
  }

  // 5. The graph cache and the ignore entries that admit it. Last, so a failure
  //    here can't strand the wiring half-retracted.
  if (opts.cache !== false) {
    const cache = join(repo, 'graft');
    const trailCache = join(repo, '.trail', 'cache');
    const gitignore = join(repo, '.gitignore');
    const ignore = join(repo, '.ignore');
    for (const t of [
      { hostId: 'graph', path: cache, what: 'local graph cache', scope: 'repo', run: (a) => removeDir(cache, a) },
      { hostId: 'graph', path: trailCache, what: 'local graph cache', scope: 'repo', run: (a) => removeDir(trailCache, a) },
      { hostId: 'graph', path: gitignore, what: 'graft/ ignore entry', scope: 'repo', run: (a) => stripIgnoreEntries(gitignore, [/^\/?graft\/?$/], a) },
      { hostId: 'graph', path: ignore, what: 'graft/ search re-admit entries', scope: 'repo', run: (a) => stripIgnoreEntries(ignore, [/^!?graft\/?$/, /^graft\/\.(cache|graph)\/?$/], a) },
    ] as Target[]) add(t);
  }

  return out;
}

// ---------------------------------------------------------------------------
// public API
// ---------------------------------------------------------------------------

/** What a retraction *would* remove. Pure — touches nothing. */
export function planRetract(repo: string, opts: RetractOpts = {}): Retraction[] {
  return targets(repo, { ...opts, apply: false }).map(({ run, ...t }) => ({ ...t, action: run(false) }));
}

/**
 * Remove graft's contribution from every target. Reports every target it
 * considered, including the ones that were already clean, so a caller can show
 * either the full sweep or just what changed.
 */
export function runRetract(repo: string, opts: RetractOpts = {}): Retraction[] {
  const apply = opts.apply !== false;
  return targets(repo, opts).map(({ run, ...t }) => ({ ...t, action: run(apply) }));
}

/** The subset worth showing a user: targets that had something to remove. */
export function changed(retractions: Retraction[]): Retraction[] {
  return retractions.filter((r) => r.action !== 'absent');
}
