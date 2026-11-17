/**
 * Shared helpers for the host config writers. Both the hook installers (Codex,
 * user-level under `~/.codex`; Cursor, repo-local under `.cursor`) and the MCP
 * registration merge graft entries into a JSON config, own a generated shim, and
 * describe the outcome with the same little result record. The file-owning write,
 * the graft-entry test, and the load-or-skip JSON open are identical across them;
 * the merge itself differs per host, so only the genuinely-shared pieces live here.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, chmodSync, statSync } from 'node:fs';
import { dirname } from 'node:path';

/** The result of one config/shim write, reported by every installer and by MCP
 *  registration so they speak the same vocabulary. `McpWrite` aliases this. */
export interface ConfigWrite {
  id: string;
  path: string;
  action: 'created' | 'updated' | 'unchanged' | 'skipped-unparseable';
}

/**
 * Write a graft-owned file, idempotently: unchanged when the content already
 * matches (only re-applying `mode` if it drifted), else created/updated. `mode`
 * is applied on POSIX; on Windows the exec bit does not exist and is skipped by
 * the caller's expectations.
 */
export function writeOwned(id: string, path: string, content: string, mode?: number): ConfigWrite {
  const existed = existsSync(path);
  if (existed && readFileSync(path, 'utf8') === content) {
    if (mode !== undefined && (statSync(path).mode & 0o777) !== mode) chmodSync(path, mode);
    return { id, path, action: 'unchanged' };
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  if (mode !== undefined) chmodSync(path, mode);
  return { id, path, action: existed ? 'updated' : 'created' };
}

/** Whether a hooks-config entry is one graft installed (so an upgrade replaces
 *  it in place instead of stacking a second copy next to the stale one). The
 *  `?? ''` guards a stray `undefined` entry: `JSON.stringify(undefined)` is
 *  `undefined`, whose `.includes` would throw. */
export function isGraftEntry(entry: unknown): boolean {
  const s = JSON.stringify(entry ?? '');
  return s.includes('graft-hooks.cjs') || s.includes('trail-hooks.cjs') || s.includes('/.trail/hook.cjs');
}

/** What marks `trail share-session`'s hook: trail's shim, called with the `share-sync` event. */
const SHARE_SYNC_MARK = '-hooks.cjs" share-sync';

/** Whether a hooks-config entry is `trail share-session`'s keep-sending hook. It calls trail's
 *  shim, so `isGraftEntry` matches it too, but it isn't part of the set an upgrade rewrites: it's
 *  there because the person said yes, and only `--stop` or `--delete` take it out. */
export function isShareSyncEntry(entry: unknown): boolean {
  const hooks = (entry as { hooks?: unknown } | null | undefined)?.hooks;
  return Array.isArray(hooks) && hooks.some((h) => typeof h?.command === 'string' && h.command.includes(SHARE_SYNC_MARK));
}

/**
 * Load a JSON config that graft is about to merge into, distinguishing the three
 * outcomes an installer must treat differently:
 *   - missing → `{ root: {}, existed: false }`: start fresh, this is a create.
 *   - a plain object → `{ root, existed: true }`: merge into it.
 *   - anything else (parse error, or a top-level array/null/primitive) →
 *     `'unparseable'`: leave the file exactly as the user left it.
 *
 * Deliberately NOT `readJson` from `util/state.ts`, which returns `null` for both
 * missing and unparseable — collapsing those two would let a create silently
 * clobber a hand-edited broken `hooks.json`.
 */
export function readJsonObject(
  path: string,
): { root: Record<string, any>; existed: boolean } | 'unparseable' {
  if (!existsSync(path)) return { root: {}, existed: false };
  let root: unknown;
  try {
    root = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return 'unparseable';
  }
  if (typeof root !== 'object' || root === null || Array.isArray(root)) return 'unparseable';
  return { root: root as Record<string, any>, existed: true };
}
