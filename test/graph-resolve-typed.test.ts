import { test } from "node:test";
import assert from "node:assert/strict";
import { buildRepoMap } from "../src/graph/map.js";
import { resolveEdges } from "../src/graph/resolve.js";
import { extractFile } from "../src/graph/extract.js";
import type { RawEdge } from "../src/graph/extract.js";
import type { NodeV1 } from "../src/graph/types.js";

// `owner` mirrors what extractFile now stamps on a method node: the bare name of
// its immediate enclosing class (the segment just before its own name in the
// dotted id) — set here so these hand-built fixtures match real extraction output.
function n(id: string, kind: NodeV1["kind"]): NodeV1 {
  const post = id.includes("#") ? id.split("#")[1] : id;
  const segs = post.split(".");
  const name = segs[segs.length - 1];
  const owner = kind === "method" && segs.length >= 2 ? segs[segs.length - 2] : undefined;
  return { id, name, kind, owner, path: id.split("#")[0], span: "L1-L1", signature: null,
    exported: true, origin: "ast", body_hash: "h", summary_state: "pending", summary: null, crux: null } as NodeV1;
}

const NODES = [
  n("app.py", "file"), n("app.py#FastAPI", "class"), n("app.py#FastAPI.include_router", "method"),
  n("routing.py", "file"), n("routing.py#APIRouter", "class"), n("routing.py#APIRouter.include_router", "method"),
  n("t.py", "file"), n("t.py#test_x", "function"),
];

test("typed member call resolves despite global name ambiguity", () => {
  const edges = resolveEdges(NODES, [
    { source: "t.py#test_x", relation: "calls", name: "include_router", viaMember: true, recvType: "FastAPI", file: "t.py" },
  ]);
  const call = edges.find((e) => e.relation === "calls");
  assert.equal(call?.target, "app.py#FastAPI.include_router");
  assert.equal(call?.confidence, "inferred");
});

test("untyped ambiguous member call still drops (regression guard)", () => {
  const edges = resolveEdges(NODES, [
    { source: "t.py#test_x", relation: "calls", name: "include_router", viaMember: true, file: "t.py" },
  ]);
  assert.equal(edges.filter((e) => e.relation === "calls").length, 0);
});

test("extends chain: method inherited from parent resolves", () => {
  const nodes = [...NODES, n("sub.py", "file"), n("sub.py#MyApp", "class"), n("u.py", "file"), n("u.py#use", "function")];
  const edges = resolveEdges(nodes, [
    { source: "sub.py#MyApp", relation: "extends", name: "FastAPI", file: "sub.py" },
    { source: "u.py#use", relation: "calls", name: "include_router", viaMember: true, recvType: "MyApp", file: "u.py" },
  ]);
  const call = edges.find((e) => e.relation === "calls");
  assert.equal(call?.target, "app.py#FastAPI.include_router");
});

test("ambiguous owner level drops instead of guessing", () => {
  const nodes = [...NODES, n("v2.py", "file"), n("v2.py#FastAPI", "class"), n("v2.py#FastAPI.include_router", "method")];
  const edges = resolveEdges(nodes, [
    { source: "t.py#test_x", relation: "calls", name: "include_router", viaMember: true, recvType: "FastAPI", file: "t.py" },
  ]);
  assert.equal(edges.filter((e) => e.relation === "calls").length, 0);
});

test("same-file owner wins among duplicates, confidence extracted", () => {
  const nodes = [...NODES, n("t.py#FastAPI", "class"), n("t.py#FastAPI.include_router", "method")];
  const edges = resolveEdges(nodes, [
    { source: "t.py#test_x", relation: "calls", name: "include_router", viaMember: true, recvType: "FastAPI", file: "t.py" },
  ]);
  const call = edges.find((e) => e.relation === "calls");
  assert.equal(call?.target, "t.py#FastAPI.include_router");
  assert.equal(call?.confidence, "extracted");
});

test("unknown receiver type does not guess from a unique bare method name", () => {
  const nodes = [n("a.py", "file"), n("a.py#Only", "class"), n("a.py#Only.solo", "method"), n("b.py", "file"), n("b.py#f", "function")];
  const edges = resolveEdges(nodes, [
    { source: "b.py#f", relation: "calls", name: "solo", viaMember: true, recvType: "Ghost", file: "b.py" },
  ]);
  assert.equal(edges.filter((e) => e.relation === "calls").length, 0);
});

test("untyped member call does not guess from a unique bare method name", () => {
  const nodes = [n("a.py", "file"), n("a.py#Only", "class"), n("a.py#Only.solo", "method"), n("b.py", "file"), n("b.py#f", "function")];
  const edges = resolveEdges(nodes, [
    { source: "b.py#f", relation: "calls", name: "solo", viaMember: true, file: "b.py" },
  ]);
  assert.equal(edges.filter((e) => e.relation === "calls").length, 0);
});

test("builtin-container receiver drops instead of bare-name fallback", () => {
  const nodes = [n("b.py", "file"), n("b.py#FileBindings", "class"), n("b.py#FileBindings.set", "method"), n("c.py", "file"), n("c.py#f", "function")];
  const edges = resolveEdges(nodes, [
    { source: "c.py#f", relation: "calls", name: "set", viaMember: true, recvType: "dict", file: "c.py" },
  ]);
  assert.equal(edges.filter((e) => e.relation === "calls").length, 0);
});

test("builtin-container receiver (TS Map) drops instead of bare-name fallback", () => {
  const nodes = [n("b.ts", "file"), n("b.ts#FileBindings", "class"), n("b.ts#FileBindings.set", "method"), n("c.ts", "file"), n("c.ts#f", "function")];
  const edges = resolveEdges(nodes, [
    { source: "c.ts#f", relation: "calls", name: "set", viaMember: true, recvType: "Map", file: "c.ts" },
  ]);
  assert.equal(edges.filter((e) => e.relation === "calls").length, 0);
});

test("Go NewServer()→Server recall still resolves (regression guard, non-builtin recvType)", () => {
  const nodes = [n("srv.go", "file"), n("srv.go#Server", "class"), n("srv.go#Server.Start", "method"), n("m.go", "file"), n("m.go#f", "function")];
  const edges = resolveEdges(nodes, [
    { source: "m.go#f", relation: "calls", name: "Start", viaMember: true, recvType: "Server", file: "m.go" },
  ]);
  assert.equal(edges.find((e) => e.relation === "calls")?.target, "srv.go#Server.Start");
});

test("unresolved member calls cannot inflate map hubs and hotspots (#35)", () => {
  const nodes = [
    n("bindings.ts", "file"),
    n("bindings.ts#FileBindings", "class"),
    n("bindings.ts#FileBindings.set", "method"),
    n("consumer.ts", "file"),
    n("consumer.ts#write", "function"),
    n("real.ts", "file"),
    n("real.ts#writeBinding", "function"),
  ];
  const edges = resolveEdges(nodes, [
    { source: "consumer.ts#write", relation: "calls", name: "set", viaMember: true, file: "consumer.ts" },
    { source: "consumer.ts#write", relation: "calls", name: "set", viaMember: true, recvType: "Map", file: "consumer.ts" },
    { source: "real.ts#writeBinding", relation: "calls", name: "set", viaMember: true, recvType: "FileBindings", file: "real.ts" },
  ]);

  const map = buildRepoMap({
    meta: { version: 1, nodeCount: nodes.length, edgeCount: edges.length, languages: ["typescript"] },
    nodes,
    edges,
  });
  const set = map.hotspots.find((h) => h.name === "set");
  assert.equal(set?.inDegree, 1, "only the owner-qualified FileBindings.set call contributes");
});

// A2: resolve.ts used to derive ownerMethod/classParents keys by slicing `n.id`,
// which breaks once ids can carry a dedup ordinal (A3). extract.ts now stamps a
// `owner` field at mint time instead; these tests pin the field's contract and
// prove the owner-keyed lookups it feeds still resolve exactly as the old
// slicing did.

test("A2: extractFile sets NodeV1.owner to the immediate enclosing class/receiver on method nodes only", () => {
  const tsNodes = extractFile("a.ts", "class Cache {\n  get(): void {}\n}\n", "typescript").nodes;
  assert.equal(tsNodes.find((x) => x.id === "a.ts#Cache.get")?.owner, "Cache");
  assert.equal(tsNodes.find((x) => x.id === "a.ts#Cache")?.owner, undefined, "a class node itself carries no owner");

  const pyNodes = extractFile(
    "b.py",
    "class Outer:\n    def render(self):\n        pass\n\n\nclass Container:\n    class Inner:\n        def render(self):\n            pass\n",
    "python",
  ).nodes;
  assert.equal(pyNodes.find((x) => x.id === "b.py#Outer.render")?.owner, "Outer");
  assert.equal(
    pyNodes.find((x) => x.id === "b.py#Container.Inner.render")?.owner,
    "Inner",
    "nested class: owner is the immediate parent, not the outer container",
  );

  const goNodes = extractFile("c.go", "package c\n\ntype Server struct{}\n\nfunc (s *Server) Start() {}\n", "go").nodes;
  assert.equal(goNodes.find((x) => x.id === "c.go#Server.Start")?.owner, "Server");
});

test("PHP trait method: $this->m() resolves via implements (trait-use) edge", () => {
  const nodes = [
    n("app.php", "file"),
    n("app.php#Widget", "class"),
    n("app.php#Widget.run", "method"),
    n("app.php#Loggable", "trait"),
    n("app.php#Loggable.log", "method"),
  ];
  const edges = resolveEdges(nodes, [
    { source: "app.php#Widget", relation: "implements", name: "Loggable", file: "app.php" },
    { source: "app.php#Widget.run", relation: "calls", name: "log", viaMember: true, recvType: "Widget", file: "app.php" },
  ]);
  const call = edges.find((e) => e.relation === "calls");
  assert.equal(call?.target, "app.php#Loggable.log");
  assert.equal(call?.confidence, "extracted");
});

test("PHP trait method: ambiguous when two traits provide the same method", () => {
  const nodes = [
    n("app.php", "file"),
    n("app.php#Widget", "class"),
    n("app.php#Widget.run", "method"),
    n("app.php#T1", "trait"),
    n("app.php#T1.log", "method"),
    n("app.php#T2", "trait"),
    n("app.php#T2.log", "method"),
  ];
  const edges = resolveEdges(nodes, [
    { source: "app.php#Widget", relation: "implements", name: "T1", file: "app.php" },
    { source: "app.php#Widget", relation: "implements", name: "T2", file: "app.php" },
    { source: "app.php#Widget.run", relation: "calls", name: "log", viaMember: true, recvType: "Widget", file: "app.php" },
  ]);
  assert.equal(edges.filter((e) => e.relation === "calls").length, 0);
});

test("A2: owner-keyed ownerMethod/classParents resolve identically to the old id-slicing scheme (mixed fixture: sibling classes + inheritance)", () => {
  const src = [
    "class Base {",
    "  render(): void {}",
    "}",
    "class Widget extends Base {",
    "  render(): void {}",
    "}",
    "class Other {",
    "  render(): void {}",
    "}",
    "class Sub extends Other {}",
    "function use(): void {}",
    "",
  ].join("\n");
  const { nodes, rawEdges } = extractFile("mixed.ts", src, "typescript");

  const callWidget: RawEdge = { source: "mixed.ts#use", relation: "calls", name: "render", viaMember: true, recvType: "Widget", file: "mixed.ts" };
  const callSub: RawEdge = { source: "mixed.ts#use", relation: "calls", name: "render", viaMember: true, recvType: "Sub", file: "mixed.ts" };
  const edges = resolveEdges(nodes, [...rawEdges, callWidget, callSub]);

  const targets = edges
    .filter((e) => e.relation === "calls" && e.source === "mixed.ts#use")
    .map((e) => e.target)
    .sort();
  assert.deepEqual(
    targets,
    ["mixed.ts#Other.render", "mixed.ts#Widget.render"],
    "Widget's own render must win over Base's/Other's (owner-scoped), and Sub inherits Other's via classParents",
  );
});

// #305 — Python's service-class convention (business logic on classmethods,
// invoked as `MyService.do_thing()`) resolved to nothing: the receiver is a class
// name, not a variable, so the bindings lookup missed and no recvType was stamped.
// `graft callers` then reported only the internal `cls.` call sites, which is worse
// than empty — a method with four callers reads as having one.

test("#305: a Python call bound by class name stamps the class as recvType", () => {
  const src = [
    "class SearchIndexService:",
    "    @classmethod",
    "    def variables_manquantes(cls):",
    "        return cls.helper()",
    "",
    "def outside():",
    "    return SearchIndexService.variables_manquantes()",
    "",
  ].join("\n");

  const edges = extractFile("svc.py", src, "python").rawEdges;
  const external = edges.find((e) => e.relation === "calls" && e.name === "variables_manquantes" && e.source === "svc.py#outside");

  assert.ok(external, "the SomeClass.method() call site is extracted at all");
  assert.equal(external?.recvType, "SearchIndexService");
});

test("#305: a lower_case Python receiver is still left untyped", () => {
  // PEP 8 is the whole signal, so a variable receiver must keep falling through
  // to the bindings table rather than being read as a type.
  const src = ["def outside(service):", "    return service.variables_manquantes()", ""].join("\n");

  const edges = extractFile("svc.py", src, "python").rawEdges;
  const call = edges.find((e) => e.relation === "calls" && e.name === "variables_manquantes");

  assert.ok(call, "the call is extracted");
  assert.equal(call?.recvType, undefined);
});

test("#305: the class-bound call resolves to the classmethod, not a same-named function", () => {
  const nodes = [
    n("svc.py", "file"),
    n("svc.py#SearchIndexService", "class"),
    n("svc.py#SearchIndexService.variables_manquantes", "method"),
    n("other.py", "file"),
    n("other.py#variables_manquantes", "function"),
    n("caller.py", "file"),
    n("caller.py#outside", "function"),
  ];

  const edges = resolveEdges(nodes, [
    {
      source: "caller.py#outside",
      relation: "calls",
      name: "variables_manquantes",
      viaMember: true,
      recvType: "SearchIndexService",
      file: "caller.py",
    },
  ]);

  assert.equal(edges.find((e) => e.relation === "calls")?.target, "svc.py#SearchIndexService.variables_manquantes");
});
