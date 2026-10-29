import { test } from "node:test";
import assert from "node:assert/strict";
import { extractFile } from "../src/graph/extract.js";
import { warmDepthGrammars } from "../src/graph/depth-parser.js";

// extractFile is synchronous; its WASM grammars load once, up front.
await warmDepthGrammars(["python", "typescript", "go"]);

function callEdges(src: string, lang: "python" | "typescript" | "go", file = `x.${lang === "python" ? "py" : lang === "go" ? "go" : "ts"}`) {
  return extractFile(file, src, lang).rawEdges.filter((e) => e.relation === "calls");
}

test("py: constructor assignment binds receiver type", () => {
  const edges = callEdges("class A:\n    def m(self): pass\napp = A()\ndef f():\n    app.m()\n", "python");
  const call = edges.find((e) => e.name === "m" && e.viaMember);
  assert.equal(call?.recvType, "A");
});

test("py: parameter annotation binds", () => {
  const edges = callEdges("def f(app: FastAPI):\n    app.include_router()\n", "python");
  assert.equal(edges.find((e) => e.name === "include_router")?.recvType, "FastAPI");
});

test("py: self binds to enclosing class; self.attr via __init__ assignment", () => {
  const src = "class S:\n    def __init__(self):\n        self.q = Queue()\n    def go(self):\n        self.helper()\n        self.q.put(1)\n";
  const edges = callEdges(src, "python");
  assert.equal(edges.find((e) => e.name === "helper")?.recvType, "S");
  assert.equal(edges.find((e) => e.name === "put")?.recvType, "Queue");
});

test("py: import alias resolves to original name", () => {
  const edges = callEdges("from fastapi import FastAPI as F\napp = F()\napp.get()\n", "python");
  assert.equal(edges.find((e) => e.name === "get")?.recvType, "FastAPI");
});

test("py: unknown receiver leaves recvType unset (chained call)", () => {
  const edges = callEdges("def f():\n    factory().run()\n", "python");
  assert.equal(edges.find((e) => e.name === "run")?.recvType, undefined);
});

test("ts: new-expression + type annotation + this", () => {
  const src = "class S {\n  q: Queue = new Queue();\n  go() { this.helper(); this.q.put(1); }\n  helper() {}\n}\nconst app = new FastAPI();\nfunction f(r: Router) { app.mount(); r.use(); }\n";
  const edges = callEdges(src, "typescript");
  assert.equal(edges.find((e) => e.name === "helper")?.recvType, "S");
  assert.equal(edges.find((e) => e.name === "put")?.recvType, "Queue");
  assert.equal(edges.find((e) => e.name === "mount")?.recvType, "FastAPI");
  assert.equal(edges.find((e) => e.name === "use")?.recvType, "Router");
});

test("ts: constructor parameter property binds this.<name> (#76 — the NestJS/Angular DI idiom)", () => {
  // `private readonly svc: Svc` is a parameter AND a class field; `this.svc.m()` must
  // resolve. Before the fix its recvType was undefined and the call edge was dropped.
  const src = "class C {\n  constructor(private readonly svc: Svc) {}\n  run() { this.svc.m(); }\n}\n";
  assert.equal(callEdges(src, "typescript").find((e) => e.name === "m")?.recvType, "Svc");
  // every parameter-property modifier form: public / protected / bare readonly / override
  const forms = [
    "constructor(public svc: Svc) {}",
    "constructor(protected svc: Svc) {}",
    "constructor(readonly svc: Svc) {}",
    "constructor(private override svc: Svc) {}",
  ];
  for (const ctor of forms) {
    const s = `class C {\n  ${ctor}\n  run() { this.svc.m(); }\n}\n`;
    assert.equal(callEdges(s, "typescript").find((e) => e.name === "m")?.recvType, "Svc", ctor);
  }
});

test("ts: a PLAIN constructor parameter creates no this.<name> binding (no over-reach)", () => {
  // bare-name use of an ordinary parameter still binds (unchanged)
  const bare = "class C {\n  constructor(svc: Svc) { svc.m(); }\n}\n";
  assert.equal(callEdges(bare, "typescript").find((e) => e.name === "m")?.recvType, "Svc");
  // but with no modifier it is NOT a field, so `this.svc` must stay unresolved (drop, not guess)
  const viaThis = "class C {\n  constructor(svc: Svc) {}\n  run() { this.svc.m(); }\n}\n";
  assert.equal(callEdges(viaThis, "typescript").find((e) => e.name === "m")?.recvType, undefined);
});

test("go: composite literal, var decl, NewX convention, receiver var", () => {
  const src = "package m\nfunc f() {\n  u := User{}\n  var d *DB\n  s := NewServer()\n  u.Save()\n  d.Query()\n  s.Start()\n}\nfunc (w *Worker) run() { w.stop() }\n";
  const edges = callEdges(src, "go", "x.go");
  assert.equal(edges.find((e) => e.name === "Save")?.recvType, "User");
  assert.equal(edges.find((e) => e.name === "Query")?.recvType, "DB");
  assert.equal(edges.find((e) => e.name === "Start")?.recvType, "Server");
  assert.equal(edges.find((e) => e.name === "stop")?.recvType, "Worker");
});

test("scope shadowing: inner binding wins", () => {
  const src = "app = A()\ndef f():\n    app = B()\n    app.m()\n";
  const edges = callEdges(src, "python");
  assert.equal(edges.find((e) => e.name === "m")?.recvType, "B");
});

test("go: binding inside a method body resolves (scope parity with extract)", () => {
  const src = "package m\nfunc (w *Worker) run() {\n  u := User{}\n  u.Save()\n}\n";
  const edges = callEdges(src, "go", "x.go");
  assert.equal(edges.find((e) => e.name === "Save")?.recvType, "User");
});

test("go: local binding shadows package-level var (never the wrong type)", () => {
  const src = "package m\nvar u *Logger\nfunc (w *Worker) run() {\n  u := User{}\n  u.Save()\n}\n";
  const edges = callEdges(src, "go", "x.go");
  assert.equal(edges.find((e) => e.name === "Save")?.recvType, "User");
});

test("ts: aliased type annotation resolves to original name", () => {
  const edges = callEdges("import { Router as R } from './r';\nfunction f(r: R) { r.use(); }\n", "typescript");
  assert.equal(edges.find((e) => e.name === "use")?.recvType, "Router");
});

test("py: aliased annotation resolves to original name", () => {
  const edges = callEdges("from r import APIRouter as AR\ndef f(r: AR):\n    r.get()\n", "python");
  assert.equal(edges.find((e) => e.name === "get")?.recvType, "APIRouter");
});

// A barrel file (`export { X } from "./x"`) defines nothing, so before re-exports
// were treated as imports its node carried no outgoing edges at all and any
// traversal arriving there stopped, never reaching the module holding the code.
function importSpecs(src: string) {
  return extractFile("index.ts", src, "typescript")
    .rawEdges.filter((e) => e.relation === "imports")
    .map((e) => e.specifier);
}

test("ts: a named re-export mints an import edge to the module it forwards to", () => {
  assert.deepEqual(importSpecs('export { RegExpRouter } from "./router"\n'), ["./router"]);
});

test("ts: a star re-export mints the same edge", () => {
  assert.deepEqual(importSpecs('export * from "./router"\n'), ["./router"]);
});

test("ts: a barrel of several re-exports mints one edge each", () => {
  const src = 'export { A } from "./a"\nexport { B, C } from "./b"\n';
  assert.deepEqual(importSpecs(src).sort(), ["./a", "./b"]);
});

test("ts: a plain export is not an import and its definitions survive the walk", () => {
  const src = 'export const x = 1\nexport function helper() { return x }\n';
  const out = extractFile("m.ts", src, "typescript");
  assert.deepEqual(
    out.rawEdges.filter((e) => e.relation === "imports"),
    [],
    "no source string, so no import edge",
  );
  assert.ok(
    out.nodes.some((n) => n.name === "helper"),
    "walk still descends into an export without a `from`, so the definition is indexed",
  );
});

// `class LinearRouter<T> implements Router<T>` puts a `generic_type` in the
// heritage clause, not a bare identifier. Accepting only the identifier left
// honojs/hono with 2 implements edges in the whole repo and none of its five
// routers connected to the interface they implement.
function heritage(src: string) {
  return extractFile("r.ts", src, "typescript")
    .rawEdges.filter((e) => e.relation === "implements" || e.relation === "extends")
    .map((e) => `${e.relation}:${e.name}`);
}

test("ts: a generic supertype keeps its edge, with the type arguments erased", () => {
  assert.deepEqual(heritage("export class LinearRouter<T> implements Router<T> {}\n"), ["implements:Router"]);
});

test("ts: a generic base class keeps its edge too", () => {
  assert.deepEqual(heritage("class A<T> extends Base<T, string> {}\n"), ["extends:Base"]);
});

test("ts: a plain supertype still works, and several are all captured", () => {
  assert.deepEqual(
    heritage("class A extends B implements C, D<E> {}\n").sort(),
    ["extends:B", "implements:C", "implements:D"],
  );
});
