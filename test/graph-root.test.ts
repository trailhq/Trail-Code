/**
 * `nearestGraftRoot` — the implicit root for a query that names no directory.
 *
 * The case that motivates it: an agent session (or a shell) opens in
 * `<repo>/src/foo/`, where there is no `graft/`. Before the walk, every query
 * resolved the context dir as `<cwd>/graft`, found nothing, and reported "no
 * graph — run graft build" while the repo's graph sat two levels up.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { nearestGraftRoot, hasGraftIndex } from "../src/graph/root.js";
import { tmpRepo } from "./helpers.js";

/** A repo root with a wiring graph — the `graft build` shape. */
function builtRepo(root: string): string {
  mkdirSync(join(root, "graft", ".graph"), { recursive: true });
  writeFileSync(join(root, "graft", ".graph", "wiring.json"), '{"version":1,"nodes":[],"edges":[]}\n');
  return root;
}

/** A workspace parent — children index, no nodes/edges of its own. */
function workspaceParent(root: string, children: string[]): string {
  mkdirSync(join(root, "graft"), { recursive: true });
  writeFileSync(join(root, "graft", "workspace.json"), JSON.stringify({ version: 1, children }) + "\n");
  return root;
}

/** A checkout root without a graph yet. */
function gitRepo(root: string): string {
  mkdirSync(join(root, ".git"), { recursive: true });
  return root;
}

test("a subdirectory of a built repo resolves up to the repo root", () => {
  const repo = builtRepo(tmpRepo("root-walk"));
  const deep = join(repo, "src", "foo", "bar");
  mkdirSync(deep, { recursive: true });

  assert.deepEqual(nearestGraftRoot(deep), { root: repo, levels: 3 });
  assert.deepEqual(nearestGraftRoot(repo), { root: repo, levels: 0 }, "the root itself must not walk");
});

test("a workspace parent counts as a root — workspace.json, no wiring.json", () => {
  const parent = workspaceParent(tmpRepo("root-ws"), ["repoA", "repoB"]);
  const scratch = join(parent, "scratch");
  mkdirSync(scratch, { recursive: true });

  assert.ok(hasGraftIndex(parent), "workspace.json alone makes a graft root");
  assert.deepEqual(nearestGraftRoot(scratch), { root: parent, levels: 1 });
});

test("the NEAREST root wins — a built child inside a workspace parent, not the parent", () => {
  const parent = workspaceParent(tmpRepo("root-nearest"), ["child"]);
  const child = builtRepo(join(parent, "child"));
  const deep = join(child, "src");
  mkdirSync(deep, { recursive: true });

  assert.deepEqual(nearestGraftRoot(deep), { root: child, levels: 1 }, "must stop at the child, not federate at the parent");
});

test("a child checkout without a graph does not fall back to a parent graph", () => {
  const parent = builtRepo(tmpRepo("root-parent-graph"));
  const child = gitRepo(join(parent, "toolforge"));
  const deep = join(child, "src");
  mkdirSync(deep, { recursive: true });

  assert.deepEqual(
    nearestGraftRoot(deep),
    { root: child, levels: 1 },
    "a missing child graph must resolve to the child checkout, not the parent graph",
  );
});

/** Real git, isolated from the user's config, so `.git` files are git's own shape. */
function git(cwd: string, ...args: string[]): void {
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "protocol.file.allow=always", ...args], {
    cwd,
    stdio: "ignore",
    timeout: 30_000,
    windowsHide: true,
    env: { ...process.env, GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
  });
}

/** A committed repo at `dir` with one file. */
function committedRepo(dir: string): string {
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "src", "a.ts"), "export const a = 1;\n");
  git(dir, "init", "-q");
  git(dir, "add", ".");
  git(dir, "commit", "-qm", "init");
  return dir;
}

test("a submodule walks up to the superproject graph (`--follow-submodules` indexes it there)", () => {
  const lib = committedRepo(join(tmpRepo("root-sub-lib"), "lib"));
  const parent = committedRepo(join(tmpRepo("root-sub-parent"), "app"));
  git(parent, "submodule", "add", "-q", lib, "vendor/lib");
  builtRepo(parent);
  const deep = join(parent, "vendor", "lib", "src");

  assert.deepEqual(nearestGraftRoot(deep), { root: parent, levels: 3 }, "the submodule must not bound the walk");
});

test("a submodule of an UNBUILT superproject resolves to the submodule, not the superproject", () => {
  const lib = committedRepo(join(tmpRepo("root-sub-lib2"), "lib"));
  const parent = committedRepo(join(tmpRepo("root-sub-parent2"), "app"));
  git(parent, "submodule", "add", "-q", lib, "vendor/lib");
  const sub = join(parent, "vendor", "lib");

  assert.deepEqual(nearestGraftRoot(join(sub, "src")), { root: sub, levels: 1 }, "`build` in a submodule means the submodule");
});

test("a nested standalone clone (`.git` directory) inside a built repo still stops the walk", () => {
  const parent = builtRepo(committedRepo(join(tmpRepo("root-nested"), "app")));
  const child = committedRepo(join(parent, "toolforge"));

  assert.deepEqual(nearestGraftRoot(join(child, "src")), { root: child, levels: 1 });
});

test("a linked worktree inside a built repo stops at itself, not the main checkout's graph", () => {
  const parent = builtRepo(committedRepo(join(tmpRepo("root-wt"), "app")));
  const wt = join(parent, ".claude", "worktrees", "wt");
  git(parent, "worktree", "add", "-q", "-b", "wt", wt);

  assert.deepEqual(nearestGraftRoot(join(wt, "src")), { root: wt, levels: 1 });
});

test("nothing indexed anywhere above → the start dir, so `build` in a fresh repo still means here", () => {
  const fresh = tmpRepo("root-none");
  const deep = join(fresh, "a", "b");
  mkdirSync(deep, { recursive: true });

  assert.deepEqual(nearestGraftRoot(deep), { root: deep, levels: 0 });
});

test("an explicit --dir override short-circuits the walk", () => {
  const repo = builtRepo(tmpRepo("root-override"));
  const deep = join(repo, "src");
  mkdirSync(deep, { recursive: true });

  // `contextDirFor` returns an override verbatim and ignores the root it is
  // handed, so every ancestor would look equally indexed — the walk can only
  // mislead here.
  assert.deepEqual(nearestGraftRoot(deep, join(repo, "graft")), { root: deep, levels: 0 });
});

test("a symlink to a built repo is a graft root at the symlink path, not the physical target (#143)", () => {
  // Query-root walking is not the place we unwrap a build input. existsSync
  // follows the link, so the index is visible, but the returned root stays the
  // caller-facing path — the same stability walkDir keeps for emitted files.
  const repo = builtRepo(tmpRepo("root-symlink-real"));
  const link = join(tmpRepo("root-symlink-wrap"), "via-link");
  symlinkSync(repo, link, process.platform === "win32" ? "junction" : "dir");

  assert.ok(hasGraftIndex(link), "the wiring files are visible through the symlink");
  assert.deepEqual(nearestGraftRoot(link), { root: resolve(link), levels: 0 });
  assert.notEqual(resolve(link), repo);
});
