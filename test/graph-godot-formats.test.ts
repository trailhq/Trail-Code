import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { contextDirFor } from "../src/context/node-file.js";
import { buildGraph } from "../src/graph/build.js";
import { checkGraph } from "../src/graph/check.js";
import { unsupportedExtensions } from "../src/graph/source-files.js";
import { readGraph, wiringPath } from "../src/graph/write.js";

test("Godot scenes, resources, and settings index declarations through the generic tier", async () => {
  const dir = mkdtempSync(join(tmpdir(), "graft-godot-scene-"));
  try {
    assert.deepEqual(unsupportedExtensions([".TSCN", ".tres", ".GODOT", ".scn", ".res"]), [".scn", ".res"]);
    writeFileSync(join(dir, "LEVEL.TSCN"), `[gd_scene format=3]
[ext_resource type="Script" path="res://actor.gd" id="1_actor"]
[sub_resource type="BoxMesh" id="BoxMesh_1"]
[node name="Level" type="Node3D"]
script = ExtResource("1_actor")
[node type="MeshInstance3D" name="Mesh" parent="."]
mesh = SubResource("BoxMesh_1")
[connection signal="ready" from="Mesh" to="." method="_on_ready"]
`);
    writeFileSync(join(dir, "material.tres"), `[gd_resource type="ShaderMaterial" format=3]
[ext_resource type="Shader" path="res://surface.gdshader" id="1_shader"]
[sub_resource type="Curve" id="Curve_1"]
[resource]
shader = ExtResource("1_shader")
`);
    writeFileSync(join(dir, "project.godot"), `config_version=5
[application]
config/name="Demo"
[autoload]
Globals="*res://globals.gd"
[input]
move_left={"deadzone": 0.2, "events": []}
`);
    const result = await buildGraph(dir, { reuse: false });
    assert.deepEqual(result.errors, []);
    const graph = readGraph(wiringPath(contextDirFor(dir)));
    assert.ok(graph);
    const namesIn = (file: string) => graph.nodes.filter(n => n.path === file && n.kind !== "file").map(n => n.name).sort();
    assert.deepEqual(namesIn("LEVEL.TSCN"), ['"BoxMesh_1"', '"Level"', '"Mesh"', '"res://actor.gd"']);
    assert.deepEqual(namesIn("material.tres"), ['"Curve_1"', '"ShaderMaterial"', '"res://surface.gdshader"']);
    assert.deepEqual(namesIn("project.godot"), ["Globals", "application", "autoload", "config/name", "config_version", "input", "move_left"]);
    assert.equal(graph.nodes.find(n => n.name === '"Level"')?.span, "L4-L5");
    assert.deepEqual(graph.edges, []);
    assert.equal((await checkGraph(dir)).ok, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Godot shaders and includes index symbols and resolve helper calls by name", async () => {
  const dir = mkdtempSync(join(tmpdir(), "graft-gdshader-"));
  try {
    assert.deepEqual(unsupportedExtensions([".GDSHADER", ".GDSHADERINC"]), []);
    const shader = `shader_type spatial;
render_mode unshaded;
struct Surface { vec3 color; };
const float BIAS = 0.4, SCALE = 1.0;
const float LEVEL = 1;
const float LUT[2] = {1.0, 2.0};
uniform float strength : hint_range(0.0, 1.0) = 0.5;
uniform vec3 colors[2];
varying vec2 coords, offset;
#include "res://COMMON.GDSHADERINC"
float hint_range(float corner) { return corner; }
float shade(float value) { return gain(value) + BIAS; }
void fragment() {
    float samples[2] = {gain(strength), 0.0};
    ALBEDO = vec3(shade(strength));
}
`;
    writeFileSync(join(dir, "surface.gdshader"), shader);
    writeFileSync(join(dir, "COMMON.GDSHADERINC"), `#ifndef GODOT_HELPERS
#define GODOT_HELPERS
#define TWICE(x) ((x) * 2.0)
float gain(float value) { return value * 2.0; }
#endif
`);
    const result = await buildGraph(dir, { reuse: false });
    assert.deepEqual(result.errors, []);
    const graph = readGraph(wiringPath(contextDirFor(dir)));
    assert.ok(graph);
    const namesIn = (file: string) => graph.nodes.filter(n => n.path === file && n.kind !== "file").map(n => n.name).sort();
    assert.deepEqual(namesIn("surface.gdshader"), [
      "BIAS", "LEVEL", "LUT", "Surface", "colors", "coords", "fragment",
      "hint_range", "shade", "strength",
    ]);
    assert.deepEqual(namesIn("COMMON.GDSHADERINC"), ["GODOT_HELPERS", "TWICE", "gain"]);
    const edges = graph.edges.map(e => [e.source, e.relation, e.target]);
    assert.deepEqual(edges, [
      ["surface.gdshader#fragment", "calls", "COMMON.GDSHADERINC#gain"],
      ["surface.gdshader#fragment", "calls", "surface.gdshader#shade"],
      ["surface.gdshader#shade", "calls", "COMMON.GDSHADERINC#gain"],
    ]);
    assert.equal((await checkGraph(dir)).ok, true);

    writeFileSync(join(dir, "surface.gdshader"), shader
      .replace("const float LEVEL", "const int LEVEL")
      .replace("varying vec2 coords", "varying vec3 coords"));
    const rebuilt = await buildGraph(dir);
    assert.deepEqual(rebuilt.errors, []);
    const updatedGraph = readGraph(wiringPath(contextDirFor(dir)));
    assert.ok(updatedGraph);
    for (const name of ["LEVEL", "coords"]) {
      const id = `surface.gdshader#${name}`;
      const before = graph.nodes.find(n => n.id === id);
      const after = updatedGraph.nodes.find(n => n.id === id);
      assert.ok(before && after, `expected ${id} in both graphs`);
      assert.notEqual(before.body_hash, after.body_hash, `type change must update the hash for ${id}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
