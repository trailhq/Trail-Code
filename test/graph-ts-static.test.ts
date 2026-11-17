/**
 * TypeScript/JavaScript static member calls in the Tier-1 code graph: `Cache.create()`
 * names the class itself as the receiver, so it resolves to that class's static method —
 * same file or imported — while a capitalised receiver that owns no such method
 * (`Math.max`) and a local that shadows the class name resolve to nothing.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildGraph } from "../src/graph/build.js";
import { readGraph, wiringPath } from "../src/graph/write.js";
import type { GraphV1 } from "../src/graph/types.js";

async function graphOf(files: Record<string, string>): Promise<GraphV1> {
  const dir = mkdtempSync(join(tmpdir(), "graft-ts-static-"));
  try {
    for (const [name, src] of Object.entries(files)) writeFileSync(join(dir, name), src);
    await buildGraph(dir);
    return readGraph(wiringPath(join(dir, "graft")))!;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const calls = (g: GraphV1, source: string) =>
  g.edges.filter((e) => e.relation === "calls" && e.source === source).map((e) => e.target).sort();

const CACHE_TS = `export class Cache {
  static create(): Cache { return new Cache(); }
  static reset(): void {}
  get(k: string): number { return Cache.reset(), 1; }
}
export class Pool {
  static create(): Pool { return new Pool(); }
}
`;

test("TS static call: Class.method() resolves to the class's static method, in the same file and across files", async () => {
  const g = await graphOf({
    "cache.ts": CACHE_TS + "export function local() { return Cache.create(); }\n",
    "use.ts": `import { Cache, Pool } from "./cache";
export function build() { return Cache.create(); }
export function both() { Pool.create(); return Cache.reset(); }
`,
    "legacy.js": `class Svc { static make() {} run() { return Svc.make(); } }\nmodule.exports = Svc;\n`,
  });
  assert.deepEqual(calls(g, "cache.ts#local"), ["cache.ts#Cache.create"]);
  assert.deepEqual(calls(g, "cache.ts#Cache.get"), ["cache.ts#Cache.reset"]);
  assert.deepEqual(calls(g, "use.ts#build"), ["cache.ts#Cache.create"]);
  assert.deepEqual(calls(g, "use.ts#both"), ["cache.ts#Cache.reset", "cache.ts#Pool.create"]);
  assert.deepEqual(calls(g, "legacy.js#Svc.run"), ["legacy.js#Svc.make"]);
});

test("TS static call: a capitalised receiver without that method, and a typed parameter named like a class, do not become the class's statics", async () => {
  const g = await graphOf({
    "cache.ts": CACHE_TS,
    "use.ts": `import { Cache } from "./cache";
class Other { run() {} }
export function builtins() { return Math.max(1, 2) + Number.parseInt("3") + Cache.nope(); }
export function shadow(Pool: Other) { Pool.create(); Pool.run(); }
`,
  });
  assert.deepEqual(calls(g, "use.ts#builtins"), []);
  assert.deepEqual(calls(g, "use.ts#shadow"), ["use.ts#Other.run"]);
});

test("TS static call: only a class declared in the file or imported from a relative module is read as the class", async () => {
  const g = await graphOf({
    "cache.ts": CACHE_TS,
    "fns.ts": `export function create() {}\n`,
    "external.ts": `import { Cache } from "lru-cache";\nexport function run() { return Cache.create(); }\n`,
    "default.ts": `import Cache from "lru-cache";\nexport function run() { return Cache.create(); }\n`,
    "namespace.ts": `import * as Cache from "./fns";\nexport function run() { return Cache.create(); }\n`,
    "local.ts": `export function run() { const Cache = { create() {} }; return Cache.create(); }\n`,
    "callback.ts": `import { Cache } from "./cache";\nexport function run(xs: any[]) { return xs.map((Cache) => Cache.create()); }\nexport function after() { return Cache.create(); }\n`,
    "alias.ts": `import { Cache as Store } from "./cache";\nexport function run() { return Store.create(); }\n`,
  });
  for (const file of ["external", "default", "namespace", "local"]) assert.deepEqual(calls(g, `${file}.ts#run`), [], file);
  assert.deepEqual(calls(g, "callback.ts#run"), []);
  assert.deepEqual(calls(g, "callback.ts#after"), ["cache.ts#Cache.create"]);
  assert.deepEqual(calls(g, "alias.ts#run"), ["cache.ts#Cache.create"]);
});
