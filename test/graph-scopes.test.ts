import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  discoverScopes,
  scopeOf,
  discoverWorkspaceChildren,
  scopesOfGraph,
} from "../src/graph/scopes.js";
import { buildGraph } from "../src/graph/build.js";
import { readGraph, wiringPath, writeGraph } from "../src/graph/write.js";
import { loadGraphCached } from "../src/graph/load.js";
import { writeBuildConfig } from "../src/util/state.js";
import type { GraphV1 } from "../src/graph/types.js";

function fx(layout: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "scopes-"));
  for (const [p, content] of Object.entries(layout)) {
    mkdirSync(join(dir, p, ".."), { recursive: true });
    writeFileSync(join(dir, p), content);
  }
  return dir;
}

test("frontend/backend markers under one git root -> two scopes", () => {
  const d = fx({
    "frontend/package.json": "{}", "frontend/src/app.ts": "export const a = 1;",
    "backend/go.mod": "module m", "backend/main.go": "package main",
  });
  const scopes = discoverScopes(d);
  assert.deepEqual(scopes.map((s) => s.prefix).sort(), ["backend", "frontend"]);
  assert.equal(scopeOf("frontend/src/app.ts", scopes).label, "frontend");
  assert.equal(scopeOf("README.md", scopes).prefix, "");  // root scope always exists as fallback
  rmSync(d, { recursive: true, force: true });
});

test("workspace globs are intent: packages/* honored, deeper ignored", () => {
  const d = fx({
    "package.json": JSON.stringify({ workspaces: ["packages/*"] }),
    "packages/core/package.json": "{}", "packages/core/i.ts": "1",
    "packages/cli/package.json": "{}", "packages/cli/i.ts": "1",
    "packages/cli/nested/package.json": "{}",  // deeper than glob -> ignored
  });
  const prefixes = discoverScopes(d).map((s) => s.prefix).sort();
  assert.deepEqual(prefixes, ["packages/cli", "packages/core"]);
  rmSync(d, { recursive: true, force: true });
});

test("gitignored generated workspace directories cannot become scopes (#39)", () => {
  const d = fx({
    ".gitignore": "generated/\n",
    "package.json": JSON.stringify({ workspaces: ["packages/*", "generated/*"] }),
    "packages/app/package.json": "{}",
    "packages/app/src/index.ts": "export const app = 1;",
    "generated/bundle/package.json": "{}",
    "generated/bundle/index.ts": "export const generated = 1;",
  });
  try {
    execFileSync("git", ["init", "-q"], { cwd: d });
    assert.deepEqual(discoverScopes(d).map((s) => s.prefix), ["packages/app"]);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test("root-only marker -> canonical single scope", () => {
  const d = fx({ "package.json": "{}", "src/a.ts": "1" });
  const scopes = discoverScopes(d);
  assert.deepEqual(scopes, [{ prefix: "", label: "", markers: ["package.json"] }]);
  rmSync(d, { recursive: true, force: true });
});

test("depth guard: markers 3 levels down ignored without workspace glob", () => {
  const d = fx({ "a/b/c/package.json": "{}", "src/x.ts": "1" });
  assert.equal(discoverScopes(d).length, 1); // root only
  rmSync(d, { recursive: true, force: true });
});

test("nesting collapse keeps shallower candidate", () => {
  const d = fx({ "svc/package.json": "{}", "svc/sub/package.json": "{}", "svc/i.ts": "1" });
  assert.deepEqual(discoverScopes(d).filter((s) => s.prefix).map((s) => s.prefix), ["svc"]);
  rmSync(d, { recursive: true, force: true });
});

test("nesting collapse is layout-deterministic regardless of sibling readdir order (P10)", () => {
  // pnpm-workspace.yaml: packages: ['a/b/*'] + a/go.mod (candidate) + a/b/w/package.json
  // (workspace match, wins over its parent "a") + a sibling of "b" under "a" that is
  // ALSO a bare marker candidate. Whether the sibling is named "c" or "aa" changes
  // readdirSync's return order for "a"'s children — that must not change which
  // candidates survive Rule 4's nesting collapse.
  const run = (siblingName: string): string[] => {
    const d = fx({
      "pnpm-workspace.yaml": "packages:\n  - 'a/b/*'\n",
      "a/go.mod": "module a\n",
      "a/b/w/package.json": "{}",
      [`a/${siblingName}/go.mod`]: `module ${siblingName}\n`,
    });
    try {
      return discoverScopes(d)
        .map((s) => s.prefix)
        .sort();
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  };
  // Normalize the sibling's own name away so the two runs compare structurally:
  // both must resolve to "the sibling scope" + the workspace-glob scope, with the
  // collapsed parent "a" gone in both cases.
  const normalize = (prefixes: string[], siblingName: string): string[] =>
    prefixes.map((p) => (p === `a/${siblingName}` ? "a/<sibling>" : p)).sort();

  const withC = run("c");
  const withAa = run("aa");
  assert.deepEqual(normalize(withC, "c"), normalize(withAa, "aa"));
  assert.deepEqual(normalize(withC, "c"), ["a/<sibling>", "a/b/w"]);
});

test("literal (non-glob) workspace entry resolves as a workspace match", () => {
  const d = fx({
    "package.json": JSON.stringify({ workspaces: ["apps/*", "docs"] }),
    "apps/web/package.json": "{}", "apps/web/i.ts": "1",
    "docs/package.json": "{}", "docs/index.ts": "1",
  });
  const prefixes = discoverScopes(d).map((s) => s.prefix).sort();
  assert.deepEqual(prefixes, ["apps/web", "docs"]);
  rmSync(d, { recursive: true, force: true });
});

test("workspace-under-workspace collapses to the shallower scope (packages/**)", () => {
  const d = fx({
    "pnpm-workspace.yaml": "packages:\n  - 'packages/**'\n",
    "packages/a/package.json": "{}",
    "packages/a/b/package.json": "{}",
  });
  const prefixes = discoverScopes(d).map((s) => s.prefix).sort();
  assert.deepEqual(prefixes, ["packages/a"]);
  rmSync(d, { recursive: true, force: true });
});

test("workspace-under-workspace collapse also sweeps markerless dirs under a **-glob", () => {
  const d = fx({
    "pnpm-workspace.yaml": "packages:\n  - 'packages/**'\n",
    "packages/a/package.json": "{}",
    "packages/a/src/utils/x.ts": "export const x = 1;",
  });
  const prefixes = discoverScopes(d).map((s) => s.prefix).sort();
  assert.deepEqual(prefixes, ["packages/a"]); // no markerless packages/a/src* survives
  rmSync(d, { recursive: true, force: true });
});

test("literal + glob workspace overlap collapses to the shallower literal entry", () => {
  const d = fx({
    "package.json": JSON.stringify({ workspaces: ["apps", "apps/*"] }),
    "apps/package.json": "{}",
    "apps/web/package.json": "{}",
  });
  const prefixes = discoverScopes(d).map((s) => s.prefix).sort();
  assert.deepEqual(prefixes, ["apps"]);
  rmSync(d, { recursive: true, force: true });
});

test("discoverWorkspaceChildren finds immediate git children only", () => {
  const d = fx({ "repoA/x.ts": "1", "repoB/y.py": "1", "plain/z.go": "1" });
  mkdirSync(join(d, "repoA/.git"), { recursive: true });
  mkdirSync(join(d, "repoB/.git"), { recursive: true });
  mkdirSync(join(d, "repoB/vendored/.git"), { recursive: true }); // nested: not a child of d
  assert.deepEqual(discoverWorkspaceChildren(d).sort(), ["repoA", "repoB"]);
  rmSync(d, { recursive: true, force: true });
});

test("discoverWorkspaceChildren follows a symlinked child repo, not dangling or cyclic links (#319)", () => {
  const d = fx({ "repoA/x.ts": "1" });
  mkdirSync(join(d, "repoA/.git"), { recursive: true });
  const outside = fx({ "repoC/src/a.py": "1" });
  mkdirSync(join(outside, "repoC/.git"), { recursive: true });
  symlinkSync(join(outside, "repoC"), join(d, "repoC-link")); // a symlink to a repo elsewhere
  symlinkSync(join(d, "does-not-exist"), join(d, "dangling"));
  symlinkSync(d, join(d, "self-link")); // points back at the workspace root
  symlinkSync(join(outside, "repoC/src/a.py"), join(d, "file-link")); // a file, not a repo
  assert.deepEqual(discoverWorkspaceChildren(d).sort(), ["repoA", "repoC-link"]);
  rmSync(d, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

test("A5: discoverScopes finds a marker under a SKIP_DIRS name once persisted via --include-dir state, absent otherwise", () => {
  const d = fx({ "build/package.json": "{}" });
  assert.deepEqual(discoverScopes(d), [{ prefix: "", label: "", markers: [] }], "build/ is skipped by default — no scope found");

  writeBuildConfig(d, { includeDirs: ["build"] });
  const prefixes = discoverScopes(d).map((s) => s.prefix);
  assert.deepEqual(prefixes, ["build"], "once persisted, build/'s own marker is discovered as a scope");
  rmSync(d, { recursive: true, force: true });
});

function tsFns(n: number): string {
  return Array.from({ length: n }, (_, i) => `export function fn${i}() { return ${i}; }`).join("\n");
}

function pyFns(n: number): string {
  return Array.from({ length: n }, (_, i) => `def fn${i}():\n    return ${i}\n`).join("\n");
}

test("buildGraph wires meta.scopes: substantial scopes survive, tiny scopes merge into root", async () => {
  const d = fx({
    "frontend/package.json": "{}",
    "frontend/app.ts": tsFns(6),
    "backend/pyproject.toml": '[project]\nname = "backend"\n',
    "backend/app.py": pyFns(6),
    "tiny/package.json": "{}",
    "tiny/app.ts": tsFns(1),
  });
  try {
    await buildGraph(d);
    const graph = readGraph(wiringPath(join(d, "graft")));
    assert.ok(graph, "wiring graph should be written");
    const prefixes = (graph!.meta.scopes ?? []).map((s) => s.prefix).sort();
    assert.deepEqual(prefixes, ["backend", "frontend"]); // tiny (1 symbol) merged into root
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test("old graphs without meta.scopes fall back to the canonical root scope via scopesOfGraph", () => {
  const d = mkdtempSync(join(tmpdir(), "scopes-oldgraph-"));
  try {
    const graph: GraphV1 = {
      meta: { version: 1, nodeCount: 0, edgeCount: 0, languages: [] }, // no `scopes` field
      nodes: [],
      edges: [],
    };
    const outDir = join(d, "graft");
    writeGraph(graph, outDir);

    const loaded = loadGraphCached(outDir);
    assert.ok(loaded);
    const scopes = scopesOfGraph(loaded!);
    assert.deepEqual(scopes, [{ prefix: "", label: "", markers: [] }]);
    assert.equal(scopeOf("anything/at/all.ts", scopes).prefix, "");
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});
