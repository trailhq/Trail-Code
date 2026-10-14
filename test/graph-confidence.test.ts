import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { callersOf, calleesOf, impactOfMany, impactOfFile } from "../src/graph/traverse.js";
import { hitLine } from "../src/graph/traverse-cli.js";
import { callTool } from "../src/mcp/tools.js";
import type { Confidence, GraphV1, NodeV1 } from "../src/graph/types.js";

function node(name: string): NodeV1 {
  return {
    id: `src/${name}.ts#${name}`, name, kind: "function", path: `src/${name}.ts`,
    span: "L1-L3", signature: null, exported: true, origin: "ast",
    body_hash: name, summary_state: "pending", summary: null, crux: null,
  };
}

function chain(first: Confidence, second: Confidence): GraphV1 {
  const nodes = [node("leaf"), node("middle"), node("top")];
  return {
    meta: { version: 1, nodeCount: 3, edgeCount: 2, languages: ["ts"] }, nodes,
    edges: [
      { source: nodes[1].id, target: nodes[0].id, relation: "calls", confidence: first },
      { source: nodes[2].id, target: nodes[1].id, relation: "references", confidence: second },
    ],
  };
}

test("direct incoming and outgoing hits preserve all four confidence grades", () => {
  for (const confidence of ["lsp_resolved", "lsp_dispatch", "extracted", "inferred"] as const) {
    const graph = chain(confidence, "extracted");
    for (const hit of [callersOf(graph, graph.nodes[0])[0], calleesOf(graph, graph.nodes[1])[0]]) {
      assert.equal(hit.confidence, confidence);
      assert.equal(hit.pathConfidence, confidence);
      assert.match(hitLine("in", hit, false), new RegExp(`\\[${confidence}\\]`));
    }
  }
});

test("an extracted final edge cannot hide an earlier inferred hop", () => {
  for (const direction of ["in", "out"] as const) {
    const graph = direction === "in" ? chain("inferred", "extracted") : chain("extracted", "inferred");
    const seed = graph.nodes[direction === "in" ? 0 : 2];
    const hits = impactOfMany(graph, [seed], Infinity, direction);
    assert.equal(hits.length, 2);
    assert.equal(hits[1].confidence, "extracted");
    assert.equal(hits[1].pathConfidence, "inferred");
    assert.match(hitLine(direction, hits[1], true), /\[extracted; path inferred\]/);
  }
});

test("LSP dispatch remains weaker than exact LSP resolution on a path", () => {
  const graph = chain("lsp_dispatch", "lsp_resolved");
  const hit = impactOfMany(graph, [graph.nodes[0]], 2)[1];
  assert.equal(hit.confidence, "lsp_resolved");
  assert.equal(hit.pathConfidence, "lsp_dispatch");
});

test("a stronger alternative path does not change the first BFS path's confidence", () => {
  const graph = chain("inferred", "extracted");
  const alternative = node("alternative");
  graph.nodes.push(alternative);
  graph.edges.push(
    { source: alternative.id, target: graph.nodes[0].id, relation: "calls", confidence: "lsp_resolved" },
    { source: graph.nodes[2].id, target: alternative.id, relation: "calls", confidence: "lsp_resolved" },
  );
  const hits = impactOfMany(graph, [graph.nodes[0]], 2);
  const convergence = hits.filter((hit) => hit.id === graph.nodes[2].id);
  assert.equal(convergence.length, 1);
  assert.equal(convergence[0].depth, 2);
  assert.equal(convergence[0].relation, "references");
  assert.equal(convergence[0].confidence, "extracted");
  assert.equal(convergence[0].pathConfidence, "inferred");
});

test("file seeds and cycles retain the first BFS path and its provenance", () => {
  const graph = chain("inferred", "extracted");
  const file = { ...node("file"), id: "src/leaf.ts", path: "src/leaf.ts", kind: "file" as const };
  graph.nodes.push(file);
  graph.edges.push({ source: graph.nodes[0].id, target: graph.nodes[2].id, relation: "calls", confidence: "extracted" });
  const hits = impactOfFile(graph, file, Infinity);
  assert.deepEqual(hits.map((hit) => hit.id), [graph.nodes[1].id, graph.nodes[2].id]);
  assert.equal(hits[1].pathConfidence, "inferred");
  assert.deepEqual(impactOfMany(graph, [graph.nodes[0], graph.nodes[1]], Infinity).map((hit) => hit.pathConfidence), ["extracted"]);
});

test("unresolved endpoints retain their edge confidence", () => {
  const graph = chain("extracted", "extracted");
  graph.edges.push({ source: graph.nodes[0].id, target: "ExternalBase", relation: "extends", confidence: "inferred" });
  const hit = calleesOf(graph, graph.nodes[0])[0];
  assert.equal(hit.node, null);
  assert.equal(hit.confidence, "inferred");
  assert.match(hitLine("out", hit, false), /ExternalBase.*\[inferred\]/);
});

test("CLI JSON, human output, and MCP report inference along the same real call chain", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "graft-confidence-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src/leaf.ts"), "export function leaf() { return 1; }\n");
  // The cross-file bare name uses the existing inferred fallback. The same-file
  // top -> middle call is extracted: the second hop must not upgrade the path.
  writeFileSync(join(root, "src/entry.ts"), "export function middle() { return leaf(); }\nexport function top() { return middle(); }\n");
  const cli = (...args: string[]) => execFileSync(process.execPath, ["--import", "tsx", "src/cli.ts", ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  cli("build", root);
  const args = ["callers", "leaf", root, "--depth", "all", "--no-refresh"];
  const parsed = JSON.parse(cli(...args, "--json"));
  const hits = parsed.matches[0].hits;
  assert.deepEqual(hits.map((hit: { confidence: string }) => hit.confidence), ["inferred", "extracted"]);
  assert.deepEqual(hits.map((hit: { pathConfidence: string }) => hit.pathConfidence), ["inferred", "inferred"]);
  const human = cli(...args);
  assert.match(human, /middle.*\[inferred\]/);
  assert.match(human, /top.*\[extracted; path inferred\]/);
  const mcp = await callTool(root, "graft_trace_calls", { symbol: "leaf", depth: "all" });
  assert.equal(mcp.isError, false, mcp.text);
  assert.match(mcp.text, /middle.*\[inferred\]/);
  assert.match(mcp.text, /top.*\[extracted; path inferred\]/);
});
