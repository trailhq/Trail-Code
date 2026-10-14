import type { GraphV1 } from '../graph/types.js';
import { readGraph, wiringPath, type ReadGraphOptions } from '../graph/write.js';
import type { Stats } from './state.js';
import { resolveContextDir } from '../util/state.js';

/** The project's wiring graph, or null when it is missing or unreadable. Through
 * `readGraph`, so a graph over V8's string cap still reads (the statusline, the
 * hooks and the background sync all start here); `opts` lets a test force that. */
export function readWiring(projectDir: string, opts: ReadGraphOptions = {}): GraphV1 | null {
  return readGraph(wiringPath(resolveContextDir(projectDir)), opts);
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
