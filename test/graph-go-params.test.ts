/**
 * Go call receivers typed from the enclosing function's parameters in the Tier-1 code graph.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildGraph } from "../src/graph/build.js";
import { readGraph, wiringPath } from "../src/graph/write.js";

test("Go extraction: a call through a typed parameter resolves to the parameter type's method", async () => {
  const dir = mkdtempSync(join(tmpdir(), "graft-go-param-"));
  try {
    writeFileSync(join(dir, "go.mod"), "module example.com/app\n\ngo 1.22\n");
    writeFileSync(
      join(dir, "server.go"),
      "package main\n\ntype Server struct{}\n\nfunc (s *Server) Start() {}\nfunc (s Server) Stop()   {}\n\n" +
        "type Other struct{}\n\nfunc (o *Other) Start() {}\n",
    );
    writeFileSync(
      join(dir, "use.go"),
      "package main\n\n" +
        "func pointer(s *Server)             { s.Start() }\n" +
        "func value(n int, s Server)         { s.Stop() }\n" +
        "func grouped(a, b *Server)          { a.Start(); b.Stop() }\n" +
        "func (o *Other) method(s *Server)   { s.Start() }\n" +
        "func named() (s *Server, err error) { s.Start(); return }\n" +
        "func closure()                      { f := func(s *Server) { s.Start() }; f(nil) }\n" +
        "func untyped(s []Server)            { s.Start() }\n",
    );

    await buildGraph(dir);
    const graph = readGraph(wiringPath(join(dir, "graft")))!;

    const calls = (source: string) =>
      graph.edges.filter((e) => e.relation === "calls" && e.source === source).map((e) => e.target).sort();
    assert.deepEqual(calls("use.go#pointer"), ["server.go#Server.Start"]);
    assert.deepEqual(calls("use.go#value"), ["server.go#Server.Stop"]);
    assert.deepEqual(calls("use.go#grouped"), ["server.go#Server.Start", "server.go#Server.Stop"]);
    assert.deepEqual(calls("use.go#Other.method"), ["server.go#Server.Start"]);
    assert.deepEqual(calls("use.go#named"), ["server.go#Server.Start"]);
    assert.deepEqual(calls("use.go#untyped"), []);
    // a func literal shares its enclosing definition's scope, so its parameters stay unbound
    assert.deepEqual(calls("use.go#closure"), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Go extraction: a func literal parameter, an untyped local or a range variable hides the typed parameter of that name", async () => {
  const dir = mkdtempSync(join(tmpdir(), "graft-go-param-shadow-"));
  try {
    writeFileSync(join(dir, "go.mod"), "module example.com/app\n\ngo 1.22\n");
    writeFileSync(
      join(dir, "server.go"),
      "package main\n\ntype Server struct{}\n\nfunc (s *Server) Start() {}\n\n" +
        "type Other struct{}\n\nfunc (o *Other) Start() {}\n\nfunc make2() *Other { return nil }\n",
    );
    writeFileSync(
      join(dir, "use.go"),
      "package main\n\n" +
        "func literal(s *Server)  { run(func(s *Other) { s.Start() }) }\n" +
        "func local(s *Server)    { if true { s := make2(); s.Start() } }\n" +
        "func ranged(s *Server, xs []*Other) { for _, s := range xs { s.Start() } }\n" +
        "func multi(s *Server)    { if true { s, err := two(); _ = err; s.Start() } }\n" +
        "func plain(s *Server)    { s.Start() }\n" +
        "func run(f func(*Other)) {}\n" +
        "func two() (*Other, error) { return nil, nil }\n",
    );

    await buildGraph(dir);
    const graph = readGraph(wiringPath(join(dir, "graft")))!;

    const calls = (source: string) =>
      graph.edges.filter((e) => e.relation === "calls" && e.source === source && e.target.includes("Start")).map((e) => e.target);
    assert.deepEqual(calls("use.go#literal"), []);
    assert.deepEqual(calls("use.go#local"), []);
    assert.deepEqual(calls("use.go#ranged"), []);
    assert.deepEqual(calls("use.go#multi"), []);
    assert.deepEqual(calls("use.go#plain"), ["server.go#Server.Start"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
