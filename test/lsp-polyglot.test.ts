import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { enrichWithLsp } from "../src/graph/lsp/enrich.js";
import type { GraphV1, NodeV1 } from "../src/graph/types.js";

// Real stdio LSP peers, installed on an isolated PATH. Each rejects documents
// from other languages and records requests before replying, with no sleeps.
const fakeServer = `#!${process.execPath}
import { createMessageConnection, StreamMessageReader, StreamMessageWriter } from ${JSON.stringify(import.meta.resolve("vscode-jsonrpc/node.js"))};
import { appendFileSync, existsSync } from "node:fs";
import { basename, extname } from "node:path";
import { fileURLToPath } from "node:url";
const server = basename(process.argv[1]);
const extensions = server === "clangd" ? [".c", ".cpp"] : server === "pyright-langserver" ? [".py"] : [".ts", ".tsx"];
const conn = createMessageConnection(new StreamMessageReader(process.stdin), new StreamMessageWriter(process.stdout));
function record(method, uri) {
  appendFileSync("requests.jsonl", JSON.stringify({ server, method, uri }) + "\\n");
  if (uri && !extensions.includes(extname(fileURLToPath(uri)))) throw new Error("wrong language: " + uri);
}
function item(uri, line) {
  const range = { start: { line, character: 0 }, end: { line, character: 20 } };
  return { name: line === 0 ? "target" : "source", kind: 12, uri, range, selectionRange: range };
}
conn.onRequest("initialize", () => {
  record("initialize");
  return existsSync("fail-" + server) ? null : { capabilities: { callHierarchyProvider: true } };
});
conn.onNotification("textDocument/didOpen", p => record("open", p.textDocument.uri));
conn.onRequest("textDocument/prepareCallHierarchy", p => {
  record("prepare", p.textDocument.uri);
  return [item(p.textDocument.uri, p.position.line)];
});
conn.onRequest("callHierarchy/outgoingCalls", p => {
  record("outgoing", p.item.uri);
  return p.item.name === "source" ? [{ to: item(p.item.uri, 0), fromRanges: [] }] : [];
});
conn.listen();
`;

test("polyglot LSP enrichment", { skip: process.platform === "win32" }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "graft-lsp-polyglot-"));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  const commands = ["clangd", "pyright-langserver", "typescript-language-server"];
  for (const command of commands) writeFileSync(join(bin, command), fakeServer, { mode: 0o755 });
  // Extensionless executable fixtures must be parsed as ES modules on Node 20 too.
  writeFileSync(join(bin, "package.json"), '{"type":"module"}');
  const oldPath = process.env.PATH;
  process.env.PATH = bin;
  t.after(() => {
    if (oldPath === undefined) delete process.env.PATH;
    else process.env.PATH = oldPath;
    rmSync(dir, { recursive: true, force: true });
  });

  function fixture(name: string, files = ["native.c", "app.py"]) {
    const root = join(dir, name);
    mkdirSync(root);
    const nodes: NodeV1[] = [];
    for (const path of files) {
      const source = path.endsWith(".py")
        ? "def target(): return 1\ndef source(): return target()\n"
        : path.endsWith(".c") || path.endsWith(".cpp")
          ? "int target(void) { return 1; }\nint source(void) { return target(); }\n"
          : "function target() { return 1; }\nfunction source() { return target(); }\n";
      writeFileSync(join(root, path), source);
      for (const [i, name] of ["target", "source"].entries()) nodes.push({
        id: `${path}#${name}`, path, name, kind: "function", span: `L${i + 1}-L${i + 1}`,
        signature: null, exported: true, origin: "ast", body_hash: "x",
        summary_state: "pending", summary: null, crux: null,
      });
    }
    const graph: GraphV1 = {
      meta: { version: 1, nodeCount: nodes.length, edgeCount: 0, languages: [], scopes: [] },
      nodes, edges: [],
    };
    const requests = () => readFileSync(join(root, "requests.jsonl"), "utf8").trim().split("\n")
      .map((line) => JSON.parse(line) as { server: string; method: string; uri?: string });
    return { root, graph, requests };
  }

  await t.test("clangd does not shadow Python, and each server opens only its own files", async () => {
    const { root, graph, requests } = fixture("mixed");
    graph.edges.push({ source: "native.c#source", target: "native.c#target", relation: "calls", confidence: "extracted" });
    const progress: number[][] = [];
    const result = await enrichWithLsp(graph, root, { onProgress: (done, total) => progress.push([done, total]) });
    assert.ok(graph.edges.some((e) => e.source === "app.py#source" && e.target === "app.py#target" && e.confidence === "lsp_resolved"));
    assert.equal(graph.edges.length, 2, "existing AST edges must not be duplicated");
    assert.equal(result.added, 1);
    assert.equal(result.queried, 4);
    assert.deepEqual(progress, [[1, 4], [2, 4], [3, 4], [4, 4]]);
    assert.deepEqual(requests().filter((r) => r.method === "initialize").map((r) => r.server), commands.slice(0, 2));
    assert.deepEqual(requests().filter((r) => r.method === "open").map((r) => [r.server, r.uri?.split("/").pop()]),
      [["clangd", "native.c"], ["pyright-langserver", "app.py"]]);
  });

  await t.test("a server that fails initialization does not prevent the next language", async () => {
    const { root, graph } = fixture("failed-first");
    writeFileSync(join(root, "fail-clangd"), "");
    const result = await enrichWithLsp(graph, root);
    assert.equal(result.added, 1);
    assert.equal(result.queried, 2);
    assert.deepEqual(graph.edges.map((e) => e.source), ["app.py#source"]);
  });

  await t.test("shared language servers start once for C/C++ and TS/TSX", async () => {
    const { root, graph, requests } = fixture("shared", ["native.c", "native.cpp", "app.py", "app.ts", "view.tsx"]);
    const result = await enrichWithLsp(graph, root);
    assert.equal(result.added, 5);
    assert.equal(result.queried, 10);
    assert.deepEqual(requests().filter((r) => r.method === "initialize").map((r) => r.server), commands);
  });

  await t.test("maxNodes remains a repo-wide budget across servers", async () => {
    const { root, graph, requests } = fixture("limited");
    const result = await enrichWithLsp(graph, root, { maxNodes: 3 });
    assert.equal(result.queried, 3);
    assert.equal(requests().filter((r) => r.method === "outgoing").length, 3);
  });
});
