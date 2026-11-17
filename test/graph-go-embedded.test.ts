/**
 * Go methods promoted through embedded structs and interfaces in the Tier-1 code graph.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildGraph } from "../src/graph/build.js";
import { readGraph, wiringPath } from "../src/graph/write.js";

test("Go extraction: a method promoted through an embedded type resolves to the embedded type's method", async () => {
  const dir = mkdtempSync(join(tmpdir(), "graft-go-embed-"));
  try {
    mkdirSync(join(dir, "other"));
    writeFileSync(join(dir, "go.mod"), "module example.com/app\n\ngo 1.22\n");
    writeFileSync(
      join(dir, "base.go"),
      "package main\n\n" +
        "type Base struct{}\n\nfunc (b *Base) Hello() {}\nfunc (b *Base) Own() {}\n\n" +
        "type Logger struct{}\n\nfunc (l *Logger) Log() {}\n\n" +
        "type Reader interface{ Read() }\n\ntype ReadCloser interface {\n\tReader\n\tClose()\n}\n\n" +
        "type Server struct {\n\tBase\n\t*Logger\n\tReader\n\tname string\n}\n\n" +
        "func (s *Server) Own() {}\n\n" +
        "func (s *Server) Start() { s.Hello(); s.Log(); s.Own(); s.Read() }\n\n" +
        "func run() { var rc ReadCloser; srv := Server{}; srv.Hello(); rc.Read() }\n",
    );
    writeFileSync(join(dir, "other", "other.go"), "package other\n\ntype Base struct{}\n\nfunc (b *Base) Hello() {}\n");
    writeFileSync(
      join(dir, "other", "wrap.go"),
      "package other\n\ntype Wrap struct {\n\tBase\n}\n\nfunc (w Wrap) Go() { w.Hello() }\n",
    );

    await buildGraph(dir);
    const graph = readGraph(wiringPath(join(dir, "graft")))!;

    const edges = (source: string, relation: string) =>
      graph.edges.filter((e) => e.relation === relation && e.source === source).map((e) => e.target).sort();
    assert.deepEqual(edges("base.go#Server", "extends"), ["base.go#Base", "base.go#Logger", "base.go#Reader"]);
    assert.deepEqual(edges("base.go#ReadCloser", "extends"), ["base.go#Reader"]);
    assert.deepEqual(edges("base.go#Server.Start", "calls"), [
      "base.go#Base.Hello",
      "base.go#Logger.Log",
      "base.go#Reader.Read",
      "base.go#Server.Own",
    ]);
    assert.deepEqual(edges("base.go#run", "calls"), ["base.go#Base.Hello", "base.go#Reader.Read"]);
    assert.deepEqual(edges("other/wrap.go#Wrap", "extends"), ["other/other.go#Base"]);
    // two packages own a `Base.Hello`: the owner index cannot tell them apart, so the call drops
    // rather than land on the other package's method
    assert.deepEqual(edges("other/wrap.go#Wrap.Go", "calls"), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Go extraction: an ambiguous promoted selector, a named field and a qualified embed do not resolve", async () => {
  const dir = mkdtempSync(join(tmpdir(), "graft-go-embed-ambiguous-"));
  try {
    writeFileSync(join(dir, "go.mod"), "module example.com/app\n\ngo 1.22\n");
    writeFileSync(
      join(dir, "embed.go"),
      'package main\n\nimport "sync"\n\n' +
        "type A struct{}\n\nfunc (A) Same() {}\nfunc (A) OnlyA() {}\n\n" +
        "type B struct{}\n\nfunc (B) Same() {}\n\n" +
        "type Deep struct{}\n\nfunc (Deep) OnlyA() {}\n\ntype C struct{ Deep }\n\n" +
        "type Both struct {\n\tA\n\tB\n}\n\n" +
        "type Shallow struct {\n\tA\n\tC\n}\n\n" +
        "type Named struct {\n\tfield A\n\tsync.Mutex\n}\n\n" +
        "func (b Both) ambiguous()    { b.Same() }\n" +
        "func (s Shallow) shallower() { s.OnlyA() }\n" +
        "func (n Named) named()       { n.Same(); n.Lock() }\n",
    );

    await buildGraph(dir);
    const graph = readGraph(wiringPath(join(dir, "graft")))!;

    const calls = (source: string) =>
      graph.edges.filter((e) => e.relation === "calls" && e.source === source).map((e) => e.target);
    assert.deepEqual(calls("embed.go#Both.ambiguous"), []);
    assert.deepEqual(calls("embed.go#Shallow.shallower"), ["embed.go#A.OnlyA"]);
    assert.deepEqual(calls("embed.go#Named.named"), []);
    assert.deepEqual(
      graph.edges.filter((e) => e.relation === "extends" && e.source === "embed.go#Named"),
      [],
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
