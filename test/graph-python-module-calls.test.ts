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


def shared_fn():
    return 10
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

/** Import-list shapes: several modules on one line, a parenthesized multi-line
 * list with comments and aliases, and a wildcard that binds nothing nameable. */
const CALL_SHAPES = `import os, util as uu, json
from pkg import (  # the package's modules
    sub as s,  # aliased
    sib,
)
from util import *


def run():
    uu.acquire_lock()
    s.sub_fn()
    sib.sib_fn()
    util.resolve_plan()
    return os.getcwd()
`;

/** \`json\` is the stdlib here. \`app/serializers/json.py\` merely ENDS in \`json.py\`: it
 * is not importable as \`json\` from \`app/views.py\`, so no edge may be made. */
const SER_JSON = `def dumps(x):
    return str(x)
`;

const VIEWS_JSON = `import json


def run(x):
    return json.dumps(x)
`;

/** Source roots that ARE plausible: \`src/\` under the repo root, and the top of the
 * importer's own package tree (\`backend/\`, the first ancestor with no \`__init__.py\`). */
const SRC_MOD = `def make_src():
    return 8
`;

const USE_SRC = `import src_mod


def run():
    return src_mod.make_src()
`;

const BACKEND_MODELS = `def make_model():
    return 9
`;

const BACKEND_VIEWS = `import app.models as m


def run():
    return m.make_model()
`;

/** \`config = config.load()\` rebinds the name to a value, so \`config.get()\` is a call on
 * that value (\`Config.get\`), not on the module's own \`get\`. */
const CONFIG = `class Config:
    def get(self):
        return 1


def load():
    return Config()


def get():
    return 2
`;

const CALL_REBIND = `import config

config = config.load()


def run():
    return config.get()
`;

/** Rebinding through \`global\` inside a function is a module-level rebinding too. */
const CALL_GLOBAL_REBIND = `import config


def reset():
    global config
    config = object()


def run():
    return config.get()
`;

/** \`scripts/\` has no \`__init__.py\`, so it is a script directory: its own \`util.py\`
 * is what \`import util\` finds from there, ahead of the repo-root \`util.py\`. */
const SCRIPTS_UTIL = `def shared_fn():
    return 11
`;

const SCRIPTS_RUN = `import util


def run():
    return util.shared_fn()
`;

/** \`pkgr.py\` sits beside the \`pkgr/\` package. \`from . import x\` in the package names
 * \`pkgr/__init__.py\`, never \`pkgr.py\`, and that \`__init__\` defines \`x\` itself. */
const PKGR_FILE = `def other():
    return 12
`;

const PKGR_INIT = `def x():
    return 13
`;

const PKGR_X = `def f():
    return 14
`;

const PKGR_USER = `from . import x


def run():
    return x.f()
`;

/** The optional-dependency idiom: the \`None\` fallback is not a rebinding of the module. */
const CALL_OPTIONAL = `try:
    import util as uu2
except ImportError:
    uu2 = None


def run():
    return uu2.resolve_plan()
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
  writeFileSync(join(dir, "call_shapes.py"), CALL_SHAPES);
  mkdirSync(join(dir, "app", "serializers"), { recursive: true });
  writeFileSync(join(dir, "app", "serializers", "json.py"), SER_JSON);
  writeFileSync(join(dir, "app", "views.py"), VIEWS_JSON);
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "src", "src_mod.py"), SRC_MOD);
  writeFileSync(join(dir, "use_src.py"), USE_SRC);
  mkdirSync(join(dir, "backend", "app"), { recursive: true });
  writeFileSync(join(dir, "backend", "app", "__init__.py"), "");
  writeFileSync(join(dir, "backend", "app", "models.py"), BACKEND_MODELS);
  writeFileSync(join(dir, "backend", "app", "views.py"), BACKEND_VIEWS);
  writeFileSync(join(dir, "config.py"), CONFIG);
  writeFileSync(join(dir, "call_rebind.py"), CALL_REBIND);
  writeFileSync(join(dir, "call_global_rebind.py"), CALL_GLOBAL_REBIND);
  mkdirSync(join(dir, "scripts"), { recursive: true });
  writeFileSync(join(dir, "scripts", "util.py"), SCRIPTS_UTIL);
  writeFileSync(join(dir, "scripts", "run.py"), SCRIPTS_RUN);
  mkdirSync(join(dir, "pkgr"), { recursive: true });
  writeFileSync(join(dir, "pkgr.py"), PKGR_FILE);
  writeFileSync(join(dir, "pkgr", "__init__.py"), PKGR_INIT);
  writeFileSync(join(dir, "pkgr", "x.py"), PKGR_X);
  writeFileSync(join(dir, "pkgr", "user.py"), PKGR_USER);
  writeFileSync(join(dir, "call_optional.py"), CALL_OPTIONAL);
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

test("Python: multi-name, parenthesized, commented and aliased import lists", async () => {
  const dir = makeFixture();
  try {
    const targets = (await callTargets(dir, "call_shapes.py#run")).sort();
    // `util.resolve_plan()` is NOT here: `from util import *` binds no module name.
    assert.deepEqual(targets, ["pkg/sib.py#sib_fn", "pkg/sub.py#sub_fn", "util.py#acquire_lock"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Python: a module is matched at a source root, not by any file whose path ends in its name", async () => {
  const dir = makeFixture();
  try {
    // `import json` is the stdlib; app/serializers/json.py is not importable as `json` from app/views.py.
    assert.deepEqual(await callTargets(dir, "app/views.py#run"), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Python: modules under src/ and under the importer's own top package still resolve", async () => {
  const dir = makeFixture();
  try {
    assert.deepEqual(await callTargets(dir, "use_src.py#run"), ["src/src_mod.py#make_src"]);
    assert.deepEqual(await callTargets(dir, "backend/app/views.py#run"), ["backend/app/models.py#make_model"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Python: `config = config.load()` at module level shadows the module for later calls", async () => {
  const dir = makeFixture();
  try {
    assert.deepEqual(await callTargets(dir, "call_rebind.py#run"), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Python: rebinding the module name through `global` in a function shadows it too", async () => {
  const dir = makeFixture();
  try {
    assert.deepEqual(await callTargets(dir, "call_global_rebind.py#run"), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Python: a script's own directory wins over the repo root for a same-named module", async () => {
  const dir = makeFixture();
  try {
    assert.deepEqual(await callTargets(dir, "scripts/run.py#run"), ["scripts/util.py#shared_fn"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Python: `from . import x` reads the package's __init__, not a sibling pkg.py", async () => {
  const dir = makeFixture();
  try {
    // pkgr/__init__.py defines `x`, so `x.f()` is a call on that function, not on pkgr/x.py.
    assert.deepEqual(await callTargets(dir, "pkgr/user.py#run"), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Python: an `except ImportError: mod = None` fallback does not unbind the module", async () => {
  const dir = makeFixture();
  try {
    assert.deepEqual(await callTargets(dir, "call_optional.py#run"), ["util.py#resolve_plan"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
