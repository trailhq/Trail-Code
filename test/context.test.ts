/**
 * End-to-end tests for the markdown-graph pipeline (`init` → `check`), driven by
 * offline test doubles so no LLM/network is needed.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { buildContext } from "../src/context/build.js";
import { checkContext, indexFreshness, staleBanner } from "../src/context/check.js";
import { contextDirFor, ensureGitignored, ensureSearchable } from "../src/context/node-file.js";
import { buildGraph } from "../src/graph/build.js";
import { writeBuildConfig } from "../src/util/state.js";
import { fakeProviders, PassthroughSummarizer } from "./helpers.js";
import type { Synthesizer } from "../src/index.js";

// CLI-spawn helper (same pattern as test/graph-traverse-cli.test.ts) — these tests
// exercise the real process boundary (exit codes), which a unit-level call into
// checkContext()/checkGraph() can't: the pass/fail decision lives in cli.ts's
// `check` action, combining both layers' results.
function runCli(args: string[]): { stdout: string; stderr: string; status: number } {
  try {
    const stdout = execFileSync(process.execPath, ["--import", "tsx", "src/cli.ts", ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { stdout, stderr: "", status: 0 };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; status?: number };
    return { stdout: e.stdout ?? "", stderr: e.stderr ?? "", status: e.status ?? 1 };
  }
}

function makeFixture(): string {
  const dir = mkdtempSync(join(tmpdir(), "ctxgraph-"));
  writeFileSync(
    join(dir, "auth.ts"),
    `// [[Auth Service]] ==depends_on==> [[Token Store]]\nexport const auth = 1;\n`,
  );
  writeFileSync(
    join(dir, "billing.ts"),
    `// [[Billing]] ==uses==> [[Auth Service]]\nexport const billing = 2;\n`,
  );
  return dir;
}

function buildOpts() {
  return { model: "fake", ...fakeProviders() };
}

test("init includes Gleam sources by default", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ctxgraph-gleam-"));
  try {
    writeFileSync(join(dir, "app.gleam"), "pub fn main() { Nil }\n");

    const r = await buildContext(dir, buildOpts());

    assert.equal(r.files, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("init builds one markdown node per entity, with links and a manifest", async () => {
  const dir = makeFixture();
  try {
    const r = await buildContext(dir, buildOpts());
    // Auth Service, Token Store, Billing.
    assert.equal(r.nodes, 3);
    assert.equal(r.links, 2);
    assert.equal(r.files, 2);

    const ctx = join(dir, "graft");
    assert.ok(existsSync(join(ctx, "auth-service.md")));
    assert.ok(existsSync(join(ctx, "token-store.md")));
    assert.ok(existsSync(join(ctx, "billing.md")));
    assert.ok(existsSync(join(ctx, "manifest.json")));

    // Auth Service is referenced from BOTH files → multi-source provenance.
    const authMd = readFileSync(join(ctx, "auth-service.md"), "utf8");
    assert.match(authMd, /path: auth\.ts/);
    assert.match(authMd, /path: billing\.ts/);
    // Its edge to Token Store is rendered as a wiki-link.
    assert.match(authMd, /\[\[token-store\]\]/);

    const manifest = JSON.parse(readFileSync(join(ctx, "manifest.json"), "utf8"));
    assert.equal(manifest.files.length, 2);
    assert.equal(manifest.nodes.length, 3);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("check passes immediately after init", async () => {
  const dir = makeFixture();
  try {
    await buildContext(dir, buildOpts());
    const r = checkContext(dir);
    assert.equal(r.ok, true);
    assert.equal(r.missing, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// #213 — per-file cards for root-level sources land in graft/<stem>.md, the same
// directory readNodes() scans for concept nodes. Nested cards (graft/src/…) are
// not scanned. After a deep context build + wiring cards, check must not treat
// the root file card as a missing concept node.
test("check: root-level file card is not indexDrift after build (#213)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ctxgraph-root-card-"));
  try {
    writeFileSync(
      join(dir, "main.ts"),
      `export function rootFn(a: number): number { return a * 2; }\n`,
    );
    mkdirSync(join(dir, "src"));
    writeFileSync(
      join(dir, "src", "foo.ts"),
      `export function nestedFn(a: number): number { return a + 1; }\n`,
    );

    await buildContext(dir, buildOpts());
    await buildGraph(dir);

    assert.ok(existsSync(join(dir, "graft", "main.md")), "root source gets a top-level file card");
    assert.ok(existsSync(join(dir, "graft", "src", "foo.md")), "nested source card stays in a subdir");

    const r = checkContext(dir);
    assert.equal(r.ok, true, `expected clean check, got ${JSON.stringify(r)}`);
    assert.deepEqual(r.indexDrift, []);

    // A hand-dropped .md in graft/ is still an orphaned node — the detector
    // must not go silent for anything that is not a recorded per-file card.
    writeFileSync(join(dir, "graft", "notes.md"), "# stray notes\n");
    const stray = checkContext(dir);
    assert.equal(stray.ok, false);
    assert.ok(
      stray.indexDrift.some((s) => s.startsWith("notes:")),
      `expected stray notes.md to be indexDrift, got ${JSON.stringify(stray.indexDrift)}`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// #261 — same collision as #213, two holes #215's skip does not cover:
//   1. A concept slug equal to the root file's stem (Laravel `server.php` vs
//      a synthesized "Server" node). writeCards must not clobber the concept.
//   2. A root file card whose source is not in manifest.files (#215 only
//      skips stems recorded there). Graph-indexed extras (e.g. .lua) still
//      land at graft/<stem>.md and must not become indexDrift.
test("check: root PHP file card is not indexDrift after build (#261)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ctxgraph-root-php-"));
  try {
    writeFileSync(join(dir, "server.php"), `<?php\nfunction hi() { return 1; }\n`);
    mkdirSync(join(dir, "lib"));
    writeFileSync(join(dir, "lib", "deep.php"), `<?php\nfunction deep() { return 2; }\n`);

    await buildContext(dir, buildOpts());
    await buildGraph(dir);

    assert.ok(existsSync(join(dir, "graft", "server.md")), "root php source gets a top-level file card");
    assert.ok(existsSync(join(dir, "graft", "lib", "deep.md")), "nested php card stays in a subdir");

    const r = checkContext(dir);
    assert.equal(r.ok, true, `expected clean check, got ${JSON.stringify(r)}`);
    assert.deepEqual(r.indexDrift, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("check: root file card must not overwrite a concept with the same slug (#261)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ctxgraph-root-collide-"));
  try {
    writeFileSync(
      join(dir, "server.php"),
      `<?php\n// [[Server]] ==depends_on==> [[Router]]\nfunction hi() { return 1; }\n`,
    );
    mkdirSync(join(dir, "lib"));
    writeFileSync(
      join(dir, "lib", "router.php"),
      `<?php\n// [[Router]]\nfunction route() { return 2; }\n`,
    );

    await buildContext(dir, buildOpts());
    assert.match(
      readFileSync(join(dir, "graft", "server.md"), "utf8"),
      /^slug:\s*server\s*$/m,
      "context build writes a concept node at graft/server.md",
    );

    await buildGraph(dir);

    const concept = readFileSync(join(dir, "graft", "server.md"), "utf8");
    assert.match(concept, /^slug:\s*server\s*$/m, "file card must not clobber the concept node");
    assert.ok(
      existsSync(join(dir, "graft", "_root", "server.md")),
      "root file card relocates to graft/_root/ when the stem is a concept slug",
    );
    assert.match(readFileSync(join(dir, "graft", "_root", "server.md"), "utf8"), /^# server\.php/m);

    const r = checkContext(dir);
    assert.equal(r.ok, true, `expected clean check, got ${JSON.stringify(r)}`);
    assert.deepEqual(r.indexDrift, []);

    writeFileSync(join(dir, "graft", "notes.md"), "# stray notes\n");
    const stray = checkContext(dir);
    assert.equal(stray.ok, false);
    assert.ok(
      stray.indexDrift.some((s) => s.startsWith("notes:")),
      `expected stray notes.md to be indexDrift, got ${JSON.stringify(stray.indexDrift)}`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("check: root file card not in manifest.files is not indexDrift (#261)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ctxgraph-root-extra-"));
  try {
    // .lua is graph-indexed but not a context CODE_EXTENSIONS, so the card is
    // written and the source never appears in manifest.files — #215's skip
    // keyed on recorded root sources misses it.
    writeFileSync(join(dir, "server.lua"), `function hi() return 1 end\n`);
    mkdirSync(join(dir, "lib"));
    writeFileSync(join(dir, "lib", "deep.ts"), `export function deep() { return 2; }\n`);

    await buildContext(dir, buildOpts());
    await buildGraph(dir);

    assert.ok(existsSync(join(dir, "graft", "server.md")), "graph still writes a root file card");

    const r = checkContext(dir);
    assert.equal(r.ok, true, `expected clean check, got ${JSON.stringify(r)}`);
    assert.deepEqual(r.indexDrift, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("check reports NO GRAPH when init never ran", () => {
  const dir = mkdtempSync(join(tmpdir(), "ctxgraph-"));
  try {
    const r = checkContext(dir);
    assert.equal(r.missing, true);
    assert.equal(r.ok, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("check detects content drift when a source file changes", async () => {
  const dir = makeFixture();
  try {
    await buildContext(dir, buildOpts());
    writeFileSync(join(dir, "auth.ts"), `// [[Auth Service]]\nexport const auth = 999;\n`);
    const r = checkContext(dir);
    assert.equal(r.ok, false);
    assert.equal(r.contentDrift.length, 1);
    assert.equal(r.contentDrift[0].path, "auth.ts");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("indexFreshness/staleBanner: recorded files gone from disk (the branch-switch / stale-index case)", async () => {
  const dir = makeFixture();
  try {
    await buildContext(dir, buildOpts());
    // Fresh right after build: nothing missing, no banner.
    const fresh = indexFreshness(dir);
    assert.ok(fresh && fresh.missing === 0, "fresh index reports zero missing");
    assert.equal(staleBanner(fresh), null, "no banner when fresh");
    // Simulate a checkout to a tree where a recorded file doesn't exist.
    rmSync(join(dir, "auth.ts"), { force: true });
    const stale = indexFreshness(dir);
    assert.ok(stale && stale.missing >= 1, "missing count rises when a recorded file vanishes");
    const banner = staleBanner(stale);
    assert.match(banner ?? "", /ahead of your working tree/, "banner fires when stale");
    assert.match(banner ?? "", /graft grep/, "banner steers to graft grep, not raw grep");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("indexFreshness returns null when there is no graph", () => {
  const dir = mkdtempSync(join(tmpdir(), "graft-fresh-nograph-"));
  try {
    assert.equal(indexFreshness(dir), null);
    assert.equal(staleBanner(null), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("check detects a new file not yet in the graph (coverage drift)", async () => {
  const dir = makeFixture();
  try {
    await buildContext(dir, buildOpts());
    writeFileSync(join(dir, "new.ts"), `// [[New Thing]]\nexport const n = 3;\n`);
    const r = checkContext(dir);
    assert.equal(r.ok, false);
    assert.deepEqual(r.coverage, ["new.ts"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// A5 — a persisted `--include-dir` override must reach the Tier-2 markdown
// pipeline (context/build.ts) and its freshness check (context/check.ts), not
// just the Tier-1 wiring graph (graph/build.ts, via source-files.ts). Both
// sides must agree, in both directions: build/ shows up in buildContext's
// file listing, and checkContext neither reports it removed (disagreeing
// about what "current" means) nor as new coverage.
test("A5: a persisted --include-dir override reaches context/build.ts's file listing and context/check.ts's freshness check", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ctxgraph-include-dir-"));
  try {
    writeFileSync(
      join(dir, "auth.ts"),
      `// [[Auth Service]]\nexport const auth = 1;\n`,
    );
    mkdirSync(join(dir, "build"), { recursive: true });
    writeFileSync(
      join(dir, "build", "gen.ts"),
      `// [[Generated Widget]]\nexport const genWidget = 1;\n`,
    );
    writeBuildConfig(dir, { includeDirs: ["build"] });

    const r = await buildContext(dir, buildOpts());
    assert.deepEqual(r.errors, [], "build should not error");
    assert.ok(
      manifestFiles(dir).includes("build/gen.ts"),
      "build/gen.ts must be walked and recorded once --include-dir is persisted",
    );

    const check = checkContext(dir);
    assert.equal(check.ok, true, `expected no drift, got ${JSON.stringify(check)}`);
    assert.deepEqual(check.removed, [], "build/ must not be reported removed — check.ts must see it too");
    assert.deepEqual(check.coverage, [], "build/ must not be reported as new/uncovered — it's already in the manifest");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function manifestFiles(dir: string): string[] {
  const manifest = JSON.parse(readFileSync(join(dir, "graft", "manifest.json"), "utf8"));
  return manifest.files.map((f: { path: string }) => f.path);
}

test("re-running init clears drift", async () => {
  const dir = makeFixture();
  try {
    await buildContext(dir, buildOpts());
    writeFileSync(join(dir, "new.ts"), `// [[New Thing]]\nexport const n = 3;\n`);
    assert.equal(checkContext(dir).ok, false);
    await buildContext(dir, buildOpts());
    assert.equal(checkContext(dir).ok, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("human notes below the generated block survive regeneration", async () => {
  const dir = makeFixture();
  try {
    await buildContext(dir, buildOpts());
    const path = join(dir, "graft", "billing.md");
    const withNote = readFileSync(path, "utf8") + "\nHand-written note: watch out for retries.\n";
    writeFileSync(path, withNote);
    await buildContext(dir, buildOpts());
    assert.match(readFileSync(path, "utf8"), /Hand-written note: watch out for retries\./);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// `graft check` on the CLI combines the markdown-context layer (checkContext) and the
// wiring-graph layer (checkGraph). A keyless `graft build` (no --deep) only ever produces
// the wiring layer — manifest.json (markdown layer) is never written — so `check` must not
// treat that absence as failure on its own.
test("graft check: keyless build (no --deep) exits 0 — wiring graph present, markdown layer never built", () => {
  const dir = mkdtempSync(join(tmpdir(), "ctxgraph-cli-"));
  try {
    writeFileSync(join(dir, "math.ts"), "export function add(a: number, b: number): number {\n  return a + b;\n}\n");
    const built = runCli(["build", dir]);
    assert.equal(built.status, 0);

    const r = runCli(["check", dir]);
    assert.equal(r.status, 0, `expected exit 0, got ${r.status}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
    assert.match(r.stdout, /deep layer: not built/);
    assert.match(r.stdout, /wiring graph is the source of truth/);
    assert.match(r.stdout, /graph check: OK/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("graft check: neither layer ever built exits 1", () => {
  const dir = mkdtempSync(join(tmpdir(), "ctxgraph-cli-"));
  try {
    const r = runCli(["check", dir]);
    assert.equal(r.status, 1);
    assert.match(r.stdout, /NO GRAPH/);
    assert.match(r.stdout, /graft build/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("graft check: keyless build then code changes (wiring stale) exits 1", () => {
  const dir = mkdtempSync(join(tmpdir(), "ctxgraph-cli-"));
  try {
    const file = join(dir, "math.ts");
    writeFileSync(file, "export function add(a: number, b: number): number {\n  return a + b;\n}\n");
    const built = runCli(["build", dir]);
    assert.equal(built.status, 0);

    // Change the code without rebuilding — the wiring graph (the only layer that
    // exists) is now stale, so check must fail even though the markdown layer is
    // still just "not built" rather than "stale".
    writeFileSync(
      file,
      "export function add(a: number, b: number): number {\n  return a + b;\n}\n" +
        "export function sub(a: number, b: number): number {\n  return a - b;\n}\n",
    );

    const r = runCli(["check", dir]);
    assert.equal(r.status, 1, `expected exit 1, got ${r.status}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
    assert.match(r.stdout, /graph check: STALE/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ensureGitignored — every `graft build` self-ignores its regenerable graph dir.
test("ensureGitignored: creates .gitignore with the graft/ entry when none exists", () => {
  const dir = mkdtempSync(join(tmpdir(), "ctxgi-"));
  try {
    ensureGitignored(dir, contextDirFor(dir));
    const gi = readFileSync(join(dir, ".gitignore"), "utf8");
    // root-ANCHORED (#79): an unanchored `graft/` also matched `.claude/skills/graft/`
    assert.match(gi, /^\/graft\/$/m);
    assert.doesNotMatch(gi, /^graft\/$/m, "must not write the unanchored form");
    assert.match(gi, /regenerable, not committed/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ensureGitignored: appends to an existing .gitignore without clobbering it", () => {
  const dir = mkdtempSync(join(tmpdir(), "ctxgi-"));
  try {
    writeFileSync(join(dir, ".gitignore"), "node_modules/\ndist/\n");
    ensureGitignored(dir, contextDirFor(dir));
    const gi = readFileSync(join(dir, ".gitignore"), "utf8");
    assert.match(gi, /node_modules\//);
    assert.match(gi, /dist\//);
    assert.match(gi, /^\/graft\/$/m);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ensureGitignored: idempotent — a second build adds nothing", () => {
  const dir = mkdtempSync(join(tmpdir(), "ctxgi-"));
  try {
    ensureGitignored(dir, contextDirFor(dir));
    const once = readFileSync(join(dir, ".gitignore"), "utf8");
    ensureGitignored(dir, contextDirFor(dir));
    const twice = readFileSync(join(dir, ".gitignore"), "utf8");
    assert.equal(once, twice);
    assert.equal((twice.match(/^\/graft\/$/gm) ?? []).length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ensureGitignored: an existing unanchored `graft/` or hand-anchored `/graft/` is NOT re-appended (#79)", () => {
  for (const existing of ["graft/", "graft", "/graft/"]) {
    const dir = mkdtempSync(join(tmpdir(), "ctxgi-"));
    try {
      writeFileSync(join(dir, ".gitignore"), `node_modules/\n${existing}\n`);
      ensureGitignored(dir, contextDirFor(dir));
      const gi = readFileSync(join(dir, ".gitignore"), "utf8");
      // the presence check recognizes all three spellings → no duplicate graft line added
      const graftLines = gi.split("\n").filter((l) => /^\/?graft\/?$/.test(l.trim()));
      assert.equal(graftLines.length, 1, `existing "${existing}" must not be double-appended (got ${graftLines.length})`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test("ensureGitignored: a `--dir` subpath is root-anchored too (#79)", () => {
  const dir = mkdtempSync(join(tmpdir(), "ctxgi-"));
  try {
    // a graft dir nested under the repo (e.g. --dir tools/ctx) still gets a repo-root anchor
    ensureGitignored(dir, join(dir, "tools", "ctx"));
    const gi = readFileSync(join(dir, ".gitignore"), "utf8");
    assert.match(gi, /^\/tools\/ctx\/$/m);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ensureGitignored: recognizes a pre-existing bare `graft` entry (no slash) and stays silent", () => {
  const dir = mkdtempSync(join(tmpdir(), "ctxgi-"));
  try {
    writeFileSync(join(dir, ".gitignore"), "graft\n");
    ensureGitignored(dir, contextDirFor(dir));
    assert.equal(readFileSync(join(dir, ".gitignore"), "utf8"), "graft\n");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ensureGitignored: no-op when the graph dir is outside the repo root", () => {
  const dir = mkdtempSync(join(tmpdir(), "ctxgi-"));
  try {
    ensureGitignored(dir, join(tmpdir(), "somewhere-else-graft"));
    assert.equal(existsSync(join(dir, ".gitignore")), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ensureGitignored: GRAFT_NO_GITIGNORE=1 skips writing .gitignore", () => {
  const dir = mkdtempSync(join(tmpdir(), "ctxgi-"));
  process.env.GRAFT_NO_GITIGNORE = "1";
  try {
    ensureGitignored(dir, contextDirFor(dir));
    assert.equal(existsSync(join(dir, ".gitignore")), false);
  } finally {
    delete process.env.GRAFT_NO_GITIGNORE;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ensureSearchable: GRAFT_NO_IGNORE=1 skips writing .ignore", () => {
  const dir = mkdtempSync(join(tmpdir(), "ctxsearch-"));
  process.env.GRAFT_NO_IGNORE = "1";
  try {
    ensureSearchable(dir, contextDirFor(dir));
    assert.equal(existsSync(join(dir, ".ignore")), false);
  } finally {
    delete process.env.GRAFT_NO_IGNORE;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("graft build with GRAFT_NO_GITIGNORE and GRAFT_NO_IGNORE does not touch ignore files", () => {
  const dir = mkdtempSync(join(tmpdir(), "ctxgi-build-"));
  try {
    writeFileSync(join(dir, "main.ts"), "export function main(): number {\n  return 1;\n}\n");
    execFileSync(process.execPath, ["--import", "tsx", "src/cli.ts", "build", dir], {
      stdio: "pipe",
      env: { ...process.env, GRAFT_NO_GITIGNORE: "1", GRAFT_NO_IGNORE: "1" },
    });
    assert.equal(existsSync(join(dir, ".gitignore")), false);
    assert.equal(existsSync(join(dir, ".ignore")), false);
    assert.equal(existsSync(join(dir, "graft")), true, "build still writes the graph");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ensureSearchable — gitignoring the graph must not also hide it from `grep`.
// ripgrep honours .gitignore, so without this the cards are unreachable by the
// one mechanism they were designed around.
test("ensureSearchable: re-admits the card tree while excluding the caches", () => {
  const dir = mkdtempSync(join(tmpdir(), "ctxsearch-"));
  try {
    ensureSearchable(dir, contextDirFor(dir));
    const ig = readFileSync(join(dir, ".ignore"), "utf8");
    assert.match(ig, /^!graft\/$/m, "the tree is re-admitted to search");
    assert.match(ig, /^graft\/\.cache\/$/m, "but not the multi-MB parse memo");
    assert.match(ig, /^graft\/\.graph\/$/m, "and not wiring.json");
    assert.match(ig, /ripgrep reads/, "carries the why, for whoever finds this file");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ensureSearchable: appends to an existing .ignore, and is idempotent", () => {
  const dir = mkdtempSync(join(tmpdir(), "ctxsearch-"));
  try {
    writeFileSync(join(dir, ".ignore"), "vendor/\n");
    ensureSearchable(dir, contextDirFor(dir));
    const once = readFileSync(join(dir, ".ignore"), "utf8");
    assert.match(once, /vendor\//, "existing entries survive");
    ensureSearchable(dir, contextDirFor(dir));
    const twice = readFileSync(join(dir, ".ignore"), "utf8");
    assert.equal(once, twice);
    assert.equal((twice.match(/^!graft\/$/gm) ?? []).length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ensureSearchable: leaves a hand-written negation alone", () => {
  const dir = mkdtempSync(join(tmpdir(), "ctxsearch-"));
  try {
    // Someone already had an opinion here — don't append a competing block.
    writeFileSync(join(dir, ".ignore"), "# mine\n!graft/\n");
    ensureSearchable(dir, contextDirFor(dir));
    assert.equal(readFileSync(join(dir, ".ignore"), "utf8"), "# mine\n!graft/\n");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ensureSearchable: no-op when the graph dir is outside the repo root", () => {
  const dir = mkdtempSync(join(tmpdir(), "ctxsearch-"));
  try {
    ensureSearchable(dir, join(tmpdir(), "somewhere-else-graft"));
    assert.equal(existsSync(join(dir, ".ignore")), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("#129: an empty synthesis batch is not cached — the next build retries", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ctx-empty-synth-"));
  try {
    writeFileSync(join(dir, "a.ts"), "export const a = 1;\n");
    let calls = 0;
    const synthesizer: Synthesizer = {
      async synthesize() {
        calls++;
        return [];
      },
    };
    const opts = { model: "fake", summarizer: new PassthroughSummarizer(), synthesizer };
    await buildContext(dir, opts);
    await buildContext(dir, opts);
    assert.equal(calls, 2, "[] must not become a cache hit the way #177 refused empty meaning replies");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("#129: synthesis logs per-batch counts and warns when a multi-batch run has 0 links", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ctx-zero-links-"));
  const blob = (name: string) => `export const ${name} = 1;\n// ${"x".repeat(30_000)}\n`;
  try {
    writeFileSync(join(dir, "a.ts"), blob("a"));
    writeFileSync(join(dir, "b.ts"), blob("b"));
    const synthesizer: Synthesizer = {
      async synthesize(files) {
        return files.map((f) => ({
          name: f.path,
          type: "file",
          summary: "s",
          sources: [f.path],
          links: [],
        }));
      },
    };
    const err: string[] = [];
    const orig = console.error;
    console.error = (...args: unknown[]) => {
      err.push(args.map(String).join(" "));
    };
    try {
      const r = await buildContext(dir, {
        model: "fake",
        summarizer: new PassthroughSummarizer(),
        synthesizer,
      });
      assert.ok(r.batches > 1, `need multiple batches to trigger the summary warning, got ${r.batches}`);
      assert.equal(r.links, 0);
      assert.ok(err.some((l) => /synthesis batch 1\/\d+: \d+ nodes, 0 links/.test(l)));
      assert.ok(err.some((l) => /synthesis batch 2\/\d+:/.test(l)));
      assert.ok(err.some((l) => /0 links across \d+ batches/.test(l)));
    } finally {
      console.error = orig;
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
