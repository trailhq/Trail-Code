/**
 * Active-layer install for CLI agents that read user-level hooks.json with
 * PostToolUse semantics. Writes the shared hook shim and one PostToolUse
 * entry that runs post-edit + background sync after every file edit.
 */
import { writeFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { hooksShim } from '../claude/shim-template.js';
import type { PlannedWrite } from './plan.js';
import { writeOwned, isGraftEntry, readJsonObject, type ConfigWrite } from './config-write.js';

function dirExists(p: string): boolean {
  try { return statSync(p).isDirectory(); } catch { return false; }
}

/**
 * The files installing the Codex hook would touch — pure, no writes. Both live
 * under `~/.codex`, so both are scoped 'global': the hook entries fire in every
 * repo opened with Codex, not just this one. Empty when the CLI isn't installed,
 * mirroring `installCodexHooks`' early return.
 */
export function hookTargets(home: string): PlannedWrite[] {
  const base = join(home, '.codex');
  if (!dirExists(base)) return [];
  return [
    {
      hostId: 'agents', id: 'codex-hook-shim',
      path: join(base, 'hooks', 'graft', 'graft-hooks.cjs'),
      scope: 'global', kind: 'hook', what: 'post-edit hook shim',
    },
    {
      hostId: 'agents', id: 'codex-hooks',
      path: join(base, 'hooks.json'),
      scope: 'global', kind: 'hook', what: 'SessionStart / UserPromptSubmit / PostToolUse / Stop',
    },
  ];
}

/**
 * The graft hook entries Codex should carry, mirroring the Claude Code set:
 *   - SessionStart → orientation from `graft/INDEX.md`
 *   - UserPromptSubmit → the coupling-seed retrieval pack (the accuracy hook)
 *   - PostToolUse (an edit) → blast radius + mark the graph dirty
 *   - Stop → one background graph sync at turn end (not after every edit)
 * `matcher` is omitted where Codex ignores it (UserPromptSubmit, Stop). The edit
 * matcher includes `apply_patch` — Codex's native edit tool — alongside the
 * Claude Code edit-tool names, and `hooks.ts`'s `editedFilePath` reads the touched
 * file out of either shape.
 */
interface DesiredEntry { event: string; matcher?: string; sub: string; timeout: number; }
function desiredEntries(): DesiredEntry[] {
  return [
    { event: 'SessionStart', matcher: 'startup|resume|compact', sub: 'session-start', timeout: 10000 },
    { event: 'UserPromptSubmit', sub: 'prompt', timeout: 15000 },
    { event: 'PostToolUse', matcher: 'apply_patch|Write|Edit|MultiEdit', sub: 'post-edit', timeout: 10000 },
    { event: 'Stop', sub: 'stop', timeout: 10000 },
  ];
}

export function installCodexHooks(home: string): ConfigWrite[] {
  const targets = hookTargets(home);
  if (targets.length === 0) return [];

  const shimPath = targets[0].path;
  const shimWrite = writeOwned('codex-hook-shim', shimPath, hooksShim(), 0o755);
  const cfgPath = targets[1].path;
  const skipped: ConfigWrite = { id: 'codex-hooks', path: cfgPath, action: 'skipped-unparseable' };

  const loaded = readJsonObject(cfgPath);
  if (loaded === 'unparseable') return [shimWrite, skipped];
  const { root, existed } = loaded;
  const before = JSON.stringify(root);
  const hooks = (root.hooks ??= {});
  if (typeof hooks !== 'object' || hooks === null || Array.isArray(hooks)) return [shimWrite, skipped];

  for (const d of desiredEntries()) {
    if (hooks[d.event] !== undefined && !Array.isArray(hooks[d.event])) return [shimWrite, skipped];
    const prior: unknown[] = Array.isArray(hooks[d.event]) ? hooks[d.event] : [];
    const handler = { type: 'command', command: `node "${shimPath}" ${d.sub}`, timeout: d.timeout };
    const entry = d.matcher ? { matcher: d.matcher, hooks: [handler] } : { hooks: [handler] };
    // Preserve foreign entries in this event; replace any prior graft entry so an
    // upgrade re-points to the current shim/sub-command instead of stacking.
    hooks[d.event] = [...prior.filter((e) => !isGraftEntry(e)), entry];
  }

  if (JSON.stringify(root) === before) return [shimWrite, { id: 'codex-hooks', path: cfgPath, action: 'unchanged' }];
  writeFileSync(cfgPath, `${JSON.stringify(root, null, 2)}\n`);
  return [shimWrite, { id: 'codex-hooks', path: cfgPath, action: existed ? 'updated' : 'created' }];
}
