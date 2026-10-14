import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emptyExtractCache, extractCachePath, readExtractCache, writeExtractCache, type ExtractEntry } from "../src/graph/extract-cache.js";

const FILES: Record<string, ExtractEntry> = {
  "src/a.ts": { size: 3, mtimeMs: 1, hash: "h1", nodes: [], rawEdges: [] },
  "src/b.rs": { size: 4, mtimeMs: 2, hash: "", nodes: [], rawEdges: [], error: "src/b.rs: nope" },
  "z/\"quoted\"\n.c": { size: 5, mtimeMs: 3, hash: "h3", nodes: [], rawEdges: [{ source: "z", relation: "calls", target: "q" } as never] },
};

test("extract cache round-trips through NDJSON, including quotes and newlines in a path", () => {
  const d = mkdtempSync(join(tmpdir(), "graft-ndjson-"));
  assert.ok(writeExtractCache(d, { ...emptyExtractCache(), files: FILES }));
  assert.ok(extractCachePath(d)!.endsWith(".ndjson"));
  const back = readExtractCache(d);
  assert.deepEqual({ ...back.files }, FILES); // spread: the reader's map has a null prototype
  assert.equal(back.version, 2);
});

test("extract cache: a blank first line fails the header check, so the entries after it are not trusted", () => {
  const d = mkdtempSync(join(tmpdir(), "graft-ndjson-"));
  writeExtractCache(d, { ...emptyExtractCache(), files: FILES });
  const p = extractCachePath(d)!;
  const lines = readFileSync(p, "utf8").split("\n");
  writeFileSync(p, ["", ...lines.slice(1)].join("\n"));
  assert.deepEqual(readExtractCache(d).files, {});
});

test("extract cache: a rel of __proto__ is an ordinary key, not the prototype setter", () => {
  const d = mkdtempSync(join(tmpdir(), "graft-ndjson-"));
  writeExtractCache(d, emptyExtractCache());
  const p = extractCachePath(d)!;
  const e: ExtractEntry = { size: 1, mtimeMs: 1, hash: "hp", nodes: [], rawEdges: [] };
  writeFileSync(p, readFileSync(p, "utf8") + JSON.stringify({ rel: "__proto__", e }) + "\n");
  const files = readExtractCache(d).files;
  assert.ok(Object.prototype.hasOwnProperty.call(files, "__proto__"), "stored as its own key");
  assert.deepEqual({ ...files["__proto__"] }, e);
  assert.equal(Object.getPrototypeOf(files), null, "no prototype for a crafted rel to reach");
  assert.equal(files["toString"], undefined, "an inherited name is not a cache hit");
});

test("extract cache: a CRLF file reads back the same", () => {
  const d = mkdtempSync(join(tmpdir(), "graft-ndjson-"));
  writeExtractCache(d, { ...emptyExtractCache(), files: { "src/a.ts": FILES["src/a.ts"] } });
  const p = extractCachePath(d)!;
  writeFileSync(p, readFileSync(p, "utf8").replace(/\n/g, "\r\n"));
  assert.deepEqual({ ...readExtractCache(d).files }, { "src/a.ts": FILES["src/a.ts"] });
});

test("extract cache: one line per entry, header first", () => {
  const d = mkdtempSync(join(tmpdir(), "graft-ndjson-"));
  writeExtractCache(d, { ...emptyExtractCache(), files: FILES });
  const lines = readFileSync(extractCachePath(d)!, "utf8").split("\n");
  assert.equal(lines[lines.length - 1], "", "trailing newline");
  assert.equal(lines.length - 1, 1 + Object.keys(FILES).length);
  assert.deepEqual(JSON.parse(lines[0]), { version: 2, extractor: emptyExtractCache().extractor });
});

test("extract cache: a wrong version, a wrong stamp, or a corrupt line means an empty cache, never a throw", () => {
  const d = mkdtempSync(join(tmpdir(), "graft-ndjson-"));
  writeExtractCache(d, { ...emptyExtractCache(), files: FILES });
  const p = extractCachePath(d)!;
  writeFileSync(p, readFileSync(p, "utf8").replace('"version":2', '"version":1'));
  assert.deepEqual(readExtractCache(d).files, {});
  writeExtractCache(d, { ...emptyExtractCache(), files: FILES });
  writeFileSync(p, readFileSync(p, "utf8") + "{not json\n");
  assert.deepEqual(readExtractCache(d).files, {}, "a corrupt line discards the cache: a partial memo is worse than none");
});

test("extract cache: an empty file set still writes a valid header the reader accepts", () => {
  const d = mkdtempSync(join(tmpdir(), "graft-ndjson-"));
  assert.ok(writeExtractCache(d, emptyExtractCache()));
  assert.deepEqual({ ...readExtractCache(d).files }, {});
});

import { readGraph, wiringPath, writeGraph } from "../src/graph/write.js";
import { askIndexPath, readAskIndex, writeAskIndex, type AskIndex } from "../src/ask/index-file.js";
import type { GraphV1, NodeV1 } from "../src/graph/types.js";

function node(id: string, extra: Partial<NodeV1> = {}): NodeV1 {
  return { id, name: id, kind: "function", path: "a.ts", span: "L1-L2", signature: null, exported: true, origin: "ast", body_hash: "h", chars: 10, summary_state: "pending", summary: null, crux: null, ...extra };
}
const GRAPH: GraphV1 = {
  meta: { version: 1, nodeCount: 2, edgeCount: 1, languages: ["typescript"], scopes: [{ prefix: "", label: "", markers: [] }] },
  nodes: [node("b", { body_text: "dropped on disk" }), node("a")],
  edges: [{ source: "b", relation: "calls", target: "a" } as never],
};

test("writeGraph streams a compact document equal to JSON.stringify of the sorted, body-stripped graph", () => {
  const d = mkdtempSync(join(tmpdir(), "graft-wiring-"));
  writeGraph(GRAPH, d);
  const text = readFileSync(wiringPath(d), "utf8");
  const expected = JSON.stringify({
    ...GRAPH,
    nodes: [...GRAPH.nodes].sort((x, y) => x.id.localeCompare(y.id)).map(({ body_text: _b, ...rest }) => rest),
    edges: GRAPH.edges,
  }) + "\n";
  assert.deepEqual(JSON.parse(text), JSON.parse(expected));
  assert.deepEqual(readGraph(wiringPath(d)), JSON.parse(expected));
});

test("writeGraph with no nodes and no edges is still valid", () => {
  const d = mkdtempSync(join(tmpdir(), "graft-wiring-"));
  writeGraph({ ...GRAPH, nodes: [], edges: [] }, d);
  assert.deepEqual(readGraph(wiringPath(d))!.nodes, []);
});

/** The AskIndex GRAPH must produce, written out by hand: one-letter names and the
 * "a" of "a.ts" are dropped by tokenize, as is "on" (a stop word). */
const GRAPH_ASK_INDEX: AskIndex = {
  version: 1,
  avgBodyLen: 1,
  df: [["ts", 2], ["dropped", 1], ["disk", 1]],
  docCount: 2,
  docs: [
    { id: "a", name: [], path: [["ts", 1]], body: [] },
    { id: "b", name: [], path: [["ts", 1]], body: [["dropped", 1], ["disk", 1]] },
  ],
};

/** JSON.stringify of an AskIndex with a newline before every doc and the close. */
function askLineShaped(idx: AskIndex): string {
  const { docs, ...head } = idx;
  return `${JSON.stringify(head).slice(0, -1)},"docs":[${docs.map((doc) => "\n" + JSON.stringify(doc)).join(",")}\n]}\n`;
}

test("writeAskIndex writes exactly the line-shaped JSON.stringify of the index it should build", () => {
  const d = mkdtempSync(join(tmpdir(), "graft-askidx-"));
  writeAskIndex(d, GRAPH);
  const text = readFileSync(askIndexPath(d), "utf8");
  assert.equal(text, askLineShaped(GRAPH_ASK_INDEX));
  assert.deepEqual(JSON.parse(text), JSON.parse(JSON.stringify(GRAPH_ASK_INDEX)), "and it is that object as JSON");
  assert.deepEqual(readAskIndex(d), GRAPH_ASK_INDEX);
});

test("readGraph and readAskIndex stream a CRLF file over the cap", () => {
  const d = mkdtempSync(join(tmpdir(), "graft-crlf-"));
  writeGraph(GRAPH, d);
  writeAskIndex(d, GRAPH);
  const graphText = readFileSync(wiringPath(d), "utf8");
  writeFileSync(wiringPath(d), graphText.replace(/\n/g, "\r\n"));
  writeFileSync(askIndexPath(d), readFileSync(askIndexPath(d), "utf8").replace(/\n/g, "\r\n"));
  assert.deepEqual(readGraph(wiringPath(d), { maxStringLength: 16 }), JSON.parse(graphText));
  assert.deepEqual(readAskIndex(d, { maxStringLength: 16 }), GRAPH_ASK_INDEX);
});

import { readGraphFromBuffer } from "../src/graph/write.js";
import { readAskIndexFromBuffer } from "../src/ask/index-file.js";

/** JSON.stringify of the graph with a newline at every node/edge boundary. */
function lineShaped(g: GraphV1): string {
  const nodes = [...g.nodes].sort((x, y) => x.id.localeCompare(y.id)).map(({ body_text: _b, ...rest }) => rest);
  const edges = [...g.edges].sort((a, b) => a.source.localeCompare(b.source) || a.relation.localeCompare(b.relation) || a.target.localeCompare(b.target));
  return `{"meta":${JSON.stringify(g.meta)},"nodes":[\n${nodes.map((n) => JSON.stringify(n)).join(",\n")}\n],"edges":[\n${edges.map((e) => JSON.stringify(e)).join(",\n")}\n]}\n`;
}

test("writeGraph writes one element per line and the file is still valid JSON", () => {
  const d = mkdtempSync(join(tmpdir(), "graft-wiring-lines-"));
  writeGraph(GRAPH, d);
  const text = readFileSync(wiringPath(d), "utf8");
  assert.equal(text, lineShaped(GRAPH));
  assert.deepEqual(JSON.parse(text), JSON.parse(lineShaped(GRAPH)));
  assert.deepEqual(readGraph(wiringPath(d)), JSON.parse(text));
});

test("readGraph streams a file over the cap and returns the same graph as JSON.parse", () => {
  const d = mkdtempSync(join(tmpdir(), "graft-wiring-stream-"));
  writeGraph(GRAPH, d);
  const text = readFileSync(wiringPath(d), "utf8");
  assert.deepEqual(readGraph(wiringPath(d), { maxStringLength: 16 }), JSON.parse(text), "forced streaming path");
  assert.deepEqual(readGraphFromBuffer(readFileSync(wiringPath(d))), JSON.parse(text));
  const empty = { ...GRAPH, nodes: [], edges: [] };
  writeGraph(empty, d);
  assert.deepEqual(readGraph(wiringPath(d), { maxStringLength: 16 }), JSON.parse(readFileSync(wiringPath(d), "utf8")));
});

test("readGraph streaming returns null on a file that is not line-shaped", () => {
  assert.equal(readGraphFromBuffer(Buffer.from('{"meta":{},"nodes":[{"id":"a"}],"edges":[]}\n')), null, "one-line JSON is not the streamed shape");
  assert.equal(readGraphFromBuffer(Buffer.from("garbage\n")), null);
});

test("readGraphFromBuffer tolerates a top-level header key other than meta before nodes", () => {
  // A hand-written header carrying an extra key ahead of "nodes": the reader must
  // parse the whole header object rather than slice `meta` out by fixed offsets, so
  // the extra field survives on the result instead of failing the parse.
  const meta = JSON.stringify(GRAPH.meta);
  const buf = Buffer.from(`{"meta":${meta},"extra":1,"nodes":[\n],"edges":[\n]}\n`);
  const g = readGraphFromBuffer(buf);
  assert.ok(g, "parsed the hand-written header");
  assert.deepEqual(g!.meta, GRAPH.meta);
  assert.equal((g as unknown as { extra: number }).extra, 1, "the extra key survives on the result");
  assert.deepEqual(g!.nodes, []);
  assert.deepEqual(g!.edges, []);
});

test("writeGraph refuses a graph carrying a top-level key other than meta/nodes/edges", () => {
  const d = mkdtempSync(join(tmpdir(), "graft-wiring-guard-"));
  const rogue = { ...GRAPH, extra: 1 } as unknown as GraphV1;
  assert.throws(() => writeGraph(rogue, d), /extra/, "the error names the offending key so it can't silently corrupt the head slice");
});

test("writeAskIndex writes one doc per line, still valid JSON, and streams back identically", () => {
  const d = mkdtempSync(join(tmpdir(), "graft-askidx-lines-"));
  writeAskIndex(d, GRAPH);
  const text = readFileSync(askIndexPath(d), "utf8");
  const parsed = JSON.parse(text);
  assert.equal(text.split("\n").length - 1, 1 + parsed.docs.length + 1, "header line, one line per doc, closing line");
  assert.deepEqual(readAskIndex(d), parsed);
  assert.deepEqual(readAskIndex(d, { maxStringLength: 16 }), parsed, "forced streaming path");
  assert.deepEqual(readAskIndexFromBuffer(readFileSync(askIndexPath(d))), parsed);
});
