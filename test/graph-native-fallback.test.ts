/**
 * A native grammar that won't load costs its own language, never the command.
 *
 * The bug: npm 12 stops running dependency install scripts by default, and
 * `tree-sitter-kotlin` ships no prebuilt binary, so after `npm install -g` its addon
 * is simply absent. extract.ts imported every grammar statically, so the require
 * threw while the module graph loaded and `graft build`, the MCP server and the
 * hooks all crashed, in a repo with no Kotlin in it at all.
 *
 * Simulated here through native.ts's require seam, the way node-gyp-build fails:
 * the require throws "No native build was found".
 */
import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildGraph } from "../src/graph/build.js";
import { checkGraph } from "../src/graph/check.js";
import {
  missingNativePackages,
  nativeFallbackNotice,
  nativeReady,
  realNativeRequire,
  setNativeRequireForTest,
} from "../src/graph/native.js";
import { tmpRepo } from "./helpers.js";

const KOTLIN = [
  "package demo",
  "",
  "class Greeter(val name: String) {",
  '    fun greet(): String = "hi " + name',
  "}",
  "",
  "fun helper(x: Int): Int = x + 1",
  "",
  "fun main() {",
  '    val g = Greeter("a")',
  "    println(g.greet())",
  "    helper(2)",
  "}",
  "",
].join("\n");

const PY = ["class Store:", "    def load(self):", "        return fetch()", "", "def fetch():", "    return 1", ""].join("\n");

const TS = ["export function add(a: number, b: number): number {", "  return a + b;", "}", "export function twice(a: number): number {", "  return add(a, a);", "}", ""].join("\n");

function repo(): string {
  const d = tmpRepo("native-fallback");
  mkdirSync(join(d, "src"), { recursive: true });
  writeFileSync(join(d, "src", "math.ts"), TS);
  writeFileSync(join(d, "src", "store.py"), PY);
  writeFileSync(join(d, "src", "Main.kt"), KOTLIN);
  return d;
}

/** A require that fails for `missing`, exactly as node-gyp-build does, and records
 * every module asked for. */
function failing(missing: string[], asked: string[] = []): (id: string) => unknown {
  return (id) => {
    asked.push(id);
    if (missing.includes(id)) {
      throw new Error(`No native build was found for platform=${process.platform} arch=${process.arch} loaded from node_modules/${id}`);
    }
    return realNativeRequire(id);
  };
}

afterEach(() => setNativeRequireForTest(null));

test("all grammars load: native parse everywhere, and no notice", async () => {
  setNativeRequireForTest(null);
  const r = await buildGraph(repo());
  assert.deepEqual(r.errors, []);
  assert.equal(r.nativeFallback, undefined);
  assert.equal(nativeFallbackNotice(r.nativeFallback, "@trailhq/trail"), null);
  assert.deepEqual(r.languages, ["kotlin", "python", "typescript"]);
  assert.ok(nativeReady("kotlin"));
});

test("a missing kotlin binary: kotlin goes to the WASM stand-in, the build completes, the rest stay native", async () => {
  setNativeRequireForTest(failing(["tree-sitter-kotlin"]));
  const dir = repo();
  const r = await buildGraph(dir);
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.languages, ["kotlin", "python", "typescript"]);
  assert.deepEqual(r.nativeFallback, { languages: ["kotlin"], packages: ["tree-sitter-kotlin"] });

  const { readGraph, wiringPath } = await import("../src/graph/write.js");
  const g = readGraph(wiringPath(r.contextDir))!;
  const kt = g.nodes.filter((n) => n.path === "src/Main.kt" && n.kind !== "file");
  const names = kt.map((n) => n.name).sort();
  for (const want of ["Greeter", "greet", "helper", "main"]) assert.ok(names.includes(want), `kotlin ${want} missing: ${names}`);
  assert.ok(kt.every((n) => n.origin === "generic"), "kotlin symbols come from the stand-in");
  // The vendored kotlin tags query carries calls, so `graft callers helper` works.
  assert.ok(
    g.edges.some((e) => e.relation === "calls" && e.source === "src/Main.kt#main" && e.target === "src/Main.kt#helper"),
    "main → helper call edge",
  );
  // Languages with a binary are untouched.
  for (const path of ["src/math.ts", "src/store.py"]) {
    const syms = g.nodes.filter((n) => n.path === path && n.kind !== "file");
    assert.ok(syms.length > 0 && syms.every((n) => n.origin === "ast"), `${path} stays on the native parser`);
  }

  // `graft check` dispatches the same way, so the fallback graph reads as in sync.
  const c = await checkGraph(dir);
  assert.deepEqual([c.added, c.removed, c.changed], [[], [], []]);
});

test("the notice names only the grammar that failed, with the install that fixes it", async () => {
  setNativeRequireForTest(failing(["tree-sitter-kotlin"]));
  const r = await buildGraph(repo());
  assert.equal(
    nativeFallbackNotice(r.nativeFallback, "@trailhq/trail"),
    "⚠ kotlin: basic parsing only, the native parser is missing. To fix: npm install -g --allow-scripts=tree-sitter-kotlin @trailhq/trail",
  );
  assert.match(nativeFallbackNotice(r.nativeFallback, "@nanonets/graft")!, / @nanonets\/graft$/);
});

test("a repo without kotlin never asks for its grammar", async () => {
  const asked: string[] = [];
  setNativeRequireForTest(failing(["tree-sitter-kotlin"], asked));
  const d = tmpRepo("native-lazy");
  writeFileSync(join(d, "math.ts"), TS);
  const r = await buildGraph(d);
  assert.deepEqual(r.errors, []);
  assert.equal(r.nativeFallback, undefined);
  assert.ok(!asked.includes("tree-sitter-kotlin"), `asked for: ${asked.join(", ")}`);
});

test("no tree-sitter core binding: every depth language falls back, nothing crashes", async () => {
  setNativeRequireForTest(failing(["tree-sitter"]));
  const dir = repo();
  const r = await buildGraph(dir);
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.nativeFallback, { languages: ["kotlin", "python", "typescript"], packages: ["tree-sitter"] });
  const { readGraph, wiringPath } = await import("../src/graph/write.js");
  const g = readGraph(wiringPath(r.contextDir))!;
  const names = new Set(g.nodes.filter((n) => n.kind !== "file").map((n) => n.name));
  // The bundle's own tags queries stand in for typescript and python.
  for (const want of ["add", "twice", "Store", "load", "fetch", "helper"]) assert.ok(names.has(want), `${want} missing`);
  assert.equal(
    nativeFallbackNotice(r.nativeFallback, "@trailhq/trail"),
    "⚠ kotlin, python, typescript: basic parsing only, the native parsers are missing. To fix: npm install -g --allow-scripts=tree-sitter @trailhq/trail",
  );
});

test("a stand-in parse is not replayed once the native grammar loads again", async () => {
  const dir = repo();
  setNativeRequireForTest(failing(["tree-sitter-kotlin"]));
  await buildGraph(dir);
  // The reinstall that the notice asks for: same bytes, the grammar now loads.
  setNativeRequireForTest(null);
  const r = await buildGraph(dir);
  assert.equal(r.nativeFallback, undefined);
  assert.equal(r.parsed, 1, "only the kotlin file is parsed again");
  const { readGraph, wiringPath } = await import("../src/graph/write.js");
  const g = readGraph(wiringPath(r.contextDir))!;
  const kt = g.nodes.filter((n) => n.path === "src/Main.kt" && n.kind !== "file");
  assert.ok(kt.length > 0 && kt.every((n) => n.origin === "ast"), "kotlin is back on the native parser");
});

test("the allow-scripts name is the real package, not the npm alias", () => {
  setNativeRequireForTest(failing(["tree-sitter-r"]));
  assert.equal(nativeReady("r"), false);
  assert.deepEqual(missingNativePackages(["r", "python"]), ["@davisvaughan/tree-sitter-r"]);
});

test("a .vue file's script falls back with its language, spans still on the .vue line", async () => {
  setNativeRequireForTest(failing(["tree-sitter-typescript"]));
  const d = tmpRepo("native-vue");
  writeFileSync(
    join(d, "Card.vue"),
    ["<template>", "  <p>hi</p>", "</template>", "", '<script lang="ts">', "export function shout(what: string) {", "  return what.toUpperCase();", "}", "</script>", ""].join("\n"),
  );
  const r = await buildGraph(d);
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.nativeFallback, { languages: ["typescript"], packages: ["tree-sitter-typescript"] });
  const { readGraph, wiringPath } = await import("../src/graph/write.js");
  const shout = readGraph(wiringPath(r.contextDir))!.nodes.find((n) => n.name === "shout");
  assert.ok(shout, "the script's function is still indexed");
  assert.equal(shout.span, "L6-L8");
});
