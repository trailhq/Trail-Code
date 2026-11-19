import { readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { renderStatusline, renderSubagent } from './format.js';
import { readStats, readSession, emptyStats, type Stats } from './state.js';
import { readWiring, computeStats } from './stats.js';
import { adoptRepoBrand } from '../brand.js';
import { noteCount } from '../notes/home.js';
import { resolveContextDir } from '../util/state.js';

/**
 * The statusline's fast path is the hook-maintained cache (graft/.cache/stats.json).
 * When it's absent — a fresh checkout, or a plain `graft build` that doesn't write the
 * cache — fall back to reading the graph itself (wiring.json) so the bar reflects reality
 * immediately instead of showing "not built". An empty wiring.json is still a graph
 * (docs-only repos legitimately have 0 nodes); "not built" is only when the artifact
 * is missing. The graph carries no drift signal, so it reads as synced until the next
 * edit repopulates the cache. Still a pure read (no subprocess): the cache is preferred
 * because it carries live dirty/stale state.
 */
export function resolveStats(dir: string): Stats | null {
  const cached = readStats(dir);
  if (cached && cached.nodeCount > 0) return cached;
  const wiring = readWiring(dir);
  if (wiring) return { ...emptyStats(), ...computeStats(wiring) };
  return workspaceStats(dir);
}

/**
 * A workspace build splits the map into the child repos and leaves only
 * workspace.json at the parent (graph/workspace.ts), so neither cache nor
 * wiring exists there — the parent read "not built" forever (issue #817).
 * Sum the built children instead, read directly to keep the statusline a
 * pure read. Children without stats are skipped; none built → still null.
 */
function workspaceStats(dir: string): Stats | null {
  try {
    const ws = JSON.parse(readFileSync(join(resolveContextDir(dir), 'workspace.json'), 'utf8')) as
      { version?: number; children?: unknown };
    if (ws.version !== 1 || !Array.isArray(ws.children)) return null;
    const kids = ws.children
      .map((c) => readStats(join(dir, String(c))))
      .filter((s): s is Stats => !!s && s.nodeCount > 0);
    if (!kids.length) return null;
    const total = emptyStats();
    for (const s of kids) {
      total.nodeCount += s.nodeCount;
      total.edgeCount += s.edgeCount;
      total.totalCount += s.totalCount;
      total.readyCount += s.readyCount;
      total.staleCount += s.staleCount;
    }
    return total;
  } catch {
    return null;
  }
}

export function main(): void {
  let input: any = {};
  try { input = JSON.parse(readFileSync(0, 'utf8')); } catch { /* no/invalid stdin */ }
  const dir = process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd();
  adoptRepoBrand(dir);
  const session = readSession(dir, input.session_id || 'default');
  const agent = input?.agent?.name;
  if (agent) { process.stdout.write(renderSubagent(agent, session)); return; }
  const stats = resolveStats(dir);
  const raw = input?.context_window?.used_percentage;
  const ctxPct = typeof raw === 'number' ? Math.round(raw) : null;
  process.stdout.write(renderStatusline(stats, session, { ctxPct, notes: noteCount(dir), folder: basename(dir) }).join('\n'));
}
