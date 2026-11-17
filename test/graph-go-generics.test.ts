/**
 * Go methods on generic types in the Tier-1 code graph.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildGraph } from "../src/graph/build.js";
import { readGraph, wiringPath } from "../src/graph/write.js";
import type { GraphV1, NodeV1 } from "../src/graph/types.js";

function nodeById(graph: GraphV1, id: string): NodeV1 | undefined {
  return graph.nodes.find((n) => n.id === id);
}

test("Go extraction: methods on a generic type keep their receiver and resolve through typed locals", async () => {
  const dir = mkdtempSync(join(tmpdir(), "graft-go-generic-recv-"));
  try {
    writeFileSync(join(dir, "go.mod"), "module example.com/app\n\ngo 1.22\n");
    writeFileSync(
      join(dir, "coll.go"),
      "package main\n\n" +
        "type Stack[T any] struct{ items []T }\n\n" +
        "func (s *Stack[T]) Push(x T) { s.grow() }\nfunc (s *Stack[T]) grow()    {}\n\n" +
        "type Queue[K comparable, V any] struct{ m map[K]V }\n\n" +
        "func (q Queue[K, V]) Push(k K, v V) { q.grow() }\nfunc (q Queue[K, V]) grow()          {}\n\n" +
        "func NewStack[T any]() *Stack[T] { return &Stack[T]{} }\n\n" +
        "func declared() { var s Stack[int]; s.Push(1) }\n" +
        "func literal() { q := &Queue[string, int]{}; q.Push(\"a\", 1) }\n" +
        "func ctor() { s := NewStack[int](); s.Push(1) }\n",
    );

    await buildGraph(dir);
    const graph = readGraph(wiringPath(join(dir, "graft")))!;

    for (const id of ["Stack.Push", "Stack.grow", "Queue.Push", "Queue.grow"]) {
      const node = nodeById(graph, `coll.go#${id}`);
      assert.equal(node?.kind, "method", id);
      assert.equal(node?.owner, id.split(".")[0], id);
    }
    assert.equal(nodeById(graph, "coll.go#Push"), undefined, "no owner-less Push node");

    const calls = (source: string) =>
      graph.edges.filter((e) => e.relation === "calls" && e.source === source).map((e) => e.target);
    assert.deepEqual(calls("coll.go#Stack.Push"), ["coll.go#Stack.grow"]);
    assert.deepEqual(calls("coll.go#Queue.Push"), ["coll.go#Queue.grow"]);
    const pushes = (source: string) => calls(source).filter((t) => t.endsWith(".Push"));
    assert.deepEqual(pushes("coll.go#declared"), ["coll.go#Stack.Push"], "var s Stack[int]");
    assert.deepEqual(pushes("coll.go#literal"), ["coll.go#Queue.Push"], "&Queue[string, int]{}");
    assert.deepEqual(pushes("coll.go#ctor"), ["coll.go#Stack.Push"], "NewStack[int]()");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
