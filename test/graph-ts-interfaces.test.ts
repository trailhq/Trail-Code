/**
 * TypeScript interface members in the Tier-1 code graph: a method signature in a
 * named interface is a method node owned by that interface, an interface's
 * `extends` clause is heritage, and a call through an interface-typed receiver
 * resolves to the interface's method, never to a guessed implementation.
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
  const dir = mkdtempSync(join(tmpdir(), "graft-ts-iface-"));
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
const methods = (g: GraphV1) => g.nodes.filter((n) => n.kind === "method").map((n) => n.id).sort();

const STORE_TS = `export interface Store {
  save(id: string): Promise<void>;
}
export interface LockingStore extends Store {
  lock(id: string): Promise<boolean>;
}
`;
const MEM_TS = `import type { LockingStore } from "./store";
export class MemStore implements LockingStore {
  async save(id: string): Promise<void> {}
  async lock(id: string): Promise<boolean> { return true; }
}
`;
const RUN_TS = `import type { Store, LockingStore } from "./store";
export async function persist(store: Store): Promise<void> {
  await store.save("a");
}
export async function guarded(store: LockingStore): Promise<void> {
  if (await store.lock("a")) await store.save("a");
}
`;

test("TS interface: a method signature in a named interface is a method owned by it", async () => {
  const g = await graphOf({ "store.ts": STORE_TS, "mem.ts": MEM_TS, "run.ts": RUN_TS });
  const save = g.nodes.find((n) => n.id === "store.ts#Store.save");
  assert.equal(save?.kind, "method");
  assert.equal(save?.owner, "Store");
  assert.equal(save?.exported, true);
  assert.equal(g.nodes.find((n) => n.id === "store.ts#LockingStore.lock")?.owner, "LockingStore");
  assert.ok(g.edges.some((e) => e.relation === "contains" && e.source === "store.ts#Store" && e.target === "store.ts#Store.save"));
});

test("TS interface: a call through an interface-typed parameter resolves to the interface method", async () => {
  const g = await graphOf({ "store.ts": STORE_TS, "mem.ts": MEM_TS, "run.ts": RUN_TS });
  assert.deepEqual(calls(g, "run.ts#persist"), ["store.ts#Store.save"]);
});

test("TS interface: `extends` is heritage, so an inherited method resolves through it", async () => {
  const g = await graphOf({ "store.ts": STORE_TS, "mem.ts": MEM_TS, "run.ts": RUN_TS });
  const ext = g.edges.find((e) => e.relation === "extends" && e.source === "store.ts#LockingStore");
  assert.equal(ext?.target, "store.ts#Store");
  assert.equal(ext?.confidence, "extracted");
  assert.deepEqual(calls(g, "run.ts#guarded"), ["store.ts#LockingStore.lock", "store.ts#Store.save"]);
});

test("TS interface: generic and namespace-qualified supertypes keep their bare name", async () => {
  const g = await graphOf({
    "base.ts": "export interface Base<T> { get(): T; }\nexport interface Other { put(): void; }\n",
    "sub.ts":
      'import type { Base } from "./base";\nimport type * as ns from "./base";\n' +
      "export interface Sub<T> extends Base<T>, ns.Other { more(): void; }\n" +
      "export function use(t: Sub2) { t.get(); t.put(); }\n" +
      "interface Sub2 extends Base<number>, ns.Other {}\n",
  });
  const parents = (src: string) =>
    g.edges.filter((e) => e.relation === "extends" && e.source === src).map((e) => e.target).sort();
  assert.deepEqual(parents("sub.ts#Sub"), ["base.ts#Base", "base.ts#Other"]);
  assert.deepEqual(calls(g, "sub.ts#use"), ["base.ts#Base.get", "base.ts#Other.put"]);
});

test("TS interface: no edge to an implementation — the interface method is the target, not a guess", async () => {
  const g = await graphOf({ "store.ts": STORE_TS, "mem.ts": MEM_TS, "run.ts": RUN_TS });
  const intoImpl = g.edges.filter((e) => e.relation === "calls" && e.target.startsWith("mem.ts#MemStore."));
  assert.deepEqual(intoImpl, []);
  // A class-typed receiver still resolves to the class's own method (regression guard).
  const g2 = await graphOf({
    "store.ts": STORE_TS,
    "mem.ts": MEM_TS,
    "use.ts": 'import { MemStore } from "./mem";\nexport function direct(m: MemStore) { m.save("a"); }\n',
  });
  assert.deepEqual(calls(g2, "use.ts#direct"), ["mem.ts#MemStore.save"]);
});

test("TS interface: signatures in anonymous object types mint nothing and resolve nothing", async () => {
  const g = await graphOf({
    "store.ts": STORE_TS,
    "anon.ts":
      "type Saver = { save(id: string): void };\n" +
      "export function viaAlias(s: Saver) { s.save(\"a\"); }\n" +
      "export function viaLiteral(s: { save(id: string): void }) { s.save(\"a\"); }\n" +
      "export function untyped(s: any) { s.save(\"a\"); }\n" +
      "interface Iter { [Symbol.iterator](): Iterator<number>; \"quoted\"(): void; }\n",
  });
  assert.deepEqual(methods(g), ["store.ts#LockingStore.lock", "store.ts#Store.save"]);
  for (const fn of ["viaAlias", "viaLiteral", "untyped"]) assert.deepEqual(calls(g, `anon.ts#${fn}`), [], fn);
});

test("TS interface: an overload set is one method node, so calls to it stay resolvable", async () => {
  const g = await graphOf({
    "repo.ts": "export interface Repo {\n  get(id: string): number;\n  get(id: number): number;\n}\n",
    "use.ts": 'import type { Repo } from "./repo";\nexport function read(r: Repo) { return r.get("a"); }\n',
  });
  assert.deepEqual(methods(g), ["repo.ts#Repo.get"]);
  assert.deepEqual(calls(g, "use.ts#read"), ["repo.ts#Repo.get"]);
});

test("TS interface: two unrelated interfaces of the same name stay ambiguous and drop", async () => {
  const g = await graphOf({
    "a.ts": "export interface Store { save(): void; }\n",
    "b.ts": "export interface Store { save(): void; }\n",
    "use.ts": 'import type { Store } from "./a";\nexport function f(s: Store) { s.save(); }\n',
  });
  assert.deepEqual(calls(g, "use.ts#f"), []);
});

test("TSX: interface members and interface-typed calls are handled the same as TS", async () => {
  const g = await graphOf({
    "props.tsx": "export interface Theme { color(): string; }\nexport interface DarkTheme extends Theme { dim(): void; }\n",
    "view.tsx":
      'import type { DarkTheme } from "./props";\n' +
      "export function View({ theme }: { theme: DarkTheme }) { return <b>{theme.color()}</b>; }\n" +
      "export function paint(theme: DarkTheme) { theme.dim(); return theme.color(); }\n",
  });
  assert.equal(g.nodes.find((n) => n.id === "props.tsx#Theme.color")?.owner, "Theme");
  assert.deepEqual(calls(g, "view.tsx#paint"), ["props.tsx#DarkTheme.dim", "props.tsx#Theme.color"]);
});
