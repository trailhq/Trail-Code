/**
 * Tests for PHP extraction in the Tier-1 code graph. Builds a small PHP project in
 * a temp dir and asserts the emitted nodes (classes, methods, interface, trait,
 * enum, top-level function) and edges (calls, extends, implements) match the AST
 * walk in extract.ts.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildGraph } from "../src/graph/build.js";
import { checkGraph } from "../src/graph/check.js";
import { extractFile } from "../src/graph/extract.js";
import { readGraph, wiringPath } from "../src/graph/write.js";
import type { GraphV1, NodeV1 } from "../src/graph/types.js";

const APP_PHP = `<?php
namespace App;

use App\\Support\\Base;

class Widget extends Base implements Runnable
{
    use Loggable;

    public function run(): int
    {
        $this->log();
        return $this->helper();
    }

    private function helper(): int
    {
        return Base::seed();
    }

    public function act(Base $b): string
    {
        return $b->label();
    }
}

interface Runnable {}

trait Loggable
{
    protected function log(): void {}
}

enum Color: string
{
    case Red = 'r';
}

function topLevel(): int
{
    return 1;
}

$make = fn(): int => topLevel();

register(function (): void {
    topLevel();
});
`;

const BASE_PHP = `<?php
namespace App\\Support;

class Base
{
    public static function seed(): int
    {
        return 0;
    }

    public function label(): string
    {
        return 'b';
    }
}
`;

function makeFixture(): string {
  const dir = mkdtempSync(join(tmpdir(), "graft-php-"));
  writeFileSync(join(dir, "composer.json"), `{"name": "acme/app"}\n`);
  writeFileSync(join(dir, "app.php"), APP_PHP);
  writeFileSync(join(dir, "base.php"), BASE_PHP);
  return dir;
}

function nodeById(graph: GraphV1, id: string): NodeV1 | undefined {
  return graph.nodes.find((n) => n.id === id);
}

test("PHP extraction: classes, methods, interface, trait, enum, function", async () => {
  const dir = makeFixture();
  try {
    const result = await buildGraph(dir); // $0, Tier-1 only
    assert.ok(result.languages.includes("php"), "languages should include php");

    const graph = readGraph(wiringPath(join(dir, "graft")));
    assert.ok(graph, "wiring graph should be written");

    assert.equal(nodeById(graph!, "app.php#Widget")?.kind, "class");
    assert.equal(nodeById(graph!, "base.php#Base")?.kind, "class");

    // methods — file-scoped under their class; visibility drives `exported`
    const run = nodeById(graph!, "app.php#Widget.run");
    assert.equal(run?.kind, "method");
    assert.equal(run?.exported, true, "public method is exported");
    assert.equal(nodeById(graph!, "app.php#Widget.helper")?.exported, false, "private method is not exported");

    // language-specific kinds
    assert.equal(nodeById(graph!, "app.php#Runnable")?.kind, "interface");
    assert.equal(nodeById(graph!, "app.php#Loggable")?.kind, "trait");
    assert.equal(nodeById(graph!, "app.php#Color")?.kind, "enum");
    assert.equal(nodeById(graph!, "app.php#topLevel")?.kind, "function");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("PHP extraction: call, extends, and implements edges", async () => {
  const dir = makeFixture();
  try {
    await buildGraph(dir);
    const graph = readGraph(wiringPath(join(dir, "graft")))!;

    // `class Widget extends Base` resolves cross-file by class name
    assert.ok(
      graph.edges.some(
        (e) => e.relation === "extends" && e.source === "app.php#Widget" && e.target === "base.php#Base",
      ),
      "Widget should have a resolved extends edge to Base",
    );

    // `implements Runnable` resolves to the same-file interface
    assert.ok(
      graph.edges.some(
        (e) => e.relation === "implements" && e.source === "app.php#Widget" && e.target === "app.php#Runnable",
      ),
      "Widget should have a resolved implements edge to Runnable",
    );

    // `$this->log()` resolves to the used trait's method (trait-use → implements edge)
    assert.ok(
      graph.edges.some(
        (e) => e.relation === "calls" && e.source === "app.php#Widget.run" && e.target === "app.php#Loggable.log",
      ),
      "run should have a resolved calls edge to Loggable.log via trait use",
    );

    // `$this->helper()` resolves to the receiver method (self → enclosing class)
    assert.ok(
      graph.edges.some(
        (e) => e.relation === "calls" && e.source === "app.php#Widget.run" && e.target === "app.php#Widget.helper",
      ),
      "run should have a resolved calls edge to helper",
    );

    // `Base::seed()` static call resolves to the target class method by name
    assert.ok(
      graph.edges.some(
        (e) => e.relation === "calls" && e.source === "app.php#Widget.helper" && e.target === "base.php#Base.seed",
      ),
      "helper should have a resolved calls edge to Base.seed",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("PHP extraction: trait use and typed-parameter receiver binding", async () => {
  const dir = makeFixture();
  try {
    await buildGraph(dir);
    const graph = readGraph(wiringPath(join(dir, "graft")))!;

    // `use Loggable;` inside the class body resolves to the trait (modelled as implements)
    assert.ok(
      graph.edges.some(
        (e) => e.relation === "implements" && e.source === "app.php#Widget" && e.target === "app.php#Loggable",
      ),
      "Widget should have a resolved trait-use (implements) edge to Loggable",
    );

    // `act(Base $b)` -> `$b->label()` resolves via the typed-parameter binding
    // ($b : Base), not by bare method name — Base.label is the only match anyway,
    // but the binding is what makes this correct when several classes share a name.
    assert.ok(
      graph.edges.some(
        (e) => e.relation === "calls" && e.source === "app.php#Widget.act" && e.target === "base.php#Base.label",
      ),
      "act should resolve $b->label() to Base.label through the parameter binding",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// A variable-assigned closure is named after its variable, so its node id is
// `…#<var>`. If that name is recomputed as the anonymous `{closure}` on a later
// pass, the stored id and the recomputed id disagree — the exact drift that made
// `graft check` report STALE on closure-heavy PHP right after a clean build
// (reported against this branch on a ~2k-file Laravel repo). These closures are
// shaped like that report: a top-level `static function … use (…)` and a
// variable-assigned closure nested inside a method.
const CLOSURES_PHP = `<?php
declare(strict_types=1);

$itemGroupCallback = static function ($itemGroup) use ($response) {
    return $itemGroup->id;
};

class Service
{
    public function getItemList(): array
    {
        $mapper = function ($row) {
            return $row->value;
        };
        return array_map($mapper, []);
    }
}
`;

function makeClosureFixture(): string {
  const dir = mkdtempSync(join(tmpdir(), "graft-php-closures-"));
  writeFileSync(join(dir, "composer.json"), `{"name": "acme/closures"}\n`);
  writeFileSync(join(dir, "closures.php"), CLOSURES_PHP);
  return dir;
}

test("PHP closures: variable-assigned closures are named after their variable", () => {
  const { nodes } = extractFile("closures.php", CLOSURES_PHP, "php");
  const ids = nodes.map((n) => n.id);
  // top-level `static function` assigned to $itemGroupCallback, and the closure
  // assigned to $mapper inside the method — both keep the variable name, no {closure}.
  assert.ok(ids.includes("closures.php#itemGroupCallback"), `expected named top-level closure, got: ${ids.join(", ")}`);
  assert.ok(
    ids.includes("closures.php#Service.getItemList.mapper"),
    `expected named nested closure, got: ${ids.join(", ")}`,
  );
  assert.ok(!ids.some((id) => id.includes("{closure}")), `no closure should collapse to {closure}, got: ${ids.join(", ")}`);
});

test("PHP closures: closure names are stable across repeated extraction", () => {
  // The name derives from a tree-sitter node comparison; wrapper identity is not
  // stable across traversals, so the comparison must use node `.id`, not `===`.
  // Re-extracting the same source must yield the identical closure-node id set.
  const first = extractFile("closures.php", CLOSURES_PHP, "php").nodes.map((n) => n.id).sort();
  for (let i = 0; i < 5; i++) {
    const again = extractFile("closures.php", CLOSURES_PHP, "php").nodes.map((n) => n.id).sort();
    assert.deepEqual(again, first, "closure-node ids must be identical on every extraction");
  }
});

test("PHP closures: `graft check` stays fresh after build (no name drift)", async () => {
  const dir = makeClosureFixture();
  try {
    await buildGraph(dir);
    // No source changed between build and check, so the recomputed Tier-1 node set
    // must match the committed graph exactly — in particular the closure ids.
    const result = await checkGraph(dir);
    assert.deepEqual(result.added, [], "check should report no added nodes");
    assert.deepEqual(result.removed, [], "check should report no removed nodes");
    assert.deepEqual(result.changed, [], "check should report no changed nodes");
    assert.equal(result.ok, true, "graph check should be OK immediately after build");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// #145: tree-sitter-php 0.23.x cannot parse `const` inside an enum body. An
// array value collapses the whole `enum_declaration` into ERROR and recovers
// the method as a file-scope `function_definition`. Scalar const / class const
// must keep working — those trees already have a real type node.
const ENUM_ARRAY_CONST_PHP = `<?php

enum Foo: string
{
    case A = 'a';
    case B = 'b';

    private const MAP = [
        'a' => 'Alpha',
        'b' => 'Beta',
    ];

    public static function nameFor(string $k): ?string
    {
        return self::MAP[$k] ?? null;
    }
}
`;

const ENUM_SCALAR_CONST_PHP = `<?php

enum Foo: string
{
    case A = 'a';

    private const LABEL = 'x';

    public static function nameFor(string $k): ?string
    {
        return self::LABEL;
    }
}
`;

const CLASS_ARRAY_CONST_PHP = `<?php

class Foo
{
    private const MAP = [
        'a' => 'Alpha',
        'b' => 'Beta',
    ];

    public static function nameFor(string $k): ?string
    {
        return self::MAP[$k] ?? null;
    }
}
`;

function symbolIds(nodes: NodeV1[]): string[] {
  return nodes.filter((n) => n.kind !== "file").map((n) => `${n.kind}:${n.id}`);
}

test("PHP enum with array const keeps enum:Foo and method:Foo.nameFor (#145)", () => {
  const { nodes } = extractFile("e.php", ENUM_ARRAY_CONST_PHP, "php");
  const ids = symbolIds(nodes);
  assert.equal(nodes.find((n) => n.id === "e.php#Foo")?.kind, "enum", `expected enum:Foo, got: ${ids.join(", ")}`);
  const nameFor = nodes.find((n) => n.id === "e.php#Foo.nameFor");
  assert.equal(nameFor?.kind, "method", `expected method:Foo.nameFor, got: ${ids.join(", ")}`);
  assert.equal(nameFor?.name, "nameFor");
  assert.ok(
    !nodes.some((n) => n.kind === "function" && n.name === "nameFor"),
    `nameFor must not leak as a top-level function, got: ${ids.join(", ")}`,
  );
});

test("PHP enum with scalar const still emits enum + qualified method (#145 control)", () => {
  const { nodes } = extractFile("e.php", ENUM_SCALAR_CONST_PHP, "php");
  const ids = symbolIds(nodes);
  assert.equal(nodes.find((n) => n.id === "e.php#Foo")?.kind, "enum", `expected enum:Foo, got: ${ids.join(", ")}`);
  assert.equal(nodes.find((n) => n.id === "e.php#Foo.nameFor")?.kind, "method", `expected method:Foo.nameFor, got: ${ids.join(", ")}`);
  assert.ok(!nodes.some((n) => n.kind === "function" && n.name === "nameFor"), `got: ${ids.join(", ")}`);
});

test("PHP class with array const is unchanged (#145 control)", () => {
  const { nodes } = extractFile("e.php", CLASS_ARRAY_CONST_PHP, "php");
  const ids = symbolIds(nodes);
  assert.equal(nodes.find((n) => n.id === "e.php#Foo")?.kind, "class", `expected class:Foo, got: ${ids.join(", ")}`);
  assert.equal(nodes.find((n) => n.id === "e.php#Foo.nameFor")?.kind, "method", `expected method:Foo.nameFor, got: ${ids.join(", ")}`);
  assert.ok(!nodes.some((n) => n.kind === "function" && n.name === "nameFor"), `got: ${ids.join(", ")}`);
});

test("PHP enum array-const recovery does not swallow a following top-level function (#145)", () => {
  const source = `${ENUM_ARRAY_CONST_PHP.trimEnd()}\n\nfunction topLevel(): int\n{\n    return 1;\n}\n`;
  const { nodes } = extractFile("e.php", source, "php");
  const ids = symbolIds(nodes);
  assert.equal(nodes.find((n) => n.id === "e.php#Foo")?.kind, "enum", `got: ${ids.join(", ")}`);
  assert.equal(nodes.find((n) => n.id === "e.php#Foo.nameFor")?.kind, "method", `got: ${ids.join(", ")}`);
  assert.equal(nodes.find((n) => n.id === "e.php#topLevel")?.kind, "function", `got: ${ids.join(", ")}`);
  assert.ok(!nodes.some((n) => n.id === "e.php#Foo.topLevel"), `topLevel must stay file-scope, got: ${ids.join(", ")}`);
});

test("PHP extraction: closures become nodes and own the calls inside them", async () => {
  const dir = makeFixture();
  try {
    await buildGraph(dir);
    const graph = readGraph(wiringPath(join(dir, "graft")))!;

    // an assigned arrow-fn is named after its variable (like a TS arrow-const)
    assert.equal(nodeById(graph, "app.php#make")?.kind, "function", "assigned closure `$make` is a function node");

    // a bare callback (`register(function () {…})`) is an anonymous `{closure}` node
    assert.ok(
      graph.nodes.some((n) => n.id === "app.php#{closure}" && n.kind === "function"),
      "anonymous callback becomes a {closure} function node",
    );

    // the call inside each closure attributes to the closure, not the file —
    // this is what keeps a closure-only routing table structured
    assert.ok(
      graph.edges.some(
        (e) => e.relation === "calls" && e.source === "app.php#make" && e.target === "app.php#topLevel",
      ),
      "the arrow-fn body's call to topLevel is owned by `make`",
    );
    assert.ok(
      graph.edges.some(
        (e) => e.relation === "calls" && e.source === "app.php#{closure}" && e.target === "app.php#topLevel",
      ),
      "the anonymous callback's call to topLevel is owned by {closure}",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Issue #144: PHP 8 attributes are metadata, not call sites — wire them as
// `references` edges from the annotated symbol to the attribute class.
const ATTR_ROUTE_PHP = `<?php
namespace Poc\\Attr;

#[\\Attribute]
class Route
{
    public function __construct(public string $path, public string $method = 'GET') {}
}
`;

const ATTR_DEPRECATED_PHP = `<?php
namespace Poc\\Attr;

#[\\Attribute]
class Deprecated
{
    public function __construct(public string $message) {}
}
`;

const ATTR_WIDGET_PHP = `<?php
namespace Poc;
use Poc\\Attr\\Route;
use Poc\\Attr\\Deprecated;

#[Deprecated('use NewWidget')]
class Widget {
    #[Route('/widgets', method: 'GET')]
    public function index(): void { $this->load(); }
    private function load(): void {}
}
`;

function makeAttributeFixture(): string {
  const dir = mkdtempSync(join(tmpdir(), "graft-php-attr-"));
  writeFileSync(join(dir, "composer.json"), `{"name": "poc/app"}\n`);
  mkdirSync(join(dir, "Poc", "Attr"), { recursive: true });
  writeFileSync(join(dir, "Poc", "Attr", "Route.php"), ATTR_ROUTE_PHP);
  writeFileSync(join(dir, "Poc", "Attr", "Deprecated.php"), ATTR_DEPRECATED_PHP);
  writeFileSync(join(dir, "Poc", "Widget.php"), ATTR_WIDGET_PHP);
  return dir;
}

test("PHP extraction: attribute usage resolves to references edges (#144)", async () => {
  const dir = makeAttributeFixture();
  try {
    await buildGraph(dir);
    const graph = readGraph(wiringPath(join(dir, "graft")))!;

    assert.ok(
      graph.edges.some(
        (e) =>
          e.relation === "references" &&
          e.source === "Poc/Widget.php#Widget" &&
          e.target === "Poc/Attr/Deprecated.php#Deprecated",
      ),
      "Widget class should reference the Deprecated attribute class",
    );

    assert.ok(
      graph.edges.some(
        (e) =>
          e.relation === "references" &&
          e.source === "Poc/Widget.php#Widget.index" &&
          e.target === "Poc/Attr/Route.php#Route",
      ),
      "index method should reference the Route attribute class",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// #144 remainder: a `use`d attribute class that is not defined in the repo
// (Symfony `#[Route]`, `#[Deprecated]`, …) was dropped in resolve.ts because
// `if (!byId.has(targetFile)) continue`. Java annotations in the same situation
// keep an inferred references edge to the bare name. Do not mint a vendor
// class node.
const VENDOR_ROUTE_PHP = `<?php
use Symfony\\Component\\Routing\\Annotation\\Route;

class Controller {
    #[Route('/')]
    public function index(): void {}
}
`;

test("PHP extraction: vendor attribute keeps an inferred references edge (#144)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "graft-php-vendor-attr-"));
  try {
    writeFileSync(join(dir, "composer.json"), `{"name": "poc/vendor-attr"}\n`);
    writeFileSync(join(dir, "Controller.php"), VENDOR_ROUTE_PHP);
    await buildGraph(dir);
    const graph = readGraph(wiringPath(join(dir, "graft")))!;

    assert.ok(
      !graph.nodes.some((n) => n.name === "Route" && n.kind === "class"),
      "must not mint a Route class node for a vendor attribute",
    );

    const refs = graph.edges.filter(
      (e) => e.relation === "references" && e.source === "Controller.php#Controller.index",
    );
    assert.ok(
      refs.some(
        (e) =>
          e.confidence === "inferred" &&
          (e.target === "Route" || e.target === "Symfony\\Component\\Routing\\Annotation\\Route"),
      ),
      `index should keep an inferred references edge to vendor Route, got: ${JSON.stringify(refs)}`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Issue #144: an anonymous class (`new class implements I {…}`) previously
// produced no node and no heritage edge — its methods were mis-attributed to
// the enclosing function (`…#make.run`), so the type and its interface
// contract were invisible. It now mints an `{anonymous}` class node
// (mirroring the `{closure}` naming), carries its `implements`/`extends`
// edges, and owns the methods declared in its body.
const ANON_PHP = `<?php
namespace Poc;

interface Runnable {}

class Base
{
    public function label(): string
    {
        return 'b';
    }
}

function make(): Runnable
{
    return new class implements Runnable {
        public function run(): int { return 1; }
    };
}

function decorate(): Base
{
    return new class extends Base {
        public function label(): string { return 'd'; }
    };
}
`;

function makeAnonFixture(): string {
  const dir = mkdtempSync(join(tmpdir(), "graft-php-anon-"));
  writeFileSync(join(dir, "composer.json"), `{"name": "poc/anon"}\n`);
  writeFileSync(join(dir, "poc.php"), ANON_PHP);
  return dir;
}

test("PHP anonymous classes: mint a class node that owns its methods (#144)", () => {
  const { nodes } = extractFile("poc.php", ANON_PHP, "php");
  const ids = nodes.map((n) => n.id);

  const anon = nodes.find((n) => n.id === "poc.php#make.{anonymous}");
  assert.equal(anon?.kind, "class", `expected an {anonymous} class node, got: ${ids.join(", ")}`);

  // the method nests under the anonymous class, not the enclosing function
  const run = nodes.find((n) => n.id === "poc.php#make.{anonymous}.run");
  assert.equal(run?.kind, "method");
  assert.equal(run?.owner, "{anonymous}", "run's owner is the anonymous class");
  assert.ok(!ids.includes("poc.php#make.run"), "run must not attach to the enclosing function");

  // control: enclosing functions and named classes are unchanged
  assert.equal(nodes.find((n) => n.id === "poc.php#make")?.kind, "function");
  assert.equal(nodes.find((n) => n.id === "poc.php#Base.label")?.owner, "Base");
});

test("PHP anonymous classes: implements/extends edges resolve (#144)", async () => {
  const dir = makeAnonFixture();
  try {
    await buildGraph(dir);
    const graph = readGraph(wiringPath(join(dir, "graft")))!;

    assert.ok(
      graph.edges.some(
        (e) =>
          e.relation === "implements" &&
          e.source === "poc.php#make.{anonymous}" &&
          e.target === "poc.php#Runnable",
      ),
      "anonymous class should have a resolved implements edge to Runnable",
    );
    assert.ok(
      graph.edges.some(
        (e) =>
          e.relation === "extends" &&
          e.source === "poc.php#decorate.{anonymous}" &&
          e.target === "poc.php#Base",
      ),
      "anonymous class should have a resolved extends edge to Base",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("PHP anonymous classes: siblings in one scope dedupe like {closure}", () => {
  const src = `<?php
$a = new class { public function one(): int { return 1; } };
$b = new class { public function two(): int { return 2; } };
`;
  const { nodes } = extractFile("dup.php", src, "php");
  const ids = nodes.map((n) => n.id);
  assert.ok(ids.includes("dup.php#{anonymous}"), `expected an {anonymous} node, got: ${ids.join(", ")}`);
  assert.ok(ids.includes("dup.php#{anonymous}~2"), `expected a deduplicated {anonymous}~2 node, got: ${ids.join(", ")}`);
});

// #139: a PHP class whose methods return a heredoc/nowdoc must still emit the
// class and both methods — not collapse to a file node. Depth-tier extractFile
// uses native tree-sitter-php; the wasm grammar crash is covered in
// generic-extract.test.ts. This pins the user-visible graph shape.
const HEREDOC_PHP = `<?php
namespace App;
class WithHeredoc {
    public function sql(): string {
        return <<<SQL
            SELECT 1
            SQL;
    }
    public function other(): int { return 2; }
}
`;

test("PHP heredoc: extractFile emits class + both methods (#139)", () => {
  const { nodes } = extractFile("h.php", HEREDOC_PHP, "php");
  const ids = symbolIds(nodes);
  assert.equal(nodes.find((n) => n.id === "h.php#WithHeredoc")?.kind, "class", `expected class:WithHeredoc, got: ${ids.join(", ")}`);
  assert.equal(nodes.find((n) => n.id === "h.php#WithHeredoc.sql")?.kind, "method", `expected method:sql, got: ${ids.join(", ")}`);
  assert.equal(nodes.find((n) => n.id === "h.php#WithHeredoc.other")?.kind, "method", `expected method:other, got: ${ids.join(", ")}`);
  assert.ok(nodes.some((n) => n.kind === "file"), "file node is still present");
  assert.ok(nodes.filter((n) => n.kind !== "file").length >= 3, `must not be file-only, got: ${ids.join(", ")}`);
});

test("PHP nowdoc: extractFile emits class + both methods (#139)", () => {
  const src = HEREDOC_PHP.replace("WithHeredoc", "WithNowdoc").replace("<<<SQL", "<<<'SQL'");
  const { nodes } = extractFile("n.php", src, "php");
  const ids = symbolIds(nodes);
  assert.equal(nodes.find((n) => n.id === "n.php#WithNowdoc")?.kind, "class", `got: ${ids.join(", ")}`);
  assert.equal(nodes.find((n) => n.id === "n.php#WithNowdoc.sql")?.kind, "method", `got: ${ids.join(", ")}`);
  assert.equal(nodes.find((n) => n.id === "n.php#WithNowdoc.other")?.kind, "method", `got: ${ids.join(", ")}`);
});
