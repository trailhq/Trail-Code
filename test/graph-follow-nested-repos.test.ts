import { execFileSync } from "node:child_process";
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fingerprintPath, isClean, probeDrift, readFingerprint } from "../src/graph/fingerprint.js";
import { readGraph, wiringPath } from "../src/graph/write.js";
import { readBuildConfig } from "../src/util/state.js";
import type { GraphV1 } from "../src/graph/types.js";
import { runCli, tmpRepo } from "./helpers.js";
import { ensureFreshGraph } from "../src/graph/refresh.js";

function gitRun(root: string, args: string[]): void {
  execFileSync("git", args, { cwd: root, stdio: "ignore" });
}

function commitAll(root: string, message: string): void {
  gitRun(root, ["add", "-A"]);
  gitRun(root, [
    "-c", "user.name=Graft Tests",
    "-c", "user.email=graft-tests@example.invalid",
    "commit", "-qm", message,
  ]);
}

function graphOf(root: string): GraphV1 {
  const graph = readGraph(wiringPath(join(root, "graft")));
  assert.ok(graph, `expected a graph for ${root}`);
  return graph;
}

function expectCliOk(args: string[]): void {
  const result = runCli(args);
  assert.equal(result.status, 0, result.describe());
}

function write(root: string, rel: string, body: string): void {
  const abs = join(root, rel);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, body);
}

/**
 * A multi-repo manifest checkout clones dependencies into the parent tree as
 * ORDINARY repos, with no gitlink and no index entry — so `followSubmodules`
 * can never reach them. Built here with a plain `git init` inside the parent.
 */
test("follow-nested-repos is opt-in, persisted, reversible, and does not mistake a plain untracked dir for a repo", () => {
  const parent = tmpRepo("follow-nested-parent");
  try {
    gitRun(parent, ["init", "-q"]);
    write(parent, "src/root.ts", "export const rootValue = 1;\n");
    // A plain untracked directory: git expands it file by file, so it must NOT
    // trip the trailing-slash heuristic. This is the regression guard.
    write(parent, "plain/a.ts", "export const plainValue = 1;\n");
    write(parent, "plain/deep/b.ts", "export const deepPlainValue = 1;\n");
    // A directory that looks like a checkout but has no .git — must be skipped,
    // not recursed. Git expands it too (it is not a repo), so its files land in
    // the graph the ordinary way.
    write(parent, "external/not_a_repo/c.ts", "export const notARepoValue = 1;\n");
    commitAll(parent, "parent fixture");

    // Two nested clones, the second importing from the first — the cross-repo
    // edge is the whole point of folding them into ONE graph rather than
    // federating them into N disjoint ones.
    const depA = join(parent, "external", "dep_a");
    mkdirSync(depA, { recursive: true });
    gitRun(depA, ["init", "-q"]);
    write(depA, "src/api.ts", "export function depAValue(): number { return 1; }\n");
    write(depA, "build/generated.ts", "export const generatedValue = 1;\n");
    commitAll(depA, "dep_a fixture");

    const depB = join(parent, "external", "dep_b");
    mkdirSync(depB, { recursive: true });
    gitRun(depB, ["init", "-q"]);
    write(
      depB,
      "src/consumer.ts",
      'import { depAValue } from "../../dep_a/src/api.js";\n' +
        "export function depBValue(): number { return depAValue(); }\n",
    );
    commitAll(depB, "dep_b fixture");

    // 1. Default build excludes both nested clones and keeps everything else.
    expectCliOk(["build", parent]);
    const def = graphOf(parent);
    assert.ok(def.nodes.some((n) => n.path === "src/root.ts"));
    assert.ok(def.nodes.some((n) => n.path === "plain/a.ts"), "a plain untracked dir must still be expanded");
    assert.ok(def.nodes.some((n) => n.path === "plain/deep/b.ts"));
    assert.ok(def.nodes.some((n) => n.path === "external/not_a_repo/c.ts"));
    assert.ok(!def.nodes.some((n) => n.path.startsWith("external/dep_a/")));
    assert.ok(!def.nodes.some((n) => n.path.startsWith("external/dep_b/")));
    assert.equal(
      existsSync(join(parent, ".graft", "config.json")),
      false,
      "an implicit default must not create local config",
    );

    // 2. Opt in: both clones are indexed, into the SAME graph, and the choice
    //    is persisted. SKIP_DIRS still applies inside the child (build/).
    expectCliOk(["build", parent, "--follow-nested-repos"]);
    const enabled = graphOf(parent);
    assert.ok(enabled.nodes.some((n) => n.id === "external/dep_a/src/api.ts#depAValue"));
    assert.ok(enabled.nodes.some((n) => n.id === "external/dep_b/src/consumer.ts#depBValue"));
    assert.ok(
      !enabled.nodes.some((n) => n.path.startsWith("external/dep_a/build/")),
      "SKIP_DIRS must still apply inside a followed nested repo",
    );
    assert.deepEqual(readBuildConfig(parent), { followNestedRepos: true });
    assert.ok(isClean(probeDrift(parent, join(parent, "graft"))!));

    // 3. The cross-repo edge: one graph, so dep_b's import resolves into dep_a.
    assert.ok(
      enabled.edges.some(
        (e) =>
          e.relation === "imports" &&
          e.source === "external/dep_b/src/consumer.ts" &&
          e.target === "external/dep_a/src/api.ts",
      ),
      "an import crossing two nested repos must resolve to an in-graph edge",
    );

    // 4. A later no-flag rebuild retains the opt-in — the contract the
    //    fingerprint probe and the MCP refresh path depend on.
    expectCliOk(["build", parent]);
    assert.ok(
      graphOf(parent).nodes.some((n) => n.id === "external/dep_a/src/api.ts#depAValue"),
      "a no-flag build must retain the persisted opt-in",
    );

    // 5. Explicitly reversible, and likewise persisted.
    expectCliOk(["build", parent, "--no-follow-nested-repos"]);
    assert.ok(!graphOf(parent).nodes.some((n) => n.path.startsWith("external/dep_a/")));
    assert.deepEqual(readBuildConfig(parent), { followNestedRepos: false });
    assert.ok(isClean(probeDrift(parent, join(parent, "graft"))!));

    expectCliOk(["build", parent]);
    assert.ok(!graphOf(parent).nodes.some((n) => n.path.startsWith("external/dep_a/")));
    assert.deepEqual(readBuildConfig(parent), { followNestedRepos: false });
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

/** The two opt-ins are independent: neither implies the other. */
test("follow-nested-repos and follow-submodules are independent switches", () => {
  const parent = tmpRepo("follow-nested-mixed-parent");
  const sub = tmpRepo("follow-nested-mixed-sub");
  try {
    gitRun(sub, ["init", "-q"]);
    write(sub, "src/sub.ts", "export function subValue(): number { return 1; }\n");
    commitAll(sub, "submodule fixture");

    gitRun(parent, ["init", "-q"]);
    write(parent, "src/root.ts", "export const rootValue = 1;\n");
    commitAll(parent, "parent fixture");
    gitRun(parent, [
      "-c", "protocol.file.allow=always",
      "submodule", "add", "-q", sub.replace(/\\/g, "/"), "modules/sub",
    ]);
    commitAll(parent, "add submodule");

    const nested = join(parent, "external", "dep");
    mkdirSync(nested, { recursive: true });
    gitRun(nested, ["init", "-q"]);
    write(nested, "src/dep.ts", "export function depValue(): number { return 1; }\n");
    commitAll(nested, "nested fixture");

    // Nested only: the gitlink stays outside the boundary.
    expectCliOk(["build", parent, "--follow-nested-repos"]);
    const nestedOnly = graphOf(parent);
    assert.ok(nestedOnly.nodes.some((n) => n.id === "external/dep/src/dep.ts#depValue"));
    assert.ok(!nestedOnly.nodes.some((n) => n.path.startsWith("modules/sub/")));

    // Submodules only: the nested clone stays outside the boundary.
    expectCliOk(["build", parent, "--no-follow-nested-repos", "--follow-submodules"]);
    const g = graphOf(parent);
    assert.ok(g.nodes.some((n) => n.id === "modules/sub/src/sub.ts#subValue"));
    assert.ok(!g.nodes.some((n) => n.path.startsWith("external/dep/")));
    assert.deepEqual(readBuildConfig(parent), {
      followNestedRepos: false,
      followSubmodules: true,
    });

    // Both: one graph spanning both kinds of boundary.
    expectCliOk(["build", parent, "--follow-nested-repos"]);
    const both = graphOf(parent);
    assert.ok(both.nodes.some((n) => n.id === "modules/sub/src/sub.ts#subValue"));
    assert.ok(both.nodes.some((n) => n.id === "external/dep/src/dep.ts#depValue"));

    // Explicit admission bypasses parent ignores, never the submodule gate.
    expectCliOk(["build", parent, "--include-repo", "modules/sub", "--no-follow-submodules"]);
    assert.ok(!graphOf(parent).nodes.some((n) => n.path.startsWith("modules/sub/")));
    expectCliOk(["build", parent]);
    assert.ok(!graphOf(parent).nodes.some((n) => n.path.startsWith("modules/sub/")));
    expectCliOk(["build", parent, "--follow-submodules"]);
    assert.ok(graphOf(parent).nodes.some((n) => n.id === "modules/sub/src/sub.ts#subValue"));
  } finally {
    rmSync(parent, { recursive: true, force: true });
    rmSync(sub, { recursive: true, force: true });
  }
});

test("linked repos build and refresh one queryable graph at the parent, including a linked worktree", async () => {
  const parent = tmpRepo("linked-graph-parent");
  const library = tmpRepo("linked-graph-library");
  const checkout = tmpRepo("linked-graph-checkout");
  const worktree = join(checkout, "worktree");
  try {
    gitRun(parent, ["init", "-q"]);
    gitRun(library, ["init", "-q"]);
    write(library, "src/api.ts", "export function linkedValue(): number { return 1; }\n");
    commitAll(library, "library fixture");
    gitRun(library, ["worktree", "add", "--detach", worktree]);
    write(worktree, "src/consumer.ts", 'import { linkedValue } from "../../library/src/api.js";\nexport function linkedConsumer() { return linkedValue(); }\n');
    mkdirSync(join(parent, "repos"));
    const linkType = process.platform === "win32" ? "junction" : "dir";
    symlinkSync(library, join(parent, "repos", "library"), linkType);
    symlinkSync(worktree, join(parent, "repos", "consumer"), linkType);

    expectCliOk(["build", parent, "--follow-nested-repos"]);
    const graph = graphOf(parent);
    assert.ok(graph.nodes.some((n) => n.id === "repos/library/src/api.ts#linkedValue"));
    assert.ok(graph.nodes.some((n) => n.id === "repos/consumer/src/consumer.ts#linkedConsumer"));
    assert.ok(graph.edges.some((e) => e.relation === "imports" && e.source === "repos/consumer/src/consumer.ts" && e.target === "repos/library/src/api.ts"));
    assert.equal(existsSync(join(parent, "graft", "workspace.json")), false, "the parent owns a single graph");
    assert.equal(existsSync(join(library, "graft")), false, "the linked target needs no separate index");
    assert.deepEqual(readBuildConfig(parent), { followNestedRepos: true });
    assert.ok(isClean(probeDrift(parent, join(parent, "graft"))!));

    const query = runCli(["ask", "linkedValue", parent, "--source"]);
    assert.equal(query.status, 0, query.describe());
    assert.match(query.stdout, /repos\/library\/src\/api\.ts/);
    write(library, "src/added.ts", "export function addedLinkedValue() { return 2; }\n");
    assert.ok(probeDrift(parent, join(parent, "graft"))!.added.includes("repos/library/src/added.ts"));
    assert.equal((await ensureFreshGraph(parent)).refreshed, true, "automatic refresh follows the saved option");
    assert.ok(graphOf(parent).nodes.some((n) => n.id === "repos/library/src/added.ts#addedLinkedValue"));

    expectCliOk(["build", parent]);
    assert.ok(graphOf(parent).nodes.some((n) => n.id === "repos/library/src/added.ts#addedLinkedValue"));
    expectCliOk(["build", parent, "--no-follow-nested-repos"]);
    assert.equal(graphOf(parent).nodes.length, 0);
  } finally {
    rmSync(parent, { recursive: true, force: true });
    rmSync(checkout, { recursive: true, force: true });
    rmSync(library, { recursive: true, force: true });
  }
});

test("explicit ignored repository mounts preserve parent and child ignores and refresh only selected repos", async () => {
  const parent = tmpRepo("ignored-links-parent");
  const targets = [tmpRepo("ignored-widget"), tmpRepo("ignored-api"), tmpRepo("ignored-other")];
  const names = ["widget", "databraid-api", "other"];
  const selected = names.slice(0, 2).map((name) => `source-material/historical-repos/${name}`);
  const whitelist = selected.flatMap((path) => ["--only-dir", path]);
  const ignore = "/source-material/\n/graft/\n/.graft/\n";
  try {
    gitRun(parent, ["init", "-q"]);
    write(parent, ".gitignore", ignore);
    write(parent, "root.ts", "export const excludedRoot = 1;\n");
    mkdirSync(join(parent, "source-material", "historical-repos"), { recursive: true });
    for (const [i, target] of targets.entries()) {
      gitRun(target, ["init", "-q"]);
      write(target, ".gitignore", "*.generated.ts\n");
      write(target, "src/value.ts", `export function value${i}() { return ${i}; }\n`);
      write(target, "src/ignored.generated.ts", "export const ignoredValue = 1;\n");
      symlinkSync(target, join(parent, "source-material", "historical-repos", names[i]), process.platform === "win32" ? "junction" : "dir");
    }
    expectCliOk(["build", parent, "--follow-nested-repos", ...whitelist]);
    assert.equal(graphOf(parent).nodes.length, 0, "parent ignores remain authoritative without an explicit override");
    expectCliOk(["build", parent, "--include-ignored-repos", ...whitelist]);
    const graph = graphOf(parent);
    assert.ok(graph.nodes.some((n) => n.id === `${selected[0]}/src/value.ts#value0`));
    assert.ok(graph.nodes.some((n) => n.id === `${selected[1]}/src/value.ts#value1`));
    assert.ok(graph.nodes.every((n) => selected.some((path) => n.path.startsWith(`${path}/`))));
    assert.ok(!graph.nodes.some((n) => n.path.endsWith("ignored.generated.ts")), "the child ignore rules still apply");
    assert.equal(readFileSync(join(parent, ".gitignore"), "utf8"), ignore);
    assert.deepEqual(readBuildConfig(parent), { followNestedRepos: true, includeIgnoredRepos: selected });
    assert.ok(isClean(probeDrift(parent, join(parent, "graft"))!));

    write(targets[0], "src/added.ts", "export function addedIgnoredMountValue() { return 5; }\n");
    assert.equal((await ensureFreshGraph(parent)).refreshed, true);
    assert.ok(graphOf(parent).nodes.some((n) => n.id === `${selected[0]}/src/added.ts#addedIgnoredMountValue`));
    assert.ok(graphOf(parent).nodes.every((n) => selected.some((path) => n.path.startsWith(`${path}/`))));

    expectCliOk(["build", parent]);
    assert.ok(graphOf(parent).nodes.some((n) => n.id === `${selected[0]}/src/added.ts#addedIgnoredMountValue`));
    assert.ok(graphOf(parent).nodes.every((n) => selected.some((path) => n.path.startsWith(`${path}/`))), "a plain rebuild keeps only the selected repos");
    expectCliOk(["build", parent, "--no-follow-nested-repos", ...whitelist]);
    assert.equal(graphOf(parent).nodes.length, 0);
    expectCliOk(["build", parent, "--follow-nested-repos", "--no-include-ignored-repos", ...whitelist]);
    assert.equal(graphOf(parent).nodes.length, 0);
    assert.deepEqual(readBuildConfig(parent)?.includeIgnoredRepos, []);

    const repoFlags = selected.flatMap((path) => ["--include-repo", path]);
    expectCliOk(["build", parent, "--all-dirs", ...repoFlags]);
    const combined = graphOf(parent);
    assert.ok(combined.nodes.some((n) => n.path === "root.ts"), "normal project source is indexed alongside selected repos");
    assert.ok(combined.nodes.some((n) => n.path === `${selected[0]}/src/value.ts`));
    assert.ok(combined.nodes.some((n) => n.path === `${selected[1]}/src/value.ts`));
    assert.ok(!combined.nodes.some((n) => n.path.includes("historical-repos/other/")));
    assert.ok(!combined.nodes.some((n) => n.path.endsWith("ignored.generated.ts")));
    write(parent, "src/added.ts", "export const newProjectValue = 10;\n");
    write(targets[1], "src/added.ts", "export const newReferenceValue = 20;\n");
    assert.equal((await ensureFreshGraph(parent)).refreshed, true);
    assert.ok(graphOf(parent).nodes.some((n) => n.path === "src/added.ts"));
    assert.ok(graphOf(parent).nodes.some((n) => n.path === `${selected[1]}/src/added.ts`));
    expectCliOk(["build", parent]);
    assert.ok(graphOf(parent).nodes.some((n) => n.path === "root.ts"));
    assert.ok(graphOf(parent).nodes.some((n) => n.path === `${selected[0]}/src/value.ts`));

    for (const args of [
      ["build", parent, "--include-ignored-repos"],
      ["build", parent, "--include-ignored-repos", "--only-dir", "source-material"],
      ["build", parent, "--include-ignored-repos", "--only-dir", `../${targets[0].split(/[\\/]/).pop()}`],
    ]) {
      const result = runCli(args);
      assert.equal(result.status, 1, result.describe());
      assert.match(result.stderr, /include-ignored-repos/);
    }
    for (const args of [
      ["build", parent, "--all-dirs", "--only-dir", "src"],
      ["build", parent, "--include-repo", "source-material"],
      ["build", parent, "--include-repo", selected[0], "--no-include-ignored-repos"],
      ["build", parent, "--include-repo", selected[0], "--no-follow-nested-repos"],
    ]) {
      const result = runCli(args);
      assert.equal(result.status, 1, result.describe());
    }
    assert.equal(readFileSync(join(parent, ".gitignore"), "utf8"), ignore);
  } finally {
    rmSync(parent, { recursive: true, force: true });
    for (const target of targets) rmSync(target, { recursive: true, force: true });
  }
});

for (const ignored of [false, true]) {
  test(`refresh detects retargeted ${ignored ? "explicit ignored" : "visible"} repository links with identical file stats`, async () => {
    const parent = tmpRepo("retarget-parent");
    const targets = [tmpRepo("retarget-before"), tmpRepo("retarget-after")];
    const mount = join(parent, "refs", "library");
    const linkType = process.platform === "win32" ? "junction" : "dir";
    try {
      gitRun(parent, ["init", "-q"]);
      write(parent, "root.ts", "export const rootValue = 1;\n");
      if (ignored) write(parent, ".gitignore", "/refs/\n");
      for (const [i, target] of targets.entries()) {
        gitRun(target, ["init", "-q"]);
        write(target, "value.ts", `export function ${i ? "after" : "prior"}() { return 1; }\n`);
        utimesSync(join(target, "value.ts"), 1_700_000_000, 1_700_000_000);
      }
      mkdirSync(join(parent, "refs"));
      symlinkSync(targets[0], mount, linkType);
      expectCliOk(["build", parent, "--follow-nested-repos", ...(ignored ? ["--include-repo", "refs/library"] : [])]);
      assert.ok(graphOf(parent).nodes.some((n) => n.id === "refs/library/value.ts#prior"));
      assert.ok(isClean(probeDrift(parent, join(parent, "graft"))!));
      assert.equal((await ensureFreshGraph(parent)).refreshed, false);

      unlinkSync(mount);
      symlinkSync(targets[1], mount, linkType);
      const drift = probeDrift(parent, join(parent, "graft"));
      assert.ok(drift === null || !isClean(drift), "a new checkout cannot inherit the old stat fast path");
      assert.equal((await ensureFreshGraph(parent)).refreshed, true);
      const graph = graphOf(parent);
      assert.ok(graph.nodes.some((n) => n.id === "refs/library/value.ts#after"));
      assert.ok(!graph.nodes.some((n) => n.id === "refs/library/value.ts#prior"));
      assert.ok(graph.nodes.some((n) => n.path === "root.ts"));
      assert.equal((await ensureFreshGraph(parent)).refreshed, false, "the new identity is persisted");

      // Old fingerprints still retain their filters but need one identity-aware rebuild.
      const outDir = join(parent, "graft");
      const legacy = readFingerprint(outDir)!;
      delete legacy.repositoryTargets;
      writeFileSync(fingerprintPath(outDir), JSON.stringify(legacy));
      assert.equal((await ensureFreshGraph(parent)).refreshed, true);
      assert.equal((await ensureFreshGraph(parent)).refreshed, false);
    } finally {
      rmSync(parent, { recursive: true, force: true });
      for (const target of targets) rmSync(target, { recursive: true, force: true });
    }
  });
}
