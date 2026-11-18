import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { runSync } from "../src/claude/sync-run.js";
import { buildGraph } from "../src/graph/build.js";
import { checkGraph } from "../src/graph/check.js";
import { fingerprintPath, isClean, probeDrift, readFingerprint } from "../src/graph/fingerprint.js";
import { ensureFreshGraph } from "../src/graph/refresh.js";
import { readGraph, wiringPath } from "../src/graph/write.js";
import { readStats } from "../src/util/state.js";
import { patchStats } from "../src/claude/state.js";
import { workspaceStats } from "../src/claude/stats.js";
import { readWorkspace, writeWorkspace } from "../src/graph/workspace.js";
import { callTool } from "../src/mcp/tools.js";
import { homeEnv, runCli, tmpRepo } from "./helpers.js";

function mixedRepo(): string {
  const dir = tmpRepo("extensions");
  writeFileSync(join(dir, "main.go"), "package main\nfunc main() {}\n");
  writeFileSync(join(dir, "widget.ts"), "export function widget() { return 1; }\n");
  return dir;
}

function paths(dir: string): string[] {
  const graph = readGraph(wiringPath(join(dir, "graft")));
  assert.ok(graph, "expected a built graph");
  return graph.nodes.filter((n) => n.kind === "file").map((n) => n.path).sort();
}

function invalidateExtractor(dir: string): void {
  const path = fingerprintPath(join(dir, "graft"));
  const fingerprint = JSON.parse(readFileSync(path, "utf8"));
  fingerprint.extractor = "prior-extractor";
  writeFileSync(path, JSON.stringify(fingerprint));
}

test("graph checks retain extension scope after an extractor change", async () => {
  const dir = mixedRepo();
  try {
    await buildGraph(dir, { extensions: [".go"] });
    invalidateExtractor(dir);
    assert.equal(readFingerprint(join(dir, "graft")), null);
    assert.equal((await checkGraph(dir)).ok, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("automatic refresh retains extension scope after an extractor change", async () => {
  const dir = mixedRepo();
  try {
    await buildGraph(dir, { extensions: [".go"] });
    invalidateExtractor(dir);
    assert.equal((await ensureFreshGraph(dir)).refreshed, true);
    assert.deepEqual(paths(dir), ["main.go"]);
    assert.deepEqual(readGraph(wiringPath(join(dir, "graft")))?.meta.extensions, [".go"]);
    await buildGraph(dir);
    assert.equal(readGraph(wiringPath(join(dir, "graft")))?.meta.extensions, undefined);
    assert.deepEqual(paths(dir), ["main.go", "widget.ts"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a query's rebuild child gets the saved extension selection", async () => {
  const dir = mixedRepo();
  const stub = join(dir, "refresh-run-stub.mjs");
  const log = join(dir, "refresh-runs.log");
  writeFileSync(stub, `import { appendFileSync } from "node:fs";\nappendFileSync(${JSON.stringify(log)}, process.argv[2] + "\\n");\n`);
  try {
    await buildGraph(dir, { extensions: [".go"] });
    writeFileSync(join(dir, "main.go"), "package main\nfunc main() {}\nfunc other() {}\n");
    process.env.GRAFT_TEST_REFRESH_RUN = stub;
    assert.equal((await ensureFreshGraph(dir)).refreshed, true);
    const runs = readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.deepEqual(runs, [{ dir, extensions: [".go"] }]);
  } finally {
    delete process.env.GRAFT_TEST_REFRESH_RUN;
    rmSync(dir, { recursive: true, force: true });
  }
});

for (const extension of [".go", "go", ".GO"]) {
  test(`build --extensions ${extension} limits the structural graph`, () => {
    const dir = mixedRepo();
    const home = tmpRepo("extensions-home");
    try {
      const result = runCli(["build", dir, "--extensions", extension], { home });
      assert.equal(result.status, 0, result.describe());
      assert.deepEqual(paths(dir), ["main.go"]);
      assert.deepEqual(readFingerprint(join(dir, "graft"))?.extensions, [".go"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });
}

test("extension filtering survives checks and automatic refresh", async () => {
  const dir = mixedRepo();
  const out = join(dir, "graft");
  try {
    await buildGraph(dir, { extensions: ["go"] });
    assert.deepEqual(paths(dir), ["main.go"]);
    assert.ok(isClean(probeDrift(dir, out)!));
    assert.equal((await checkGraph(dir)).ok, true);

    writeFileSync(join(dir, "widget.ts"), "export const excludedEdit = 2;\n");
    writeFileSync(join(dir, "new.ts"), "export const excludedAddition = 3;\n");
    assert.ok(isClean(probeDrift(dir, out)!), "excluded edits and additions are not drift");
    assert.equal((await ensureFreshGraph(dir)).refreshed, false);
    assert.equal((await checkGraph(dir)).ok, true);

    writeFileSync(join(dir, "main.go"), "package main\nfunc main() {}\nfunc added() {}\n");
    assert.deepEqual(probeDrift(dir, out)?.changed, ["main.go"]);
    assert.equal((await checkGraph(dir)).ok, false);
    assert.equal((await ensureFreshGraph(dir)).refreshed, true);
    assert.deepEqual(paths(dir), ["main.go"]);
    assert.deepEqual(readFingerprint(out)?.extensions, [".go"]);
    assert.ok(isClean(probeDrift(dir, out)!));
    assert.equal((await checkGraph(dir)).ok, true);

    // An explicit build without a filter restores the default full file set.
    await buildGraph(dir);
    assert.deepEqual(paths(dir), ["main.go", "new.ts", "widget.ts"]);
    assert.equal(readFingerprint(out)?.extensions, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("extension filters combine with onlyDirs and do not admit unsupported files", async () => {
  const dir = mixedRepo();
  try {
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "src", "keep.ts"), "export const keep = 1;\n");
    writeFileSync(join(dir, "src", "skip.go"), "package skip\nfunc Skip() {}\n");
    writeFileSync(join(dir, "src", "notes.unknown"), "not source\n");
    await buildGraph(dir, { onlyDirs: ["src"], extensions: ["TS", ".unknown"] });
    assert.deepEqual(paths(dir), ["src/keep.ts"]);
    assert.ok(isClean(probeDrift(dir, join(dir, "graft"))!));
    assert.equal((await checkGraph(dir)).ok, true);

    await buildGraph(dir, { extensions: [".unknown"] });
    assert.deepEqual(paths(dir), [], "an unsupported-only selection must not index everything");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("workspace builds forward the extension filter to every child graph", () => {
  const parent = tmpRepo("extensions-workspace");
  const home = tmpRepo("extensions-workspace-home");
  try {
    for (const name of ["one", "two"]) {
      const dir = join(parent, name);
      mkdirSync(join(dir, ".git"), { recursive: true });
      writeFileSync(join(dir, "main.go"), "package main\nfunc main() {}\n");
      writeFileSync(join(dir, "widget.ts"), "export const widget = 1;\n");
    }
    const result = runCli(["build", parent, "--extensions", ".go"], { home });
    assert.equal(result.status, 0, result.describe());
    for (const name of ["one", "two"]) assert.deepEqual(paths(join(parent, name)), ["main.go"]);
  } finally {
    rmSync(parent, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

for (const override of [false, true]) {
  test(`workspace background sync retains child selections (parent override: ${override})`, () => {
    const parent = tmpRepo("extensions-sync-workspace");
    const home = tmpRepo("extensions-sync-home");
    const parentOut = override ? join(parent, "parent-map") : undefined;
    const envBefore = { ...process.env };
    try {
      for (const name of ["one", "two", "three"]) {
        const dir = join(parent, name);
        mkdirSync(join(dir, ".git"), { recursive: true });
        writeFileSync(join(dir, "main.go"), "package main\nfunc main() {}\n");
        writeFileSync(join(dir, "widget.ts"), "export const widget = 1;\n");
      }
      const initial = runCli([...(parentOut ? ["--dir", parentOut] : []), "build", parent, "--extensions", ".go"], { home });
      assert.equal(initial.status, 0, initial.describe());
      for (const [name, extra] of [["two", ["--extensions", ".ts"]], ["three", []]] as const) {
        const result = runCli(["build", join(parent, name), ...extra], { home });
        assert.equal(result.status, 0, result.describe());
      }
      writeFileSync(join(parent, "one", "main.go"), "package main\nfunc AfterSync() {}\n");
      // Sync previously rediscovered workspace members through the CLI. Preserve
      // that behavior for new children while retaining selections of existing ones.
      mkdirSync(join(parent, "four", ".git"), { recursive: true });
      writeFileSync(join(parent, "four", "new.ts"), "export const newChild = 1;\n");

      // The default sync really invokes the CLI; this source runner only supplies
      // tsx when the child starts outside the package, just like runCli does above.
      const shim = join(home, "cli.cjs");
      const tsx = pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href;
      writeFileSync(shim, `require('node:child_process').execFileSync(process.execPath,
        ${JSON.stringify(["--import", tsx, resolve("src/cli.ts")])}.concat(process.argv.slice(2)),
        { stdio: 'inherit' });`);
      Object.assign(process.env, homeEnv(home), { GRAFT_TEST_CLI: shim });
      if (parentOut) process.env.GRAFT_DIR = parentOut;
      else delete process.env.GRAFT_DIR;
      runSync(parent);
      assert.ok(readGraph(wiringPath(join(parent, "one", "graft")))?.nodes.some((n) => n.name === "AfterSync"),
        "the background build must actually index the edit");
      assert.deepEqual(paths(join(parent, "one")), ["main.go"]);
      assert.deepEqual(paths(join(parent, "two")), ["widget.ts"]);
      assert.deepEqual(paths(join(parent, "three")), ["main.go", "widget.ts"]);
      assert.deepEqual(paths(join(parent, "four")), ["new.ts"]);
      assert.deepEqual(readWorkspace(parent, parentOut)?.children, ["four", "one", "three", "two"]);
    } finally {
      for (const name of ["HOME", "USERPROFILE", "GRAFT_DIR", "GRAFT_TEST_CLI"]) {
        if (envBefore[name] === undefined) delete process.env[name];
        else process.env[name] = envBefore[name];
      }
      rmSync(parent, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });
}

test("filtering source extensions preserves Go module metadata for import resolution", async () => {
  const dir = mixedRepo();
  try {
    mkdirSync(join(dir, "store"));
    writeFileSync(join(dir, "go.mod"), "module example.com/app\n\ngo 1.21\n");
    writeFileSync(join(dir, "main.go"), 'package main\nimport "example.com/app/store"\nfunc main() { store.New() }\n');
    writeFileSync(join(dir, "store", "store.go"), "package store\nfunc New() int { return 1 }\n");
    await buildGraph(dir, { extensions: [".go"] });
    assert.deepEqual(paths(dir), ["main.go", "store/store.go"]);
    const graph = readGraph(wiringPath(join(dir, "graft")))!;
    assert.ok(graph.edges.some((e) => e.relation === "imports" &&
      e.source === "main.go" && e.target === "store/store.go"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("MCP retrieval discloses extension scope for clean and zero-hit results", async () => {
  const dir = mixedRepo();
  try {
    writeFileSync(join(dir, "widget.ts"), "export const onlyExcluded = 1;\n");
    await buildGraph(dir, { extensions: [".go"] });
    for (const [name, args] of [
      ["graft_find_all", { pattern: "onlyExcluded" }],
      ["graft_find_code", { query: "main" }],
      ["graft_file_api", { file: "main.go" }],
      ["graft_trace_calls", { symbol: "main" }],
      ["graft_repo_map", {}],
      ["graft_check_freshness", {}],
    ] as const) {
      const result = await callTool(dir, name, args);
      assert.equal(result.isError, false, result.text);
      assert.match(result.text, /Indexed extensions: \.go\./, name);
      assert.match(result.text, /ordinary source search/, name);
    }
    const zero = await callTool(dir, "graft_find_all", { pattern: "onlyExcluded" });
    assert.match(zero.text, /no hits/i);
    assert.match(zero.text, /Indexed extensions: \.go\./);
    assert.ok(isClean(probeDrift(dir, join(dir, "graft"))!));
    await buildGraph(dir);
    const all = await callTool(dir, "graft_find_all", { pattern: "onlyExcluded" });
    assert.match(all.text, /widget\.ts/);
    assert.doesNotMatch(all.text, /Indexed extensions:/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("MCP workspace retrieval names each child's extension scope", async () => {
  const parent = tmpRepo("extensions-mcp-workspace");
  try {
    const children = ["one", "two", "three"];
    for (const [index, name] of children.entries()) {
      const dir = join(parent, name);
      mkdirSync(dir);
      writeFileSync(join(dir, "main.go"), "package main\nfunc main() {}\n");
      writeFileSync(join(dir, "widget.ts"), `export const ${index === 0 ? "onlyExcluded" : "widget"} = 1;\n`);
      await buildGraph(dir, { extensions: [[".go"], [".ts"], undefined][index] });
    }
    writeWorkspace(parent, { version: 1, children });
    const result = await callTool(parent, "graft_find_all", { pattern: "onlyExcluded" });
    assert.equal(result.isError, false, result.text);
    assert.match(result.text, /no hits/i);
    assert.match(result.text, /one\/: \.go/);
    assert.match(result.text, /two\/: \.ts/);
    assert.match(result.text, /three\/: all supported/);
    assert.match(result.text, /ordinary source search/);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});


/*
 * Issue #433, adversarial. "Totals equal the sum" alone would just restate the
 * implementation's arithmetic. Every stage below attacks the design instead:
 * the sync child must merge totals, never revert them to zeros; a corrupt child
 * must degrade the aggregate without NaN; the sync's rebuild must repair the
 * corruption; a drifting child must move the totals by exactly its real delta;
 * inflated stale numbers must not survive; and a child leaving the workspace
 * must take its counts with it.
 */
test("workspace totals track reality through syncs, corruption, drift and removal (#433)", () => {
  const parent = tmpRepo("workspace-stats");
  const home = tmpRepo("workspace-stats-home");
  try {
    /* Deliberately DIFFERENT languages per child: a union check only means
     * something when no single child already holds the union. */
    const one = join(parent, "one");
    const two = join(parent, "two");
    mkdirSync(join(one, ".git"), { recursive: true });
    writeFileSync(join(one, "main.go"), "package main\nfunc main() {}\n");
    mkdirSync(join(two, ".git"), { recursive: true });
    writeFileSync(join(two, "widget.ts"), "export const widget = 1;\n");
    const result = runCli(["build", parent], { home });
    assert.equal(result.status, 0, result.describe());

    /* runSync's default build spawns the installed CLI, which does not exist
     * in a source checkout (src/cli.js is a build artifact), so in tests it
     * would silently no-op its rebuild. What we are testing is the sync's own
     * semantics — its stats merge around a rebuild — so the rebuild itself is
     * injected here, through the same CLI entry the assertions above trust. */
    const rebuild = (dir: string): void => {
      const r = runCli(["build", dir], { home });
      assert.equal(r.status, 0, "the injected rebuild succeeds");
    };

    const stats = readStats(parent);
    assert.ok(stats, "workspace build writes the parent stats.json");
    const childGraphs = [one, two]
      .map((d) => readGraph(wiringPath(join(d, "graft"))))
      .filter((g) => g !== null);
    assert.equal(childGraphs.length, 2, "both children built");
    assert.equal(stats!.nodeCount, childGraphs.reduce((n, g) => n + g!.meta.nodeCount, 0), "node total = the children's real totals");
    assert.equal(stats!.edgeCount, childGraphs.reduce((n, g) => n + g!.meta.edgeCount, 0), "edge total ditto");
    assert.deepEqual([...stats!.languages].sort(), ["go", "typescript"], "the union of genuinely different children");
    assert.equal(stats!.dirty, false);
    assert.equal(stats!.syncing, false);

    /* ATTACK: the sync child runs after the build (its normal place in the
     * turn cycle). The old code patched flags-only here; the design claim is
     * that it MERGES totals. If that regresses, the statusline flips back to
     * "not built" on the first turn after every build. */
    runSync(parent, rebuild);
    const afterSync = readStats(parent)!;
    assert.equal(afterSync.nodeCount, stats!.nodeCount, "sync keeps the real totals — no revert to zeros");
    assert.deepEqual([...afterSync.languages].sort(), ["go", "typescript"]);
    assert.equal(afterSync.syncing, false);
    assert.ok(afterSync.syncedAt, "sync still stamps its own state");

    /* ATTACK: a child's wiring graph is corrupt garbage (a partial write, a
     * crash mid-build). The aggregate itself must skip it and report the
     * surviving child — no NaN, no crash on the hostile input. */
    writeFileSync(wiringPath(join(one, "graft")), "{not json at all");
    const degraded = workspaceStats(parent)!;
    const twoOnly = readGraph(wiringPath(join(two, "graft")))!;
    assert.equal(degraded.nodeCount, twoOnly.meta.nodeCount, "degrades to the surviving child");
    assert.ok(Number.isFinite(degraded.nodeCount) && Number.isFinite(degraded.edgeCount), "no NaN leaks into stats");

    /* ATTACK: the sync's rebuild now sees the corrupt graph — it must repair
     * the child and put BOTH children back into the aggregate. */
    runSync(parent, rebuild);
    const oneHealed = readGraph(wiringPath(join(one, "graft")))!;
    const healed = readStats(parent)!;
    assert.equal(healed.nodeCount, oneHealed.meta.nodeCount + twoOnly.meta.nodeCount, "the sync's rebuild repairs a corrupt child into the aggregate");

    /* ATTACK: real drift. A child grows by exactly one function; the totals
     * must move by that delta, not stay cached at the old numbers. */
    writeFileSync(join(one, "main.go"), "package main\nfunc main() {}\nfunc second(n int) int { return n }\n");
    runSync(parent, rebuild);
    const oneGrown = readGraph(wiringPath(join(one, "graft")))!;
    const grown = readStats(parent)!;
    assert.equal(grown.nodeCount, oneGrown.meta.nodeCount + twoOnly.meta.nodeCount, "totals track the drift");
    assert.ok(grown.nodeCount > healed.nodeCount, "the drift actually grew the total");

    /* ATTACK: inflated stale numbers (a previous bigger graph) must not
     * survive — the aggregate reports CURRENT reality, not max(old, new). */
    patchStats(parent, { nodeCount: 999_999, edgeCount: 888_888 });
    runSync(parent, rebuild);
    assert.equal(readStats(parent)!.nodeCount, oneGrown.meta.nodeCount + twoOnly.meta.nodeCount, "stale inflation is overwritten by the real aggregate");

    /* ATTACK: a child LEAVES the workspace — its directory is deleted. The
     * rebuild re-discovers the remaining git children (workspace.json is not
     * the source of membership), so the removed repo's counts must be gone
     * from the aggregate — no ghost repo. */
    rmSync(two, { recursive: true, force: true });
    runSync(parent, rebuild);
    assert.equal(readStats(parent)!.nodeCount, oneGrown.meta.nodeCount, "a removed child takes its counts out of the aggregate");
  } finally {
    rmSync(parent, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

/*
 * Issue #433: the aggregate must refuse to invent numbers on hostile inputs —
 * a listed child that does not exist, an empty workspace, and a wiring file
 * that parses as JSON but is not a graph shape. All three stay finite, and a
 * workspace with nothing readable reports null (the caller keeps its zeros
 * honestly) rather than a fabricated total.
 */
test("workspaceStats answers null or finite on hostile workspace shapes (#433)", () => {
  const parent = tmpRepo("workspace-stats-hostile");
  const home = tmpRepo("workspace-stats-hostile-home");
  try {
    const ghost = join(parent, "ghost");
    mkdirSync(join(ghost, ".git"), { recursive: true });
    /* a wiring file that is valid JSON but not a graph shape */
    mkdirSync(join(ghost, "graft", ".graph"), { recursive: true });
    writeFileSync(wiringPath(join(ghost, "graft")), "{\"foo\": 1}");

    writeWorkspace(parent, { version: 1, children: ["ghost"] });
    const weird = workspaceStats(parent, undefined);
    assert.ok(weird, "a readable-but-foreign graph still aggregates");
    assert.ok(Number.isFinite(weird!.nodeCount) && Number.isFinite(weird!.edgeCount) && Number.isFinite(weird!.totalCount), "all finite on a non-graph shape");
    assert.equal(weird!.nodeCount, 0, "no symbols invented from a foreign shape");

    /* a listed child with no directory at all: skipped, not crashed on */
    writeWorkspace(parent, { version: 1, children: ["ghost", "vanishes"] });
    assert.ok(workspaceStats(parent, undefined), "a missing child directory is skipped");

    /* nothing readable at all: null, so the caller keeps zeros honestly */
    writeWorkspace(parent, { version: 1, children: ["vanishes"] });
    assert.equal(workspaceStats(parent, undefined), null, "no readable graph means null, not invented zeros");

    /* an empty workspace: also null */
    writeWorkspace(parent, { version: 1, children: [] });
    assert.equal(workspaceStats(parent, undefined), null, "an empty workspace aggregates to null");
  } finally {
    rmSync(parent, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});
