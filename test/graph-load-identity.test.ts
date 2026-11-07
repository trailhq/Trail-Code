import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadGraphCached, loadAskIndexCached, invalidateGraphCaches, __parseCount, __resetParseCounts } from "../src/graph/load.js";
import { writeGraph, wiringPath, readGraph } from "../src/graph/write.js";
import { writeAskIndex, askIndexPath, readAskIndex } from "../src/ask/index-file.js";
import type { GraphV1 } from "../src/graph/types.js";

const fixedTime = new Date("2023-11-14T22:13:20.000Z");
function graph(id: string): GraphV1 {
  return { version: 1, nodes: [{ id, name: id, kind: "function", path: `${id}.ts`, span: "L1-L1", signature: null, exported: true, origin: "ast", body_hash: id, summary_state: "pending", summary: null, crux: null }], edges: [] };
}
const readers = [
  { kind: "graph", load: loadGraphCached, write: (dir: string, id: string) => writeGraph(graph(id), dir), path: wiringPath, id: (value: any) => value?.nodes[0]?.id, read: (dir: string) => readGraph(wiringPath(dir)), count: () => __parseCount.graph },
  { kind: "ask", load: loadAskIndexCached, write: (dir: string, id: string) => writeAskIndex(dir, graph(id)), path: askIndexPath, id: (value: any) => value?.docs[0]?.id, read: readAskIndex, count: () => __parseCount.askIndex },
];
function fixture(t: any): string {
  const dir = mkdtempSync(join(tmpdir(), "graft-cache-identity-"));
  t.after(() => { invalidateGraphCaches(dir); rmSync(dir, { recursive: true, force: true }); });
  return dir;
}
function stamp(path: string): void { utimesSync(path, fixedTime, fixedTime); }
function identity(path: string) {
  const s = statSync(path);
  return { dev: s.dev, ino: s.ino, ctimeMs: s.ctimeMs, mtimeMs: s.mtimeMs, size: s.size };
}

for (const r of readers) {
  test(`${r.kind}: same-size same-mtime atomic rename reloads and stays warm`, (t) => {
    const dir = fixture(t), replacement = fixture(t);
    r.write(dir, "alpha"); stamp(r.path(dir)); __resetParseCounts();
    const first = r.load(dir);
    assert.equal(r.id(first), "alpha"); assert.strictEqual(r.load(dir), first); assert.equal(r.count(), 1);
    const before = identity(r.path(dir));
    r.write(replacement, "bravo"); stamp(r.path(replacement));
    renameSync(r.path(replacement), r.path(dir));
    const after = identity(r.path(dir));
    assert.equal(after.mtimeMs, before.mtimeMs); assert.equal(after.size, before.size);
    assert.notEqual(after.ino, before.ino, "real replacement must have a distinct inode");
    assert.equal(r.id(r.read(dir)), "bravo", "uncached production reader must see replacement bytes");
    const second = r.load(dir);
    assert.equal(r.id(second), "bravo", "cached loader must pick up atomic replacement");
    assert.notStrictEqual(second, first); assert.equal(r.count(), 2);
    assert.strictEqual(r.load(dir), second); assert.equal(r.count(), 2);
  });
  test(`${r.kind}: explicit invalidation forces an unchanged file to reparse`, (t) => {
    const dir = fixture(t); r.write(dir, "alpha"); stamp(r.path(dir)); __resetParseCounts();
    const first = r.load(dir); assert.equal(r.id(first), "alpha");
    assert.strictEqual(r.load(dir), first); assert.equal(r.count(), 1);
    invalidateGraphCaches(dir);
    const second = r.load(dir); assert.deepEqual(second, first); assert.notStrictEqual(second, first); assert.equal(r.count(), 2);
  });
  test(`${r.kind}: missing files do not cache a miss or retain a removed value`, (t) => {
    const dir = fixture(t); __resetParseCounts();
    assert.equal(r.load(dir), null); assert.equal(r.load(dir), null); assert.equal(r.count(), 0);
    r.write(dir, "alpha"); stamp(r.path(dir)); assert.equal(r.id(r.load(dir)), "alpha"); assert.equal(r.count(), 1);
    rmSync(r.path(dir)); assert.equal(r.load(dir), null); assert.equal(r.count(), 1);
    r.write(dir, "bravo"); stamp(r.path(dir)); assert.equal(r.id(r.load(dir)), "bravo"); assert.equal(r.count(), 2);
  });
  test(`${r.kind}: malformed JSON stays null and atomic repair is read`, (t) => {
    const dir = fixture(t), repair = fixture(t); r.write(repair, "alpha");
    const size = statSync(r.path(repair)).size;
    mkdirSync(join(dir, r.kind === "graph" ? ".graph" : ".cache"), { recursive: true });
    writeFileSync(r.path(dir), "x".repeat(size)); stamp(r.path(dir)); __resetParseCounts();
    assert.equal(r.load(dir), null); assert.equal(r.load(dir), null); assert.equal(r.count(), 1);
    stamp(r.path(repair)); renameSync(r.path(repair), r.path(dir));
    assert.equal(r.id(r.load(dir)), "alpha"); assert.equal(r.count(), 2);
  });
}

test("root paths isolate graph and ask values with identical size/mtime", (t) => {
  const parent = fixture(t), left = join(parent, "left", "graft"), right = join(parent, "right", "graft");
  t.after(() => { invalidateGraphCaches(left); invalidateGraphCaches(right); });
  __resetParseCounts();
  for (const r of readers) {
    r.write(left, "alpha"); r.write(right, "bravo"); stamp(r.path(left)); stamp(r.path(right));
    const a = identity(r.path(left)), b = identity(r.path(right));
    assert.equal(a.size, b.size); assert.equal(a.mtimeMs, b.mtimeMs);
    const one = r.load(left), two = r.load(right);
    assert.equal(r.id(one), "alpha"); assert.equal(r.id(two), "bravo"); assert.notStrictEqual(one, two);
    assert.strictEqual(r.load(left), one); assert.strictEqual(r.load(right), two); assert.equal(r.count(), 2);
    invalidateGraphCaches(left); assert.equal(r.id(r.load(left)), "alpha");
    assert.strictEqual(r.load(right), two); assert.equal(r.count(), 3);
  }
});

test("real graph/ask rebuild plus explicit invalidation needs no sleep", (t) => {
  const dir = fixture(t); __resetParseCounts();
  for (const r of readers) { r.write(dir, "alpha"); stamp(r.path(dir)); assert.equal(r.id(r.load(dir)), "alpha"); }
  for (const r of readers) { r.write(dir, "bravo"); stamp(r.path(dir)); }
  invalidateGraphCaches(dir);
  for (const r of readers) { const value = r.load(dir); assert.equal(r.id(value), "bravo"); assert.strictEqual(r.load(dir), value); assert.equal(r.count(), 2); }
});
