/**
 * Tests for C# extraction in the Tier-1 code graph. Builds a small C# project in a
 * temp dir and asserts the emitted nodes (classes, structs, interfaces, records,
 * enums, delegates, methods, properties, local functions) and edges (calls,
 * heritage) match the AST walk in extract.ts.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildGraph } from "../src/graph/build.js";
import { readGraph, wiringPath } from "../src/graph/write.js";
import type { GraphV1, NodeV1 } from "../src/graph/types.js";

const WIDGET_CS = `using System;

namespace MyApp.Services
{
    public interface IFoo
    {
        void Bar();
    }

    public class Base
    {
        protected void Helper() {}
    }

    public class Widget : Base, IFoo
    {
        private readonly IFoo _foo;

        public Widget(IFoo foo)
        {
            _foo = foo;
        }

        public void Bar()
        {
            _foo.Bar();
            this.Helper();
            Local();
        }

        private void Local() {}

        void IFoo.Bar() {}
    }

    public struct Point
    {
        public int X;
    }

    public interface IReader
    {
        int Read();
    }

    public enum Color { Red, Green }

    public record PointR(int X, int Y);

    public record class Boxed(int X);

    public record struct Vec(int X, int Y);

    public delegate void Handler(object sender);

    public class Holder
    {
        public int Count { get; set; }

        public string Label => "label";

        public int Compute()
        {
            int Inner(int a) => a + 1;
            return Inner(Count);
        }
    }
}
`;

function makeFixture(): string {
  const dir = mkdtempSync(join(tmpdir(), "graft-csharp-"));
  writeFileSync(join(dir, "Widget.cs"), WIDGET_CS);
  return dir;
}

function nodeById(graph: GraphV1, id: string): NodeV1 | undefined {
  return graph.nodes.find((n) => n.id === id);
}

test("C# extraction: classes, structs, interfaces, records, enums, delegates", async () => {
  const dir = makeFixture();
  try {
    const result = await buildGraph(dir); // $0, Tier-1 only
    assert.ok(result.languages.includes("csharp"), "languages should include csharp");

    const graph = readGraph(wiringPath(join(dir, "graft")));
    assert.ok(graph, "wiring graph should be written");

    assert.equal(nodeById(graph!, "Widget.cs#IFoo")?.kind, "interface");
    assert.equal(nodeById(graph!, "Widget.cs#Base")?.kind, "class");
    assert.equal(nodeById(graph!, "Widget.cs#Widget")?.kind, "class");
    assert.equal(nodeById(graph!, "Widget.cs#Point")?.kind, "struct");
    assert.equal(nodeById(graph!, "Widget.cs#IReader")?.kind, "interface");
    assert.equal(nodeById(graph!, "Widget.cs#Color")?.kind, "enum");
    // `record` / `record class` are reference types; only `record struct` is a value
    // type — all three parse as the same node, distinguished by an anonymous token.
    assert.equal(nodeById(graph!, "Widget.cs#PointR")?.kind, "class");
    assert.equal(nodeById(graph!, "Widget.cs#Boxed")?.kind, "class");
    assert.equal(nodeById(graph!, "Widget.cs#Vec")?.kind, "struct");
    assert.equal(nodeById(graph!, "Widget.cs#Handler")?.kind, "type");

    // methods — exported by explicit `public` modifier
    const ctor = nodeById(graph!, "Widget.cs#Widget.Widget");
    assert.equal(ctor?.kind, "method");
    assert.equal(ctor?.exported, true);
    const bar = nodeById(graph!, "Widget.cs#Widget.Bar");
    assert.equal(bar?.kind, "method");
    assert.equal(bar?.exported, true);
    const local = nodeById(graph!, "Widget.cs#Widget.Local");
    assert.equal(local?.exported, false);

    // explicit interface implementation gets a distinct, interface-qualified id
    // from the public `Bar()` of the same name in the same class
    const explicitBar = nodeById(graph!, "Widget.cs#Widget.IFoo.Bar");
    assert.equal(explicitBar?.kind, "method");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("C# extraction: heritage and call edges", async () => {
  const dir = makeFixture();
  try {
    await buildGraph(dir);
    const graph = readGraph(wiringPath(join(dir, "graft")))!;

    // class heritage: base_list doesn't syntactically distinguish a base class from
    // an interface, so the relation comes from the resolved target's own kind.
    const extendsBase = graph.edges.find(
      (e) => e.relation === "extends" && e.source === "Widget.cs#Widget" && e.target === "Widget.cs#Base",
    );
    assert.ok(extendsBase, "Widget should extend Base");
    const implementsIFoo = graph.edges.find(
      (e) => e.relation === "implements" && e.source === "Widget.cs#Widget" && e.target === "Widget.cs#IFoo",
    );
    assert.ok(implementsIFoo, "Widget should implement IFoo (target resolves to an interface)");
    assert.ok(
      !graph.edges.some(
        (e) => e.relation === "extends" && e.source === "Widget.cs#Widget" && e.target === "Widget.cs#IFoo",
      ),
      "the interface base should not also remain an extends edge",
    );

    // bare-identifier field receiver: `_foo.Bar()` resolves via the field's bound type
    const fieldCall = graph.edges.find(
      (e) => e.relation === "calls" && e.source === "Widget.cs#Widget.Bar" && e.target === "Widget.cs#IFoo.Bar",
    );
    assert.ok(fieldCall, "_foo.Bar() should resolve to IFoo.Bar via the field's bound type");

    // `this.Helper()` resolves to the base class's method through the extends chain
    const thisCall = graph.edges.find(
      (e) => e.relation === "calls" && e.source === "Widget.cs#Widget.Bar" && e.target === "Widget.cs#Base.Helper",
    );
    assert.ok(thisCall, "this.Helper() should resolve to Base.Helper");

    // bare same-file call
    const bareCall = graph.edges.find(
      (e) => e.relation === "calls" && e.source === "Widget.cs#Widget.Bar" && e.target === "Widget.cs#Widget.Local",
    );
    assert.ok(bareCall, "Local() should resolve to Widget.Local");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("C# extraction: unresolved external base stays an extends edge", async () => {
  const dir = mkdtempSync(join(tmpdir(), "graft-csharp-external-"));
  try {
    writeFileSync(
      join(dir, "External.cs"),
      `namespace MyApp
{
    public class Derived : ControllerBase, IDisposable
    {
        public void Dispose() {}
    }
}
`,
    );
    await buildGraph(dir);
    const graph = readGraph(wiringPath(join(dir, "graft")))!;

    // neither base resolves in-repo, so both keep the extraction-time "extends"
    // and carry the bare name as the target.
    for (const base of ["ControllerBase", "IDisposable"]) {
      const edge = graph.edges.find((e) => e.source === "External.cs#Derived" && e.target === base);
      assert.equal(edge?.relation, "extends", `${base} should stay an extends edge when unresolved`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("C# extraction: properties and local functions", async () => {
  const dir = makeFixture();
  try {
    await buildGraph(dir);
    const graph = readGraph(wiringPath(join(dir, "graft")))!;

    // auto-property: the header stops at the accessor list, not the class brace
    const count = nodeById(graph, "Widget.cs#Holder.Count");
    assert.equal(count?.kind, "property");
    assert.equal(count?.name, "Count");
    assert.equal(count?.exported, true);
    assert.equal(count?.signature, "public int Count");
    assert.equal(count?.span, "L58-L58");

    // expression-bodied property: the header stops at the `=>`
    const label = nodeById(graph, "Widget.cs#Holder.Label");
    assert.equal(label?.kind, "property");
    assert.equal(label?.signature, "public string Label");

    // a local function nests under its enclosing method and reuses kind "function"
    const inner = nodeById(graph, "Widget.cs#Holder.Compute.Inner");
    assert.equal(inner?.kind, "function");
    assert.equal(inner?.name, "Inner");
    assert.equal(inner?.exported, false); // no `public` modifier is legal on one
    assert.equal(inner?.span, "L64-L64");

    // containment follows the nesting
    assert.ok(
      graph.edges.some(
        (e) =>
          e.relation === "contains" &&
          e.source === "Widget.cs#Holder.Compute" &&
          e.target === "Widget.cs#Holder.Compute.Inner",
      ),
      "Compute should contain its local function",
    );
    // `Inner(Count)` does NOT produce a call edge: C# bare calls route through the
    // member-call path (calleeName in extract.ts), which only matches kind "method".
    // Resolving them would need block-scoped lookup — see the note there.
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
