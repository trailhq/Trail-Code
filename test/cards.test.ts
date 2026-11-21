import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import matter from "gray-matter";
import { writeCards, writeCovers, writeIndex } from "../src/graph/cards.js";
import type { GraphV1, NodeV1 } from "../src/graph/types.js";

const node = (overrides: Partial<NodeV1>): NodeV1 => ({
  id: "src/a.ts#run", name: "run", kind: "function", path: "src/a.ts", span: "L1-L2",
  signature: "run(): void", exported: true, origin: "ast", body_hash: "symbol",
  summary_state: "pending", summary: null, crux: null, ...overrides,
});

test("unchanged cards, index, and covers keep their modification times", () => {
  const out = mkdtempSync(join(tmpdir(), "graft-cards-"));
  try {
    const concept = join(out, "example.md");
    writeFileSync(concept, matter.stringify("# Example\n", {
      slug: "example", name: "Example", sources: [{ path: "src/a.ts", hash: "source" }],
    }));
    const graph: GraphV1 = {
      meta: { version: 1, nodeCount: 2, edgeCount: 0, languages: ["typescript"] },
      nodes: [node({ id: "src/a.ts", name: "a.ts", kind: "file", signature: null }), node()], edges: [],
    };

    const first = writeCards(graph, out);
    writeIndex(out, first.files);
    assert.equal(writeCovers(graph, out), 1);
    const paths = [join(out, "src", "a.md"), join(out, "INDEX.md"), concept];
    const old = new Date("2001-01-01T00:00:00.000Z");
    const mtimes = new Map<string, number>();
    for (const path of paths) {
      utimesSync(path, old, old);
      mtimes.set(path, statSync(path).mtimeMs);
    }

    const second = writeCards(graph, out);
    writeIndex(out, second.files);
    assert.equal(writeCovers(graph, out), 1);
    assert.equal(second.written, 1);
    for (const path of paths) assert.equal(statSync(path).mtimeMs, mtimes.get(path));
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test("same-stem sources get their own cards without replacing INDEX.md", () => {
  const out = mkdtempSync(join(tmpdir(), "graft-card-paths-"));
  try {
    const sources = ["src/api.ts", "src/api.js", "src/api.ts.go", "src/API.py", "INDEX.js", "index.ts"];
    const graph: GraphV1 = {
      meta: { version: 1, nodeCount: sources.length, edgeCount: 0, languages: [] },
      nodes: sources.map((path, i) => node({ id: `${path}#symbol${i}`, path, name: `symbol${i}` })),
      edges: [],
    };

    const cards = writeCards(graph, out);
    writeIndex(out, cards.files);
    assert.equal(cards.written, sources.length);
    assert.equal(new Set(cards.files.map((f) => f.card.toLowerCase())).size, sources.length);
    for (const { card, path } of cards.files) {
      assert.notEqual(card.toLowerCase(), "index.md");
      const body = readFileSync(join(out, card), "utf8");
      assert.equal(body.split("\n")[0], `# ${path}`);
      assert.ok(body.includes(`symbol${sources.indexOf(path)}`), `the card contains its own symbol for ${path}`);
    }
    assert.match(readFileSync(join(out, "INDEX.md"), "utf8"), /^# graft — repo map/);

    const reversed = writeCards({ ...graph, nodes: [...graph.nodes].reverse() }, out);
    assert.deepEqual(reversed.files, cards.files, "source iteration order does not change card assignment");
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});
