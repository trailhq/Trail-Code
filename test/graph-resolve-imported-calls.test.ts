import { test } from "node:test";
import assert from "node:assert/strict";
import { extractFile } from "../src/graph/extract.js";
import { resolveEdges } from "../src/graph/resolve.js";
import type { NodeV1 } from "../src/graph/types.js";

// #330: a TypeScript call through a named import must not resolve to an
// unrelated same-named local function when the import is external or points at
// a different in-repo module.

function n(id: string, kind: NodeV1["kind"]): NodeV1 {
  const post = id.includes("#") ? id.split("#")[1] : id;
  const name = post.split(".").pop()!;
  return { id, name, kind, path: id.split("#")[0], span: "L1-L1", signature: null,
    exported: true, origin: "ast", body_hash: "h", summary_state: "pending", summary: null, crux: null } as NodeV1;
}

test("extract: a bare call through a named import carries the module and exported name", () => {
  const { rawEdges: edges } = extractFile(
    "src/component.ts",
    [
      'import { useRouter } from "next/navigation";',
      'import { helper as h } from "./lib/util";',
      "export function Component() {",
      "  h();",
      "  return useRouter();",
      "}",
    ].join("\n"),
    "typescript",
  );
  const calls = edges.filter((e) => e.relation === "calls" && e.source === "src/component.ts#Component");
  assert.deepEqual(
    calls.map((e) => ({ name: e.name, specifier: e.specifier })).sort((a, b) => a.name!.localeCompare(b.name!)),
    [
      { name: "helper", specifier: "./lib/util" },
      { name: "useRouter", specifier: "next/navigation" },
    ],
  );
});

test("extract: a local declaration shadowing the import keeps the call a bare name", () => {
  const { rawEdges: edges } = extractFile(
    "src/a.ts",
    [
      'import { useRouter } from "next/navigation";',
      "export function Component() {",
      "  const useRouter = () => 1;",
      "  return useRouter();",
      "}",
    ].join("\n"),
    "typescript",
  );
  const call = edges.find((e) => e.relation === "calls" && e.name === "useRouter");
  assert.ok(call);
  assert.equal(call.specifier, undefined);
});

const NODES = [
  n("src/component.ts", "file"), n("src/component.ts#Component", "function"),
  n("test/next-navigation-mock.ts", "file"), n("test/next-navigation-mock.ts#useRouter", "function"),
  n("src/lib/router.ts", "file"), n("src/lib/router.ts#useRouter", "function"),
  n("src/index.ts", "file"),
];

test("resolve: a call imported from an external package does not bind to a local same-named function", () => {
  const edges = resolveEdges(NODES.filter((x) => !x.id.startsWith("src/lib/router")), [
    { source: "src/component.ts#Component", relation: "calls", name: "useRouter", file: "src/component.ts", specifier: "next/navigation" },
  ]);
  assert.equal(edges.filter((e) => e.relation === "calls").length, 0);
});

test("resolve: without import provenance the unique-name fallback still applies (unchanged)", () => {
  const edges = resolveEdges(NODES.filter((x) => !x.id.startsWith("src/lib/router")), [
    { source: "src/component.ts#Component", relation: "calls", name: "useRouter", file: "src/component.ts" },
  ]);
  const call = edges.find((e) => e.relation === "calls");
  assert.equal(call?.target, "test/next-navigation-mock.ts#useRouter");
  assert.equal(call?.confidence, "inferred");
});

test("resolve: a call imported from an in-repo module resolves inside that module, not the mock", () => {
  const edges = resolveEdges(NODES, [
    { source: "src/component.ts#Component", relation: "calls", name: "useRouter", file: "src/component.ts", specifier: "./lib/router" },
  ]);
  const call = edges.find((e) => e.relation === "calls");
  assert.equal(call?.target, "src/lib/router.ts#useRouter");
  assert.equal(call?.confidence, "extracted");
});

test("resolve: an in-repo barrel that does not define the name keeps the name-based fallback", () => {
  const edges = resolveEdges(NODES.filter((x) => !x.id.startsWith("test/")), [
    { source: "src/component.ts#Component", relation: "calls", name: "useRouter", file: "src/component.ts", specifier: "./index" },
  ]);
  const call = edges.find((e) => e.relation === "calls");
  assert.equal(call?.target, "src/lib/router.ts#useRouter");
  assert.equal(call?.confidence, "inferred");
});
