/**
 * Tests for Go extraction in the Tier-1 code graph. Builds a small Go module in a
 * temp dir and asserts the emitted nodes (funcs, methods, structs, interfaces, type
 * aliases) and edges (calls, intra-module imports) match the AST walk in extract.ts.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildGraph } from "../src/graph/build.js";
import { readGraph, wiringPath } from "../src/graph/write.js";
import { writeBuildConfig } from "../src/util/state.js";
import type { GraphV1, NodeV1 } from "../src/graph/types.js";

const MAIN_GO = `package main

import (
\t"fmt"
\t"mymod/pkg/util"
)

type ID int

type User struct {
\tName string
}

type Reader interface {
\tRead() error
}

func Foo() {
\tfmt.Println("hi")
\tutil.Helper()
}

func bar() {}

func (u *User) Save() error {
\tFoo()
\tu.name()
\treturn nil
}

func (u User) name() string { return u.Name }
`;

const UTIL_GO = `package util

func Helper() {}
`;

function makeFixture(): string {
  const dir = mkdtempSync(join(tmpdir(), "graft-go-"));
  writeFileSync(join(dir, "go.mod"), "module mymod\n\ngo 1.21\n");
  writeFileSync(join(dir, "main.go"), MAIN_GO);
  mkdirSync(join(dir, "pkg", "util"), { recursive: true });
  writeFileSync(join(dir, "pkg", "util", "util.go"), UTIL_GO);
  return dir;
}

function nodeById(graph: GraphV1, id: string): NodeV1 | undefined {
  return graph.nodes.find((n) => n.id === id);
}

test("Go extraction: funcs, methods, structs, interfaces, type aliases", async () => {
  const dir = makeFixture();
  try {
    const result = await buildGraph(dir); // $0, Tier-1 only
    assert.ok(result.languages.includes("go"), "languages should include go");

    const graph = readGraph(wiringPath(join(dir, "graft")));
    assert.ok(graph, "wiring graph should be written");

    // functions — exported by leading-uppercase
    const foo = nodeById(graph!, "main.go#Foo");
    assert.equal(foo?.kind, "function");
    assert.equal(foo?.exported, true);
    assert.equal(nodeById(graph!, "main.go#bar")?.exported, false);

    // methods — receiver-qualified name, file-scope, exported by method name
    const save = nodeById(graph!, "main.go#User.Save");
    assert.equal(save?.kind, "method");
    assert.equal(save?.exported, true);
    const name = nodeById(graph!, "main.go#User.name");
    assert.equal(name?.kind, "method");
    assert.equal(name?.exported, false);

    // named types
    assert.equal(nodeById(graph!, "main.go#User")?.kind, "struct");
    assert.equal(nodeById(graph!, "main.go#Reader")?.kind, "interface");
    assert.equal(nodeById(graph!, "main.go#ID")?.kind, "type");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Go extraction: call and import edges", async () => {
  const dir = makeFixture();
  try {
    await buildGraph(dir);
    const graph = readGraph(wiringPath(join(dir, "graft")))!;

    // same-file plain call resolves: Save() → Foo()
    const call = graph.edges.find(
      (e) => e.relation === "calls" && e.source === "main.go#User.Save" && e.target === "main.go#Foo",
    );
    assert.ok(call, "Save should have a resolved calls edge to Foo");

    // member call `u.name()` resolves to the receiver method by its bare name
    const memberCall = graph.edges.find(
      (e) =>
        e.relation === "calls" && e.source === "main.go#User.Save" && e.target === "main.go#User.name",
    );
    assert.ok(memberCall, "Save should have a resolved calls edge to User.name");

    // intra-module import resolves to the target package's file node
    const internal = graph.edges.find(
      (e) => e.relation === "imports" && e.source === "main.go" && e.target === "pkg/util/util.go",
    );
    assert.ok(internal, "mymod/pkg/util should resolve to pkg/util/util.go");

    // stdlib import stays an unresolved package string
    const external = graph.edges.find(
      (e) => e.relation === "imports" && e.source === "main.go" && e.target === "fmt",
    );
    assert.ok(external, "fmt should remain an external package string");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Go extraction: go.mod in a subdirectory resolves intra-module imports", async () => {
  // Monorepo shape: the module lives under backend/, not the repo root.
  const dir = mkdtempSync(join(tmpdir(), "graft-go-sub-"));
  try {
    mkdirSync(join(dir, "backend", "store"), { recursive: true });
    writeFileSync(join(dir, "backend", "go.mod"), "module example.com/app\n\ngo 1.21\n");
    writeFileSync(
      join(dir, "backend", "main.go"),
      `package main\n\nimport (\n\t"fmt"\n\t"example.com/app/store"\n)\n\nfunc main() {\n\tfmt.Println(store.New())\n}\n`,
    );
    writeFileSync(join(dir, "backend", "store", "store.go"), "package store\n\nfunc New() int { return 0 }\n");

    await buildGraph(dir);
    const graph = readGraph(wiringPath(join(dir, "graft")))!;

    // `example.com/app/store` → backend/store (module dir `backend` + subpath `store`)
    const internal = graph.edges.find(
      (e) =>
        e.relation === "imports" &&
        e.source === "backend/main.go" &&
        e.target === "backend/store/store.go",
    );
    assert.ok(internal, "subdir-module import should resolve to backend/store/store.go");

    // stdlib still stays external
    assert.ok(
      graph.edges.some(
        (e) => e.relation === "imports" && e.source === "backend/main.go" && e.target === "fmt",
      ),
      "fmt should remain an external package string",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("A5: a go.mod under a persisted --include-dir override is found, so imports inside it resolve internally", async () => {
  // build/ is in SKIP_DIRS by default — readGoModules must honor the same
  // persisted include-dir override source-files.ts already reads, or a
  // go.mod living under an included dir is missed while its .go files (which
  // DO go through source-files.ts) are indexed just fine.
  const dir = mkdtempSync(join(tmpdir(), "graft-go-include-dir-"));
  try {
    mkdirSync(join(dir, "build", "store"), { recursive: true });
    writeFileSync(join(dir, "build", "go.mod"), "module example.com/app\n\ngo 1.21\n");
    writeFileSync(
      join(dir, "build", "main.go"),
      `package main\n\nimport (\n\t"fmt"\n\t"example.com/app/store"\n)\n\nfunc main() {\n\tfmt.Println(store.New())\n}\n`,
    );
    writeFileSync(join(dir, "build", "store", "store.go"), "package store\n\nfunc New() int { return 0 }\n");
    writeBuildConfig(dir, { includeDirs: ["build"] });

    await buildGraph(dir);
    const graph = readGraph(wiringPath(join(dir, "graft")))!;

    // Sanity: the .go files under build/ are indexed at all (source-files.ts
    // already reads the persisted include list correctly).
    assert.ok(graph.nodes.some((n) => n.id === "build/main.go#main"), "build/main.go should be indexed");

    const internal = graph.edges.find(
      (e) => e.relation === "imports" && e.source === "build/main.go" && e.target === "build/store/store.go",
    );
    assert.ok(internal, "example.com/app/store should resolve internally once build/go.mod is found");

    const external = graph.edges.find(
      (e) => e.relation === "imports" && e.source === "build/main.go" && e.target === "example.com/app/store",
    );
    assert.ok(!external, "must not be left as an unresolved external package string once the module is found");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Go extraction: a call through an interface-typed struct field resolves to the interface method (#618)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "graft-go-iface-"));
  try {
    writeFileSync(join(dir, "go.mod"), "module example.test/interface-repro\n\ngo 1.23\n");
    writeFileSync(
      join(dir, "client.go"),
      "package example\n\ntype Client struct{}\nfunc (*Client) Containers() []int { return nil }\nfunc (*Client) ImageContainers(string) []int { return nil }\n",
    );
    writeFileSync(
      join(dir, "worker.go"),
      "package example\n\ntype API interface {\n\tContainers() []int\n\tImageContainers(string) []int\n}\ntype Worker struct { api API }\nfunc (w Worker) Inventory() []int { return w.api.Containers() }\nfunc (w Worker) Recheck(name string) []int { return w.api.ImageContainers(name) }\n",
    );
    writeFileSync(
      join(dir, "fake_test.go"),
      "package example\n\ntype Fake struct{}\nfunc (*Fake) Containers() []int { return nil }\nfunc (*Fake) ImageContainers(string) []int { return nil }\n",
    );

    await buildGraph(dir);
    const graph = readGraph(wiringPath(join(dir, "graft")))!;

    const spec = nodeById(graph, "worker.go#API.Containers");
    assert.equal(spec?.kind, "method");
    assert.equal(spec?.owner, "API");
    assert.equal(spec?.exported, true);

    const calls = (source: string) =>
      graph.edges.filter((e) => e.relation === "calls" && e.source === source).map((e) => e.target);
    assert.deepEqual(calls("worker.go#Worker.Inventory"), ["worker.go#API.Containers"]);
    assert.deepEqual(calls("worker.go#Worker.Recheck"), ["worker.go#API.ImageContainers"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Go extraction: an inline interface type mints no method nodes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "graft-go-inline-iface-"));
  try {
    writeFileSync(join(dir, "go.mod"), "module mymod\n\ngo 1.21\n");
    writeFileSync(
      join(dir, "main.go"),
      "package main\n\ntype Holder struct { r interface{ Read() error } }\n\nfunc Use(r interface{ Close() error }) {}\n",
    );

    await buildGraph(dir);
    const graph = readGraph(wiringPath(join(dir, "graft")))!;

    assert.deepEqual(
      graph.nodes.filter((n) => n.kind === "method").map((n) => n.id),
      [],
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
