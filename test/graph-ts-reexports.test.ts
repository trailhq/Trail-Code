import { test } from "node:test";
import assert from "node:assert/strict";
import { extractFile } from "../src/graph/extract.js";
import { resolveEdges } from "../src/graph/resolve.js";
import { impactOfFile } from "../src/graph/traverse.js";
import type { GraphV1 } from "../src/graph/types.js";

test("file impact follows TypeScript barrel re-exports to downstream consumers", () => {
  const sources = [
    ["src/domain/rank.ts", "export function rank() {}"],
    ["src/domain/index.ts", 'export { rank } from "./rank.js";'],
    [
      "src/services/ranking.ts",
      'import { rank } from "../domain/index.js";\nexport function score() { return rank(); }',
    ],
    [
      "tests/ranking.test.ts",
      'import { score } from "../src/services/ranking.js";\nexport function testRanking() { return score(); }',
    ],
  ] as const;
  const extracted = sources.map(([path, source]) => extractFile(path, source, "typescript"));
  const nodes = extracted.flatMap(({ nodes }) => nodes);
  const rawEdges = extracted.flatMap(({ rawEdges }) => rawEdges);
  const edges = resolveEdges(nodes, rawEdges);
  const rankFile = nodes.find((node) => node.kind === "file" && node.path === "src/domain/rank.ts");
  assert.ok(rankFile, "rank.ts should have a file node");

  const graph: GraphV1 = {
    meta: { version: 1, nodeCount: nodes.length, edgeCount: edges.length, languages: ["ts"] },
    nodes,
    edges,
  };
  const impacted = new Set(impactOfFile(graph, rankFile, 4).map((hit) => hit.node?.path ?? hit.id));

  assert.ok(impacted.has("src/domain/index.ts"), "the barrel should be impacted by its re-export target");
  assert.ok(impacted.has("src/services/ranking.ts"), "consumers of the barrel should be impacted");
  assert.ok(impacted.has("tests/ranking.test.ts"), "downstream tests should be reachable from the barrel");
});
