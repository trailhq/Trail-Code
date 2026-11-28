import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { Query } from "web-tree-sitter";
import { genericLangOf, genericExtensions, warmGenericGrammars, isWarm, loadWasmLanguage,
  parseWasm, extractGeneric, swapGrammarForTest } from "../src/graph/generic.js";
import { supportedExtensions, unsupportedExtensions } from "../src/graph/source-files.js";
import { resolveEdges } from "../src/graph/resolve.js";
import { buildGraph } from "../src/graph/build.js";
import { checkGraph } from "../src/graph/check.js";
import { readGraph, wiringPath } from "../src/graph/write.js";
import { contextDirFor } from "../src/context/node-file.js";

const SOURCE = `@tool
class_name Actor extends Base
@export var health: int = 10
func _init():
    helper()
func helper():
    pass
func run(value: External) -> External:
    helper()
    thing.work()
    super.work()
    .work()
    var callback = func(): helper()
    var instance = Inner.new()
    return value
class Inner extends Base:
    func _init():
        helper()
    func work():
        helper()
    class Nested:
        extends Base
        func nested():
            work()
class Base:
    pass
`;

async function extract(file = "actor.gd", source = SOURCE) {
  await warmGenericGrammars(["gdscript"]);
  const root = parseWasm(await loadWasmLanguage("gdscript"), source);
  assert.ok(root);
  assert.equal((root as typeof root & { hasError: boolean }).hasError, false, file);
  return extractGeneric(file, source, "gdscript");
}

test("GDScript registry and extension validation claim only .gd, case-insensitively", () => {
  for (const file of ["actor.gd", "ACTOR.GD"]) assert.equal(genericLangOf(file)?.name, "gdscript");
  assert.notEqual(genericLangOf("scene.tscn")?.name, "gdscript");
  assert.equal(genericLangOf("resource.res"), null);
  assert.ok(genericExtensions().includes(".gd"));
  assert.ok(supportedExtensions().includes(".gd"));
  assert.deepEqual(unsupportedExtensions(["gd", ".GD", ".res"]), [".res"]);
});

test("bundled GDScript WASM loads and Trail Code query compiles without walker fallback", async () => {
  const require = createRequire(import.meta.url);
  assert.ok(readFileSync(require.resolve("tree-sitter-wasm/gdscript/tree-sitter-gdscript.wasm")).length);
  const language = await loadWasmLanguage("gdscript");
  assert.ok(language);
  const query = new Query(language as ConstructorParameters<typeof Query>[0],
    readFileSync(new URL("../src/graph/queries/gdscript.scm", import.meta.url), "utf8"));
  query.delete();
  const root = parseWasm(language, SOURCE);
  assert.ok(root);
  assert.equal(root.type, "source");
  assert.equal((root as typeof root & { hasError: boolean }).hasError, false);
  await warmGenericGrammars(["gdscript"]);
  assert.ok(isWarm("gdscript"));
  const entry = swapGrammarForTest("gdscript", null);
  try { assert.ok(entry?.query, "warmup must retain compiled query, not silently use walker"); }
  finally { swapGrammarForTest("gdscript", entry); }
});

test("definitions have exact spans; constructors, annotations, lambdas and nested classes do not duplicate symbols", async () => {
  const { nodes, rawEdges } = await extract();
  assert.deepEqual(nodes.filter(n => n.kind !== "file").map(n => [n.name, n.kind, n.span]), [
    ["Actor", "class", "L2-L2"], ["health", "variable", "L3-L3"], ["_init", "function", "L4-L5"],
    ["helper", "function", "L6-L7"], ["run", "function", "L8-L15"],
    ["Inner", "class", "L16-L24"], ["_init", "method", "L17-L18"],
    ["work", "method", "L19-L20"], ["Nested", "class", "L21-L24"],
    ["nested", "method", "L23-L24"], ["Base", "class", "L25-L26"],
  ]);
  assert.equal(new Set(nodes.map(n => n.id)).size, nodes.length);
  assert.ok(nodes.every(n => n.origin === "generic"));
  assert.equal(nodes.find(n => n.name === "run")?.signature, "func run(value: External) -> External:");
  assert.deepEqual(rawEdges.filter(e => e.relation === "calls").map(e => [e.source, e.name]), [
    ["actor.gd#_init", "helper"], ["actor.gd#run", "helper"],
    ["actor.gd#run", "work"], ["actor.gd#run", "work"], ["actor.gd#run", "work"],
    ["actor.gd#run", "helper"], ["actor.gd#run", "new"],
    ["actor.gd#_init~2", "helper"], ["actor.gd#work", "helper"], ["actor.gd#nested", "work"],
  ]);
  assert.ok(!rawEdges.some(e => e.name === "External"), "type annotations are not structural references");
});

test("calls retain same-file and unique-global name resolution; ambiguous targets drop", async () => {
  const parts = await Promise.all([
    extract(), extract("other.gd", "func helper(): pass\nfunc elsewhere(): pass\nfunc ambiguous(): pass\n"),
    extract("third.gd", "func ambiguous(): pass\n"),
    extract("caller.GD", "func invoke():\n    elsewhere()\n    obj.ambiguous()\n    missing()\n"),
  ]);
  const edges = resolveEdges(parts.flatMap(p => p.nodes), parts.flatMap(p => p.rawEdges));
  assert.ok(edges.some(e => e.source === "actor.gd#run" && e.target === "actor.gd#helper" && e.confidence === "extracted"));
  assert.ok(edges.some(e => e.source === "actor.gd#run" && e.target === "actor.gd#work" && e.confidence === "extracted"),
    "member receivers are ignored by existing name resolution");
  assert.deepEqual(edges.filter(e => e.source === "caller.GD#invoke").map(e => [e.target, e.confidence]), [["other.gd#elsewhere", "inferred"]]);
  const duplicate = await extract("duplicate.gd", "class First:\n    func work(): pass\nclass Second:\n    func work(): pass\nfunc invoke():\n    First.new().work()\n");
  assert.deepEqual(duplicate.nodes.filter(n => n.name === "work").map(n => n.id),
    ["duplicate.gd#work", "duplicate.gd#work~2"]);
  assert.deepEqual(resolveEdges(duplicate.nodes, duplicate.rawEdges), [], "nested ownership does not disambiguate same-file methods");
});

test("inheritance references require an enclosing definition and a resolvable simple name", async () => {
  const main = await extract();
  assert.deepEqual(main.rawEdges.filter(e => e.relation === "references").map(e => [e.source, e.name]), [
    ["actor.gd#Actor", "Base"], ["actor.gd#Inner", "Base"], ["actor.gd#Nested", "Base"],
  ]);
  const separate = await extract("separate.gd", "class_name Separate\nextends Base\n");
  assert.deepEqual(separate.rawEdges, [], "separate top-level extends has no enclosing symbol");
  const external = await extract("external.gd", "class_name Child extends Node\n");
  assert.equal(external.rawEdges[0]?.name, "Node");
  assert.deepEqual(resolveEdges(external.nodes, external.rawEdges), []);
  const qualified = await extract("qualified.gd", 'class_name Qualified extends Outer.Inner\n');
  const path = await extract("path.gd", 'extends "res://base.gd"\n');
  assert.deepEqual(qualified.rawEdges, []);
  assert.deepEqual(path.rawEdges, []);
  const edges = resolveEdges(main.nodes, main.rawEdges).filter(e => e.relation === "references");
  assert.equal(edges.length, 3);
  assert.ok(edges.every(e => e.target === "actor.gd#Base" && e.confidence === "extracted"));
  const child = await extract("child.gd", "class_name Child extends Base\n");
  const inherited = resolveEdges([...main.nodes, ...child.nodes], child.rawEdges);
  assert.deepEqual(inherited.map(e => [e.target, e.confidence]), [["actor.gd#Base", "inferred"]]);
  const otherBase = await extract("base.gd", "class_name Base\n");
  assert.deepEqual(resolveEdges([...main.nodes, ...child.nodes, ...otherBase.nodes], child.rawEdges), []);
});

test("temporary GDScript project builds and checks clean with default source discovery", async () => {
  const dir = mkdtempSync(join(tmpdir(), "graft-gdscript-"));
  try {
    writeFileSync(join(dir, "actor.gd"), SOURCE);
    writeFileSync(join(dir, "UPPER.GD"), "func upper():\n    pass\n");
    writeFileSync(join(dir, "resource.res"), "RSRC");
    const result = await buildGraph(dir, { reuse: false });
    assert.deepEqual(result.errors, []);
    const graph = readGraph(wiringPath(contextDirFor(dir)));
    assert.ok(graph);
    assert.ok(graph.nodes.some(n => n.id === "actor.gd#run"));
    assert.ok(graph.nodes.some(n => n.id === "UPPER.GD#upper"));
    assert.ok(!graph.nodes.some(n => n.path.endsWith(".res")));
    assert.ok(graph.edges.some(e => e.relation === "calls"));
    assert.equal((await checkGraph(dir)).ok, true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("anonymous enum members are constants and named enums retain their symbol", async () => {
  const { nodes } = await extract("state.gd", `enum { IDLE, BUSY = 2 }
enum State { OFF, ON }
`);
  assert.deepEqual(nodes.filter(n => n.kind !== "file").map(n => [n.name, n.kind]), [
    ["IDLE", "constant"], ["BUSY", "constant"], ["State", "enum"],
  ]);
});

test("signals are symbols, not inferred emit/connect wiring", async () => {
  const result = await extract("signals.gd", `signal done
func run():
    done.emit()
    done.connect(callback)
    emit_signal("done")
func callback(): pass
`);
  assert.equal(result.nodes.find(n => n.name === "done")?.kind, "variable");
  assert.deepEqual(result.rawEdges.filter(e => e.relation === "calls").map(e => e.name),
    ["emit", "connect", "emit_signal"]);
  assert.deepEqual(resolveEdges(result.nodes, result.rawEdges), []);
});
