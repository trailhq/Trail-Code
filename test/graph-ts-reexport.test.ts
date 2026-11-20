import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { buildGraph } from "../src/graph/build.js";
import { readGraph } from "../src/graph/write.js";
import type { GraphV1 } from "../src/graph/types.js";

async function withGraph(
  files: Record<string, string>,
  check: (graph: GraphV1) => void,
): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "graft-ts-reexport-"));
  try {
    for (const [path, contents] of Object.entries(files)) {
      const abs = join(root, ...path.split("/"));
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, contents);
    }
    const result = await buildGraph(root, { graphOnly: true, reuse: false });
    const graph = readGraph(result.graphPath);
    assert.ok(graph, "buildGraph writes a readable graph");
    check(graph);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function referenceTargets(graph: GraphV1, source: string): string[] {
  return graph.edges
    .filter((edge) => edge.relation === "references" && edge.source === source)
    .map((edge) => edge.target)
    .sort();
}

test("a named re-export gives the barrel file a references edge to the re-exported symbol", async () => {
  await withGraph({
    "src/lib/dates.ts": "export function addDays(day: number): number { return day + 1; }\n",
    "src/lib/index.ts": 'export { addDays } from "./dates";\n',
  }, (graph) => {
    assert.deepEqual(referenceTargets(graph, "src/lib/index.ts"), ["src/lib/dates.ts#addDays"]);
    assert.ok(graph.edges.some((edge) => edge.relation === "imports" && edge.source === "src/lib/index.ts" && edge.target === "src/lib/dates.ts"),
      "the existing import edge is kept");
  });
});

test("a renamed re-export points at the original name, not the alias", async () => {
  await withGraph({
    "src/lib/dates.ts": "export function addDays(day: number): number { return day + 1; }\n",
    "src/lib/index.ts": 'export { addDays as plusDays } from "./dates";\n',
  }, (graph) => {
    assert.deepEqual(referenceTargets(graph, "src/lib/index.ts"), ["src/lib/dates.ts#addDays"]);
  });
});

test("type-only and multi-name re-exports are followed", async () => {
  await withGraph({
    "core/dates.ts": [
      "export interface DateRange { from: number; to: number }",
      "export function addDays(day: number): number { return day + 1; }",
    ].join("\n"),
    "src/index.ts": [
      'export type { DateRange } from "../core/dates";',
      'export { addDays } from "../core/dates";',
    ].join("\n"),
  }, (graph) => {
    assert.deepEqual(referenceTargets(graph, "src/index.ts"), [
      "core/dates.ts#DateRange",
      "core/dates.ts#addDays",
    ]);
  });
});

test("export-star, default re-exports and names that do not resolve add no references edges", async () => {
  await withGraph({
    "src/lib/star.ts": "export function starred(): number { return 1; }\n",
    "src/lib/main.ts": "export default function mainThing(): number { return 2; }\n",
    "src/lib/index.ts": [
      'export * from "./star";',
      'export { default } from "./main";',
      'export { missingName } from "./star";',
      'export { external } from "left-pad";',
    ].join("\n"),
  }, (graph) => {
    assert.deepEqual(referenceTargets(graph, "src/lib/index.ts"), []);
    assert.ok(graph.edges.some((edge) => edge.relation === "imports" && edge.source === "src/lib/index.ts" && edge.target === "src/lib/star.ts"),
      "export-star keeps its import edge");
  });
});

test("a plain exported definition is still extracted and adds no re-export edge", async () => {
  await withGraph({
    "src/plain.ts": "export const answer = 42;\nexport function ask(): number { return answer; }\n",
  }, (graph) => {
    assert.ok(graph.nodes.some((node) => node.id === "src/plain.ts#ask"));
    assert.deepEqual(referenceTargets(graph, "src/plain.ts"), []);
  });
});
