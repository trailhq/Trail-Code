/**
 * Tests for Python calls made through a module name or an import alias
 * (issue #537): `import util` then `util.resolve_plan()`, and `import util as u`
 * then `u.acquire_lock()`.
 *
 * The `from util import acquire_lock` + `acquire_lock()` form already resolves
 * (by repo-wide unique name, not by reading the import), so it is pinned here as
 * the control. The module forms must resolve through the import itself: the
 * receiver names a module, the module names a file, and the attribute is looked
 * up inside that file only. `release_lock` is declared in two files so a
 * resolver that falls back to a bare-name guess cannot pass by luck.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildGraph } from "../src/graph/build.js";
import { readGraph, wiringPath } from "../src/graph/write.js";
import type { GraphV1 } from "../src/graph/types.js";

const UTIL = `def acquire_lock():
    return 1


def resolve_plan():
    return 2


def release_lock():
    return 3
`;

/** Same name as `util.release_lock` — only the import can say which one is meant. */
const OTHER = `def release_lock():
    return 4
`;

const SUB = `def sub_fn():
    return 5
`;

const CALL_DIRECT = `from util import acquire_lock


def run():
    return acquire_lock()
`;

const CALL_ALIAS = `import util as u


def run():
    return u.acquire_lock()
`;

const CALL_MODULE = `import util


def run():
    util.resolve_plan()
    return util.release_lock()
`;

const CALL_PKG = `from pkg import sub


def run():
    return sub.sub_fn()
`;

/** `util` has no `missing`, so nothing may be linked. */
const CALL_MISSING = `import util


def run():
    return util.missing()
`;

/** A parameter named like the module shadows it: `util.acquire_lock` is a method call here. */
const CALL_SHADOW = `import util


def run(util):
    return util.acquire_lock()
`;

/** `pkg2/__init__.py` defines `sub` itself, so `from pkg2 import sub` binds that
 * function, not the submodule `pkg2/sub.py` — `sub.sub_fn()` is not a module call. */
const PKG2_INIT = `def sub():
    return 6
`;

const CALL_ATTR_WINS = `from pkg2 import sub


def run():
    return sub.sub_fn()
`;

/** Relative form: `from . import sib` binds the sibling module `pkg/sib.py`. */
const SIB = `def sib_fn():
    return 7
`;

const REL_USER = `from . import sib


def run():
    return sib.sib_fn()
`;

function makeFixture(): string {
  const dir = mkdtempSync(join(tmpdir(), "graft-python-modcalls-"));
  mkdirSync(join(dir, "pkg"), { recursive: true });
  writeFileSync(join(dir, "pkg", "__init__.py"), "");
  writeFileSync(join(dir, "pkg", "sub.py"), SUB);
  mkdirSync(join(dir, "pkg2"), { recursive: true });
  writeFileSync(join(dir, "pkg2", "__init__.py"), PKG2_INIT);
  writeFileSync(join(dir, "pkg2", "sub.py"), SUB);
  writeFileSync(join(dir, "call_attr_wins.py"), CALL_ATTR_WINS);
  writeFileSync(join(dir, "pkg", "sib.py"), SIB);
  writeFileSync(join(dir, "pkg", "rel_user.py"), REL_USER);
  writeFileSync(join(dir, "util.py"), UTIL);
  writeFileSync(join(dir, "other.py"), OTHER);
  writeFileSync(join(dir, "call_direct.py"), CALL_DIRECT);
  writeFileSync(join(dir, "call_alias.py"), CALL_ALIAS);
  writeFileSync(join(dir, "call_module.py"), CALL_MODULE);
  writeFileSync(join(dir, "call_pkg.py"), CALL_PKG);
  writeFileSync(join(dir, "call_missing.py"), CALL_MISSING);
  writeFileSync(join(dir, "call_shadow.py"), CALL_SHADOW);
  return dir;
}

async function callTargets(dir: string, source: string): Promise<string[]> {
  await buildGraph(dir); // $0, Tier-1 only
  const graph: GraphV1 | null = readGraph(wiringPath(join(dir, "graft")));
  assert.ok(graph, "wiring graph should be written");
  return graph!.edges.filter((e) => e.relation === "calls" && e.source === source).map((e) => e.target);
}

test("Python: `from util import f` + `f()` resolves (control)", async () => {
  const dir = makeFixture();
  try {
    assert.deepEqual(await callTargets(dir, "call_direct.py#run"), ["util.py#acquire_lock"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Python: `import util as u` + `u.f()` resolves to util.f", async () => {
  const dir = makeFixture();
  try {
    assert.deepEqual(await callTargets(dir, "call_alias.py#run"), ["util.py#acquire_lock"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Python: `import util` + `util.f()` resolves, and the import picks between same-named functions", async () => {
  const dir = makeFixture();
  try {
    const targets = await callTargets(dir, "call_module.py#run");
    assert.ok(targets.includes("util.py#resolve_plan"), "util.resolve_plan() should resolve");
    assert.ok(targets.includes("util.py#release_lock"), "util.release_lock() should resolve to util.py's copy");
    assert.ok(!targets.includes("other.py#release_lock"), "the same-named function in other.py must not be linked");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Python: `from pkg import sub` + `sub.f()` resolves into pkg/sub.py", async () => {
  const dir = makeFixture();
  try {
    assert.deepEqual(await callTargets(dir, "call_pkg.py#run"), ["pkg/sub.py#sub_fn"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Python: a name the imported module does not define links nothing", async () => {
  const dir = makeFixture();
  try {
    assert.deepEqual(await callTargets(dir, "call_missing.py#run"), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Python: a parameter shadowing the module name is not a module call", async () => {
  const dir = makeFixture();
  try {
    assert.deepEqual(await callTargets(dir, "call_shadow.py#run"), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Python: a name the package itself defines wins over a same-named submodule", async () => {
  const dir = makeFixture();
  try {
    assert.deepEqual(await callTargets(dir, "call_attr_wins.py#run"), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Python: `from . import sib` + `sib.f()` resolves to the sibling module", async () => {
  const dir = makeFixture();
  try {
    assert.deepEqual(await callTargets(dir, "pkg/rel_user.py#run"), ["pkg/sib.py#sib_fn"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
