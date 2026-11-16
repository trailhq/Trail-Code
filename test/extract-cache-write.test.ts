/**
 * The extract cache (one file's entry at a time) and the graph are written in plain
 * ASCII: a single non-ASCII character used to make V8 hold a whole file, read back,
 * as a two-byte string (on assign, ~300 MB more for the cache, ~100 MB for the graph).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emptyExtractCache, extractCachePath, readExtractCache, writeExtractCache, type ExtractCache } from "../src/graph/extract-cache.js";
import { readGraph, wiringPath, writeGraph } from "../src/graph/write.js";
import type { GraphV1, NodeV1 } from "../src/graph/types.js";

test("the extract cache is written as ASCII and reads back the same values", (t) => {
  const out = mkdtempSync(join(tmpdir(), "graft-extract-cache-"));
  const path = extractCachePath(out);
  if (path === null) return t.skip("no extractor identity here: nothing is cached");
  const node = { id: "src/café.ts#greet", name: "greet", path: "src/café.ts", body_text: "return `naïve — ✓ 😀 ${x}`;" } as unknown as NodeV1;
  const cache: ExtractCache = {
    ...emptyExtractCache(),
    files: {
      "src/café.ts": { size: 42, mtimeMs: 1.5, hash: "h1", nodes: [node], rawEdges: [] },
      "src/plain.ts": { size: 7, mtimeMs: 2, hash: "h2", nodes: [], rawEdges: [] },
    },
  };
  assert.equal(writeExtractCache(out, cache), true);

  const bytes = readFileSync(path);
  assert.ok(bytes.every((b) => b < 0x80), "every byte is ASCII");
  assert.deepEqual(JSON.parse(bytes.toString("utf8")), JSON.parse(JSON.stringify(cache)), "the same JSON as before, escapes aside");
  assert.deepEqual(readExtractCache(out), cache);
});

test("the graph is written as ASCII and reads back the same values", () => {
  const out = mkdtempSync(join(tmpdir(), "graft-wiring-ascii-"));
  const node = { id: "src/café.ts#greet", name: "greet", path: "src/café.ts", signature: "greet(): \"naïve — ✓ 😀\"" } as unknown as NodeV1;
  const graph = { meta: { version: 1, nodeCount: 1, edgeCount: 0, languages: ["typescript"] }, nodes: [node], edges: [] } as unknown as GraphV1;
  writeGraph(graph, out);
  const bytes = readFileSync(wiringPath(out));
  assert.ok(bytes.every((b) => b < 0x80), "every byte is ASCII");
  assert.deepEqual(readGraph(wiringPath(out)), graph);
});
