/**
 * Tests for Python calls made through an imported MODULE alias — the shape
 * `from app.services import billing` / `billing.charge()`, which a layered
 * codebase uses for most of its cross-module traffic (importing the module, not
 * each function, is what keeps `billing.charge` readable at the call site).
 *
 * Before this, such a call reached the resolver as a member call with no
 * inferable receiver type and was dropped — correctly, by the drop-rather-than-
 * guess rule in resolve.ts, since a bare `charge` says nothing about which file
 * it lives in. The missing half was the import binding: Python had no
 * module-alias table at all, so the module the alias names was never carried to
 * the call site. With it, the call states both halves — the file (the import)
 * and the symbol (the attribute) — which is the same evidence a named import
 * already gives a `references` edge, and resolves exactly.
 *
 * The negative tests matter more than the positive ones: a module-qualified call
 * must not become a licence to guess. A rebound local name, an unresolvable
 * module and a name absent from the module it was looked up in must each leave
 * the edge unresolved rather than reach for a same-named symbol elsewhere.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildGraph } from "../src/graph/build.js";
import { readGraph, wiringPath } from "../src/graph/write.js";
import type { GraphV1 } from "../src/graph/types.js";

const BILLING = `def charge(user, amount):
    return amount


def refund(user, amount):
    return -amount
`;

/** A second `charge`, in a module nobody imports here: a bare-name fallback
 * would have two candidates, so any edge to THIS one is a guess. */
const LEGACY = `def charge(user, amount):
    return 0
`;

const CONFIG = `TIMEOUT = 30


def load():
    return TIMEOUT
`;

/** Every supported binding shape, plus the two that must NOT resolve. */
const API = `from app.services import billing
from app.services import billing as money
from app import config as settings
import app.services.billing as direct
from .local import helper


def pay(user):
    return billing.charge(user, 10)


def pay_aliased(user):
    return money.refund(user, 10)


def read_timeout():
    return settings.load()


def pay_direct(user):
    return direct.charge(user, 1)


def use_relative():
    return helper.run()


def shadowed(billing):
    # The parameter rebinds the name: this is a call on the argument, not into
    # the module, and must not produce an edge into app/services/billing.py.
    return billing.charge(1, 2)


def rebound():
    billing = _Stub()
    return billing.charge(3, 4)


def absent(user):
    # The module resolves, but it has no "void" — no edge, and no reaching
    # for a same-named symbol in another file.
    return billing.void(user)


class _Stub:
    def charge(self, a, b):
        return 0
`;

const LOCAL_HELPER = `def run():
    return 1
`;

/** An import of a module that is not in the repo — the specifier must stay
 * unresolved and the call must not fall back to the in-repo `charge`. */
const EXTERNAL = `import thirdparty.billing as vendor


def pay(user):
    return vendor.charge(user, 5)
`;

function makeFixture(): string {
  const dir = mkdtempSync(join(tmpdir(), "graft-py-modcalls-"));
  mkdirSync(join(dir, "app", "services"), { recursive: true });
  mkdirSync(join(dir, "app", "local"), { recursive: true });
  writeFileSync(join(dir, "app", "__init__.py"), "");
  writeFileSync(join(dir, "app", "config.py"), CONFIG);
  writeFileSync(join(dir, "app", "services", "__init__.py"), "");
  writeFileSync(join(dir, "app", "services", "billing.py"), BILLING);
  writeFileSync(join(dir, "app", "legacy.py"), LEGACY);
  writeFileSync(join(dir, "app", "local", "__init__.py"), "");
  writeFileSync(join(dir, "app", "api.py"), API);
  writeFileSync(join(dir, "app", "local", "helper.py"), LOCAL_HELPER);
  writeFileSync(join(dir, "app", "external.py"), EXTERNAL);
  return dir;
}

async function buildFixture(dir: string): Promise<GraphV1> {
  await buildGraph(dir); // $0, Tier-1 only
  const graph = readGraph(wiringPath(join(dir, "graft")));
  assert.ok(graph, "wiring graph should be written");
  return graph!;
}

const callsOf = (graph: GraphV1, source: string): string[] =>
  graph.edges.filter((e) => e.relation === "calls" && e.source === source).map((e) => e.target);

test("Python: a call through an imported module alias resolves to that module's function", async () => {
  const graph = await buildFixture(makeFixture());

  assert.deepEqual(
    callsOf(graph, "app/api.py#pay"),
    ["app/services/billing.py#charge"],
    "billing.charge() should resolve into the imported module",
  );
  assert.deepEqual(
    callsOf(graph, "app/api.py#pay_aliased"),
    ["app/services/billing.py#refund"],
    "an `as` alias binds the same module",
  );
  assert.deepEqual(
    callsOf(graph, "app/api.py#read_timeout"),
    ["app/config.py#load"],
    "`from app import config as settings` binds a module one level up",
  );
  assert.deepEqual(
    callsOf(graph, "app/api.py#pay_direct"),
    ["app/services/billing.py#charge"],
    "`import a.b.c as x` binds the dotted module too",
  );
  assert.deepEqual(
    callsOf(graph, "app/api.py#use_relative"),
    ["app/local/helper.py#run"],
    "a relative import anchors on the importing file's own package",
  );
});

test("Python: a module-qualified call never guesses past its own module", async () => {
  const graph = await buildFixture(makeFixture());

  assert.deepEqual(
    callsOf(graph, "app/api.py#shadowed"),
    [],
    "a parameter of the same name shadows the module for the whole body",
  );
  // The local `billing = _Stub()` keeps its own edges (constructor, and the
  // stub's method via the receiver-binding table) — what must not appear is an
  // edge into the module the name no longer denotes.
  assert.ok(
    !callsOf(graph, "app/api.py#rebound").some((t) => t.startsWith("app/services/billing.py")),
    "a local assignment rebinds the name away from the module",
  );
  assert.deepEqual(
    callsOf(graph, "app/api.py#absent"),
    [],
    "a name the module does not define resolves to nothing, not to a namesake elsewhere",
  );
  assert.deepEqual(
    callsOf(graph, "app/external.py#pay"),
    [],
    "an out-of-repo module leaves the call unresolved",
  );
});

test("Python: absolute and relative imports resolve to in-repo files", async () => {
  const graph = await buildFixture(makeFixture());
  const imports = graph.edges
    .filter((e) => e.relation === "imports" && e.source === "app/api.py")
    .map((e) => e.target);

  // `from app.services import billing` names the PACKAGE, so the import edge
  // lands on its `__init__.py` — the module itself is named by the call edge.
  // `import app.services.billing as direct` names the module outright.
  assert.ok(
    imports.includes("app/services/__init__.py"),
    `a dotted import should name an in-repo file, got ${JSON.stringify(imports)}`,
  );
  assert.ok(
    imports.includes("app/services/billing.py"),
    `an aliased dotted import should name the module file, got ${JSON.stringify(imports)}`,
  );
  assert.ok(imports.includes("app/local/__init__.py"), "a relative import should name the file");
  assert.ok(
    graph.edges.some(
      (e) => e.relation === "imports" && e.source === "app/external.py" && e.target === "thirdparty.billing",
    ),
    "an external package stays a truthful unresolved specifier",
  );
});
