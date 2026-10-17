import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { extractFile } from "../src/graph/extract.js";
import { buildGraph } from "../src/graph/build.js";
import { readGraph, wiringPath } from "../src/graph/write.js";
import { callersOf } from "../src/graph/traverse.js";

const uses = String.raw`<?php
namespace App;
use App\Types\{Color as Shade, Widget, Runnable, Failure};
`;

for (const [label, source, names] of [
  ["nullable property", "class Painter { public ?Shade $favourite = null; }", ["Color"]],
  ["parameter", "function paint(Shade $color): void {}", ["Color"]],
  ["return type", "function paint(): Shade { throw new \\Exception(); }", ["Color", "Exception"]],
  ["union and intersection", "function paint((Widget&Runnable)|Shade $value): void {}", ["Color", "Runnable", "Widget"]],
  ["constructor", "function paint() { return new Widget(); }", ["Widget"]],
  ["instanceof", "function paint($value) { return $value instanceof Widget; }", ["Widget"]],
  ["enum constant", "function paint() { return Shade::RED; }", ["Color"]],
  ["class literal", "function paint() { return Widget::class; }", ["Widget"]],
  ["static method", "function paint() { return Shade::warm(); }", ["Color"]],
  ["static property", "function paint() { return Widget::$current; }", ["Widget"]],
  ["catch type", "function paint() { try {} catch (Failure $e) {} }", ["Failure"]],
] as const) {
  test(`PHP type references: ${label}`, () => {
    const result = extractFile("Painter.php", uses + source, "php");
    const refs = result.rawEdges.filter(edge => edge.relation === "references");
    assert.deepEqual(refs.map(edge => edge.name).sort(), [...names]);
    for (const ref of refs) {
      assert.equal(ref.source, source.startsWith("class") ? "Painter.php#Painter" : "Painter.php#paint");
      assert.equal(ref.specifier, ref.name === "Exception" ? "Exception" : `App\\Types\\${ref.name}`);
    }
  });
}

test("PHP type references do not treat declarations, primitives or dynamic expressions as types", () => {
  const result = extractFile("Painter.php", uses + `
class Painter {
  public string $Shade;
  public function identity(): self { return $this; }
  public function paint(int $Widget, object $value): array {
    $Shade = 'Widget';
    Shade();
    $value->Shade();
    $value->Shade;
    new $Shade();
    $value instanceof $Shade;
    $Shade::RED;
    self::paint();
    static::paint();
    parent::paint();
    return [];
  }
}
`, "php");
  assert.deepEqual(result.rawEdges.filter(edge => edge.relation === "references"), []);
});

test("PHP callers finds enum/type users across aliases and qualified names (#324)", async () => {
  const root = mkdtempSync(join(tmpdir(), "graft-php-references-"));
  try {
    mkdirSync(join(root, "src"));
    const files = {
      "Color.php": String.raw`<?php namespace App; enum Color: string { case RED = 'red'; public static function warm(): array { return [self::RED]; } }`,
      "Widget.php": String.raw`<?php namespace App; class Widget {}`,
      "Painter.php": String.raw`<?php namespace App; use App\Color; class Painter { public ?Color $favourite = null; public function paint(Color $color): string { return $color->value; } }`,
      "Decorator.php": String.raw`<?php namespace App; use App\Color as C; class Decorator { public function decorate(): string { return C::RED->value; } }`,
      "Factory.php": String.raw`<?php namespace App; function make(): \App\Widget { return new \App\Widget(); } function matches($value): bool { return $value instanceof \App\Widget; }`,
      "Local.php": String.raw`<?php class LocalType {} function makeLocal(): LocalType { return new LocalType(); }`,
    };
    for (const [path, source] of Object.entries(files)) writeFileSync(join(root, "src", path), source);
    await buildGraph(root, { reuse: false });
    const graph = readGraph(wiringPath(join(root, "graft")))!;
    const color = graph.nodes.find(node => node.id === "src/Color.php#Color")!;
    assert.deepEqual(callersOf(graph, color).map(hit => [hit.id, hit.relation]).sort(), [
      ["src/Decorator.php#Decorator.decorate", "references"],
      ["src/Painter.php#Painter", "references"],
      ["src/Painter.php#Painter.paint", "references"],
    ]);
    const widget = graph.nodes.find(node => node.id === "src/Widget.php#Widget")!;
    assert.deepEqual(callersOf(graph, widget).map(hit => [hit.id, hit.relation]).sort(), [
      ["src/Factory.php#make", "references"],
      ["src/Factory.php#matches", "references"],
    ]);
    const local = graph.nodes.find(node => node.id === "src/Local.php#LocalType")!;
    assert.deepEqual(callersOf(graph, local).map(hit => [hit.id, hit.relation]), [
      ["src/Local.php#makeLocal", "references"],
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
