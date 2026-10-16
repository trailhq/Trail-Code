/**
 * LSP enrichment tier: registry selection + graceful degradation. These run
 * without any language server installed — they assert the OPT-IN promise that
 * `graft build --lsp` is a safe no-op when no server applies (never a crash,
 * never a mutated graph), which is the contract the build relies on.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { pickServer, LSP_SERVERS } from "../src/graph/lsp/registry.js";
import { enrichWithLsp, readinessSample, waitForReadiness } from "../src/graph/lsp/enrich.js";
import type { GraphV1 } from "../src/graph/types.js";

test("pickServer: no languages present → no server", () => {
  assert.equal(pickServer(new Set()), null);
});

test("pickServer: a language no registered server covers → null", () => {
  assert.equal(pickServer(new Set(["cobol", "fortran"])), null);
});

test("registry rows are well-formed (languages, command, languageId)", () => {
  for (const s of LSP_SERVERS) {
    assert.ok(s.languages.length > 0 && s.command && s.languageId, `${s.command} row shape`);
    assert.ok(Array.isArray(s.args), `${s.command} args is an array`);
  }
});

test("enrichWithLsp is a no-op when no server matches the repo's languages", async () => {
  // A graph whose only file is an unsupported language → no server is picked →
  // no process spawned, graph returned unchanged.
  const graph: GraphV1 = {
    meta: { version: 1, nodeCount: 1, edgeCount: 0, languages: ["text"], scopes: [] },
    nodes: [
      { id: "notes.txt", name: "notes.txt", kind: "file", path: "notes.txt", span: "L1-L1",
        signature: null, exported: true, origin: "ast", body_hash: "x", summary_state: "pending", summary: null, crux: null },
    ],
    edges: [],
  };
  const before = graph.edges.length;
  const r = await enrichWithLsp(graph, "/tmp/does-not-matter");
  assert.equal(r.server, null, "no server selected for an unsupported language");
  assert.equal(r.added, 0);
  assert.equal(graph.edges.length, before, "graph edges untouched");
});

test("readinessSample spreads probes across files and deduplicates paths", () => {
  const items = Array.from({ length: 20 }, (_, i) => ({ path: `src/file-${i}.ts`, i }));
  assert.deepEqual(readinessSample(items).map((item) => item.i), [0, 4, 9, 14, 18]);

  const repeated = [
    { path: "a.ts", i: 0 },
    { path: "a.ts", i: 1 },
    { path: "b.ts", i: 2 },
    { path: "b.ts", i: 3 },
    { path: "c.ts", i: 4 },
  ];
  assert.deepEqual(readinessSample(repeated).map((item) => item.path), ["a.ts", "b.ts", "c.ts"]);
});

test("waitForReadiness retries until every sample member answers", async () => {
  let round = 0;
  const calls = [0, 0];
  const sleeps: number[] = [];
  const ready = await waitForReadiness([
    async () => { calls[0]++; return true; },
    async () => { calls[1]++; return round > 0; },
  ], {
    attempts: 2,
    delayMs: 25,
    sleep: async (ms) => { sleeps.push(ms); round++; },
  });

  assert.equal(ready, true);
  assert.deepEqual(calls, [2, 2]);
  assert.deepEqual(sleeps, [25]);
});
