import type { EdgeV1, GraphV1, NodeV1 } from "./types.js";
import { WALK_RELATIONS } from "./relations.js";

export type CondensationMember = Pick<NodeV1, "id" | "name" | "kind" | "path" | "span">;

export interface Condensation {
  components: CondensationMember[][];
  edges: CondensationEdge[];
}

export interface CondensationEdge {
  source: number;
  target: number;
  count: number;
  originalEdges: EdgeV1[];
}

/** Dependency SCCs and every cross-component link; never mutates the cached graph. */
export function buildCondensation(graph: GraphV1): Condensation {
  const nodes = new Map(graph.nodes.map((node) => [node.id, node]));
  const adjacency = new Map<string, string[]>();
  for (const id of nodes.keys()) adjacency.set(id, []);
  for (const edge of graph.edges) {
    if (WALK_RELATIONS.has(edge.relation) && nodes.has(edge.source) && nodes.has(edge.target)) {
      adjacency.get(edge.source)!.push(edge.target);
    }
  }

  const indices = new Map<string, number>();
  const lowlinks = new Map<string, number>();
  const onStack = new Set<string>();
  const active: string[] = [];
  const frames: { id: string; next: number }[] = [];
  const groups: string[][] = [];
  let index = 0;
  const discover = (id: string) => {
    indices.set(id, index);
    lowlinks.set(id, index++);
    active.push(id);
    onStack.add(id);
    frames.push({ id, next: 0 });
  };

  // Explicit DFS frames keep long dependency paths off the JavaScript call stack.
  for (const id of nodes.keys()) {
    if (indices.has(id)) continue;
    discover(id);
    while (frames.length > 0) {
      const frame = frames[frames.length - 1]!;
      const neighbors = adjacency.get(frame.id)!;
      if (frame.next < neighbors.length) {
        const target = neighbors[frame.next++]!;
        if (!indices.has(target)) {
          discover(target);
        } else if (onStack.has(target)) {
          lowlinks.set(frame.id, Math.min(lowlinks.get(frame.id)!, indices.get(target)!));
        }
        continue;
      }

      frames.pop();
      if (lowlinks.get(frame.id) === indices.get(frame.id)) {
        const members: string[] = [];
        let member: string;
        do {
          member = active.pop()!;
          onStack.delete(member);
          members.push(member);
        } while (member !== frame.id);
        members.sort((a, b) => a.localeCompare(b));
        groups.push(members);
      }
      const parent = frames[frames.length - 1];
      if (parent) {
        lowlinks.set(parent.id, Math.min(lowlinks.get(parent.id)!, lowlinks.get(frame.id)!));
      }
    }
  }

  groups.sort((a, b) => a[0]!.localeCompare(b[0]!));
  const componentOf = new Map<string, number>();
  const components = groups.map((members, component) => members.map((id) => {
    componentOf.set(id, component);
    const node = nodes.get(id)!;
    return { id, name: node.name, kind: node.kind, path: node.path, span: node.span };
  }));
  const links = new Map<string, { source: number; target: number; originalEdges: EdgeV1[] }>();
  for (const edge of graph.edges) {
    if (!WALK_RELATIONS.has(edge.relation)) continue;
    const source = componentOf.get(edge.source);
    const target = componentOf.get(edge.target);
    if (source === undefined || target === undefined || source === target) continue;
    const key = `${source},${target}`;
    let link = links.get(key);
    if (!link) {
      link = { source, target, originalEdges: [] };
      links.set(key, link);
    }
    link.originalEdges.push(edge);
  }
  const edges = Array.from(links.values(), (link) => {
    link.originalEdges.sort((a, b) =>
      a.source.localeCompare(b.source) || a.relation.localeCompare(b.relation) ||
      a.target.localeCompare(b.target) || a.confidence.localeCompare(b.confidence));
    return { ...link, count: link.originalEdges.length };
  });
  edges.sort((a, b) => a.source - b.source || a.target - b.target);
  return { components, edges };
}

/** Full explicit view: locations are definition anchors, not call-site spans. */
export function formatCondensation(condensation: Condensation): string {
  const members = new Map<string, CondensationMember>();
  for (const component of condensation.components) {
    for (const member of component) members.set(member.id, member);
  }
  const label = (member: CondensationMember) => `${member.name} (${member.path}:${member.span})`;
  let boundaries = 0;
  for (const edge of condensation.edges) {
    if (edge.count === 1) boundaries++;
  }
  const lines = [`condensation DAG — ${condensation.components.length} components · ${condensation.edges.length} links · ${boundaries} single-edge boundaries`];
  for (let i = 0; i < condensation.components.length; i++) {
    const labels: string[] = [];
    for (const member of condensation.components[i]!) labels.push(label(member));
    lines.push(`C${i}: ${labels.join(", ")}`);
  }
  for (const edge of condensation.edges) {
    let line = `C${edge.source} → C${edge.target} · ${edge.count} edges`;
    if (edge.count === 1) {
      const original = edge.originalEdges[0]!;
      line += ` · single-edge boundary · ${label(members.get(original.source)!)} → ${label(members.get(original.target)!)} (${original.relation}, ${original.confidence})`;
    }
    lines.push(line);
  }
  return lines.join("\n") + "\n";
}
