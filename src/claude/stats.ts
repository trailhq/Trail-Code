import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { GraphV1 } from '../graph/types.js';
import { readWorkspace } from '../graph/workspace.js';
import type { Stats } from './state.js';
import { resolveContextDir } from '../util/state.js';

export function readWiring(projectDir: string): GraphV1 | null {
  try {
    return JSON.parse(readFileSync(join(resolveContextDir(projectDir), '.graph', 'wiring.json'), 'utf8')) as GraphV1;
  } catch { return null; }
}

export function computeStats(
  w: GraphV1,
): Pick<Stats, 'nodeCount' | 'edgeCount' | 'languages' | 'totalCount' | 'readyCount'> {
  const nodes = w.nodes ?? [];
  const edges = w.edges ?? [];
  const readyCount = nodes.filter((n) => n.summary_state === 'ready').length;
  return {
    nodeCount: w.meta?.nodeCount ?? nodes.length,
    edgeCount: w.meta?.edgeCount ?? edges.length,
    languages: w.meta?.languages ?? [],
    totalCount: nodes.length,
    readyCount,
  };
}

/** #433: a workspace parent has no wiring.json of its own — its real totals are the union of its
 * children's graphs (the same totals the federated queries serve). Null when there are no children
 * or no child has a graph, so the caller keeps its zeros honestly instead of inventing numbers. */
export function workspaceStats(
  repoDir: string,
  override?: string,
): Pick<Stats, 'nodeCount' | 'edgeCount' | 'languages' | 'totalCount' | 'readyCount'> | null {
  const children = readWorkspace(repoDir, override)?.children ?? [];
  const graphs = children.map((c) => readWiring(join(repoDir, c))).filter((w): w is GraphV1 => w !== null);
  if (children.length === 0 || graphs.length === 0) return null;
  const parts = graphs.map(computeStats);
  return {
    nodeCount: parts.reduce((n, s) => n + s.nodeCount, 0),
    edgeCount: parts.reduce((n, s) => n + s.edgeCount, 0),
    languages: [...new Set(parts.flatMap((s) => s.languages))].sort(),
    totalCount: parts.reduce((n, s) => n + s.totalCount, 0),
    readyCount: parts.reduce((n, s) => n + s.readyCount, 0),
  };
}
