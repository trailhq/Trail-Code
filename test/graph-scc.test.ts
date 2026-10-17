import { test } from "node:test";
import assert from "node:assert/strict";
import { buildCondensation } from "../src/graph/scc.js";
import type { EdgeV1, GraphV1, NodeV1, Relation } from "../src/graph/types.js";

function fileNode(path: string): NodeV1 {
  return {
    id: path, name: path.slice(path.lastIndexOf("/") + 1), kind: "file", path,
    span: "L1-L1", signature: null, exported: true, origin: "ast", body_hash: "h",
    summary_state: "pending", summary: null, crux: null,
  };
}

function symNode(path: string, name: string, span = "L2-L3"): NodeV1 {
  return { ...fileNode(path), id: `${path}#${name}`, name, kind: "function", span };
}

function edge(source: string, target: string, relation: Relation = "calls", confidence: EdgeV1["confidence"] = "extracted"): EdgeV1 {
  return { source, target, relation, confidence };
}

function graphOf(nodes: NodeV1[], edges: EdgeV1[]): GraphV1 {
  return { meta: { version: 1, nodeCount: nodes.length, edgeCount: edges.length, languages: [] }, nodes, edges };
}

test("condensation partitions every vertex, retains dependency support, and is deterministic without mutation", () => {
  const a1 = symNode("a/a.ts", "a1");
  const a2 = symNode("a/a.ts", "a2", "L5-L6");
  // Ordinal IDs must remain exact, not collapse onto the unsuffixed definition.
  a2.id += "~2";
  const b1 = symNode("b/b.ts", "b1");
  const b2 = symNode("b/b.ts", "b2", "L5-L6");
  const c = symNode("c/c.ts", "c");
  const isolated = symNode("c/c.ts", "isolated", "L8-L9");
  const files = [fileNode("a/a.ts"), fileNode("b/b.ts"), fileNode("c/c.ts")];
  const nodes = [...files, a1, a2, b1, b2, c, isolated];
  const ab = [edge(a1.id, b1.id), edge(a2.id, b2.id, "references")];
  const ac = edge(a2.id, c.id);
  const bc = edge(b2.id, c.id, "calls", "inferred");
  const edges = [
    edge(a1.id, a2.id), edge(a2.id, a1.id), edge(b1.id, b2.id), edge(b2.id, b1.id), edge(c.id, c.id),
    ...ab, bc, ac,
    ...[a1, a2, b1, b2, c, isolated].map((n) => edge(n.path, n.id, "contains")),
    edge("c/c.ts", "node:fs", "imports"), edge(c.id, "ExternalBase", "extends"),
    edge(c.id, "ExternalContract", "implements"), edge(c.id, "ExternalAnnotation", "references"),
    edge("missing.ts#ghost", a1.id),
  ];
  const graph = graphOf(nodes, edges);
  const before = structuredClone(graph);
  const result = buildCondensation(graph);
  const project = (n: NodeV1) => ({ id: n.id, name: n.name, kind: n.kind, path: n.path, span: n.span });
  const expectedGroups = [[files[0]!], [a1, a2], [files[1]!], [b1, b2], [files[2]!], [c], [isolated]];
  assert.deepEqual(result.components, expectedGroups.map((group) => group.map(project)));
  assert.deepEqual(result.components.flat().map((n) => n.id).sort(), nodes.map((n) => n.id).sort());
  assert.deepEqual(result.edges, [
    { source: 1, target: 3, count: 2, originalEdges: ab },
    { source: 1, target: 5, count: 1, originalEdges: [ac] },
    { source: 3, target: 5, count: 1, originalEdges: [bc] },
  ]);
  for (const link of result.edges) {
    for (const original of link.originalEdges) assert.ok(edges.includes(original), "retains original edge references");
  }
  assert.deepEqual(graph, before);
  const reversed = graphOf([...nodes].reverse(), [...edges].reverse());
  const reversedBefore = structuredClone(reversed);
  assert.deepEqual(buildCondensation(reversed), result);
  assert.deepEqual(reversed, reversedBefore);
});

test("condensation of an empty graph is empty", () => {
  assert.deepEqual(buildCondensation(graphOf([], [])), { components: [], edges: [] });
});

test("condensation handles a 20,000-vertex dependency path with exact directed provenance", () => {
  const nodes = Array.from({ length: 20_000 }, (_, i) => symNode("path.ts", `n${String(i).padStart(5, "0")}`));
  const edges = nodes.slice(1).map((n, i) => edge(nodes[i]!.id, n.id));
  const result = buildCondensation(graphOf(nodes, edges));
  assert.equal(result.components.length, nodes.length);
  assert.equal(result.edges.length, edges.length);
  for (let i = 0; i < nodes.length; i++) {
    assert.deepEqual(result.components[i], [{
      id: nodes[i]!.id, name: nodes[i]!.name, kind: "function", path: "path.ts", span: "L2-L3",
    }]);
    if (i < edges.length) {
      assert.deepEqual(result.edges[i], { source: i, target: i + 1, count: 1, originalEdges: [edges[i]!] });
      assert.equal(result.edges[i]!.originalEdges[0], edges[i]);
    }
  }
});
