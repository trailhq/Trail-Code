/**
 * Tests for `graft map`'s pure core: {@link buildRepoMap} + {@link formatRepoMap}.
 *
 * All fixtures are hand-built `GraphV1` graphs (no real repo, no `buildGraph`)
 * — same `nodeStub`/`graphOf` pattern as test/graphrank.test.ts, extended
 * with a `path`/`kind`/`span` so directory grouping and hub ranking have
 * something to chew on.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildRepoMap, formatRepoMap } from "../src/graph/map.js";
import type { GraphV1, NodeV1, EdgeV1, Kind, Relation, ScopeV1 } from "../src/graph/types.js";

let counter = 0;

function fileNode(path: string): NodeV1 {
  return {
    id: path,
    name: path.slice(path.lastIndexOf("/") + 1),
    kind: "file",
    path,
    span: "L1-L1",
    signature: null,
    exported: true,
    origin: "ast",
    body_hash: `h${counter++}`,
    summary_state: "pending",
    summary: null,
    crux: null,
  };
}

function symNode(path: string, name: string, opts: { kind?: Kind; span?: string } = {}): NodeV1 {
  const id = `${path}#${name}`;
  return {
    id,
    name,
    kind: opts.kind ?? "function",
    path,
    span: opts.span ?? "L1-L10",
    signature: `${name}()`,
    exported: true,
    origin: "ast",
    body_hash: `h${counter++}`,
    summary_state: "pending",
    summary: null,
    crux: null,
  };
}

function edge(source: string, target: string, relation: Relation = "calls"): EdgeV1 {
  return { source, target, relation, confidence: "extracted" };
}

function graphOf(nodes: NodeV1[], edges: EdgeV1[]): GraphV1 {
  return {
    meta: { version: 1, nodeCount: nodes.length, edgeCount: edges.length, languages: [] },
    nodes,
    edges,
  };
}

/** Same as `graphOf`, plus `meta.scopes` — the same hand-set-scopes pattern
 * `ask.test.ts`'s regression pin uses, so a multi-scope fixture doesn't need a
 * real repo build just to exercise `buildRepoMap`'s scope-aware branch. */
function graphOfWithScopes(nodes: NodeV1[], edges: EdgeV1[], scopes: ScopeV1[]): GraphV1 {
  const g = graphOf(nodes, edges);
  g.meta.scopes = scopes;
  return g;
}

// ── totals ────────────────────────────────────────────────────────────────

test("buildRepoMap: totals count files, symbols, edges, and languages across the whole graph", () => {
  const nodes = [
    fileNode("src/a.ts"),
    symNode("src/a.ts", "fnA"),
    fileNode("docs/readme.py"), // deliberately mixed languages
    symNode("docs/readme.py", "fnB"),
  ];
  const edges = [edge("src/a.ts#fnA", "docs/readme.py#fnB")];
  const map = buildRepoMap(graphOf(nodes, edges));

  assert.equal(map.totals.files, 2);
  assert.equal(map.totals.symbols, 2);
  assert.equal(map.totals.edges, 1);
  assert.deepEqual(map.totals.languages, ["python", "typescript"]);
});

// Issue #762: generic-tree-sitter-tier languages (rust, c, …) are indexed but
// `sortedLanguages` consulted only the depth-tier EXTENSIONS table, so a Rust
// repo with a few website .js files was labeled "javascript".
test("buildRepoMap: generic-tier languages (rust) label the map too, not just depth-tier ones", () => {
  const nodes = [
    fileNode("src/lib.rs"),
    symNode("src/lib.rs", "fnRust"),
    fileNode("static/app.js"),
    symNode("static/app.js", "fnJs"),
  ];
  const map = buildRepoMap(graphOf(nodes, []));
  assert.deepEqual(map.totals.languages, ["javascript", "rust"]);
  assert.match(formatRepoMap(map), /\brust\b/);
});

test("buildRepoMap: dirs are grouped by first path segment and sorted by symbol count desc", () => {
  const nodes = [
    fileNode("alpha/a.ts"),
    symNode("alpha/a.ts", "one"),
    fileNode("beta/b.ts"),
    symNode("beta/b.ts", "two"),
    symNode("beta/b.ts", "three"),
  ];
  const map = buildRepoMap(graphOf(nodes, []));

  assert.deepEqual(map.dirs.map((d) => d.path), ["beta", "alpha"], "beta has more symbols, sorts first");
  const beta = map.dirs.find((d) => d.path === "beta")!;
  assert.equal(beta.files, 1);
  assert.equal(beta.symbols, 2);
});

// ── >60% split refinement ────────────────────────────────────────────────

test("buildRepoMap: a segment holding >60% of file nodes is split one level deeper", () => {
  // 7 of 10 files under src/ (70% > 60%) → src/ask, src/graph split out.
  // tests/ (3 files, 30%) stays a single depth-1 group.
  const nodes = [
    fileNode("src/ask/a1.ts"),
    fileNode("src/ask/a2.ts"),
    fileNode("src/ask/a3.ts"),
    fileNode("src/ask/a4.ts"),
    fileNode("src/graph/g1.ts"),
    fileNode("src/graph/g2.ts"),
    fileNode("src/graph/g3.ts"),
    fileNode("tests/t1.ts"),
    fileNode("tests/t2.ts"),
    fileNode("tests/t3.ts"),
  ];
  const map = buildRepoMap(graphOf(nodes, []));
  const paths = map.dirs.map((d) => d.path);

  assert.ok(!paths.includes("src"), "the over-threshold group itself must not survive unsplit");
  assert.ok(paths.includes("src/ask"), "split refines src into its sub-segments");
  assert.ok(paths.includes("src/graph"));
  assert.ok(paths.includes("tests"), "a group under threshold is untouched");

  const ask = map.dirs.find((d) => d.path === "src/ask")!;
  assert.equal(ask.files, 4);
  const graphDir = map.dirs.find((d) => d.path === "src/graph")!;
  assert.equal(graphDir.files, 3);
});

test("buildRepoMap: a segment at or below 60% is not split", () => {
  const nodes = [
    fileNode("src/a.ts"),
    fileNode("src/b.ts"),
    fileNode("src/c.ts"), // src: 3/5 = 60%, not > 60%
    fileNode("tests/t1.ts"),
    fileNode("tests/t2.ts"),
  ];
  const map = buildRepoMap(graphOf(nodes, []));
  assert.ok(map.dirs.some((d) => d.path === "src"), "60% exactly must not trigger the split");
});

test("buildRepoMap: a file sitting directly in a >60% split dir collapses to a file-level entry, rendered with no trailing slash", () => {
  // src/ holds 5 of 8 files (62.5% > 60%) → split one level deeper. Four of
  // those five files nest under src/ask and src/graph (clean sub-dirs), but
  // src/auth.ts sits directly in src/ itself — depth-2 grouping has nothing
  // deeper to split it into, so `dirKey` degenerates to the file's own full
  // path ("src/auth.ts"), and that path is a FILE, not a directory.
  const nodes = [
    fileNode("src/auth.ts"),
    fileNode("src/ask/a1.ts"),
    fileNode("src/ask/a2.ts"),
    fileNode("src/graph/g1.ts"),
    fileNode("src/graph/g2.ts"),
    fileNode("tests/t1.ts"),
    fileNode("tests/t2.ts"),
    fileNode("tests/t3.ts"),
  ];
  const map = buildRepoMap(graphOf(nodes, []));
  const paths = map.dirs.map((d) => d.path);

  assert.ok(!paths.includes("src"), "the over-threshold group itself must not survive unsplit");
  assert.ok(paths.includes("src/auth.ts"), "the file that couldn't split deeper reports its own full path");
  assert.ok(paths.includes("src/ask"));
  assert.ok(paths.includes("src/graph"));

  const authEntry = map.dirs.find((d) => d.path === "src/auth.ts")!;
  assert.equal(authEntry.files, 1);

  const text = formatRepoMap(map);
  // Exact rendered line: file path padded to the 20-col width, no trailing
  // "/" glued onto it — never "src/auth.ts/1 files" or "src/auth.ts/        ".
  const expectedLine = "src/auth.ts".padEnd(20) + "1 files · 0 symbols";
  assert.ok(
    text.includes(expectedLine),
    `expected exact line "${expectedLine}" in:\n${text}`,
  );
  assert.doesNotMatch(text, /auth\.ts\//, "no slash glued onto the file path");
});

// ── hub ordering ─────────────────────────────────────────────────────────

test("buildRepoMap: hubs within a dir are ranked by inDegree desc, ties broken by name asc", () => {
  const nodes = [
    fileNode("lib/x.ts"),
    symNode("lib/x.ts", "zebra", { kind: "function" }),
    symNode("lib/x.ts", "apple", { kind: "function" }),
    symNode("lib/x.ts", "mango", { kind: "function" }),
    // An unrelated dir so "lib" doesn't trivially hold 100% of file nodes
    // and trip the >60% split refinement this test isn't exercising.
    fileNode("other/y.ts"),
  ];
  const edges = [
    // zebra: 2 inbound; apple: 2 inbound (tie, name asc must put apple first); mango: 1 inbound.
    edge("lib/x.ts#caller1", "lib/x.ts#zebra"),
    edge("lib/x.ts#caller2", "lib/x.ts#zebra"),
    edge("lib/x.ts#caller1", "lib/x.ts#apple"),
    edge("lib/x.ts#caller2", "lib/x.ts#apple"),
    edge("lib/x.ts#caller1", "lib/x.ts#mango"),
  ];
  const map = buildRepoMap(graphOf(nodes, edges));
  const lib = map.dirs.find((d) => d.path === "lib")!;

  assert.deepEqual(
    lib.hubs.map((h) => h.name),
    ["apple", "zebra", "mango"],
    "tied inDegree (apple, zebra) breaks by name asc; mango (lower inDegree) last",
  );
  assert.equal(lib.hubs[0].inDegree, 2);
});

test("buildRepoMap: hotspots rank globally by inDegree, ties broken by name asc, capped by opts.hotspots", () => {
  const nodes = [fileNode("a/x.ts"), fileNode("b/y.ts")];
  const names = ["zeta", "beta", "gamma", "alpha"];
  for (const n of names) nodes.push(symNode("a/x.ts", n));
  const edges: EdgeV1[] = [];
  // Every symbol gets exactly 1 inbound edge (tie) except "beta" which gets 2.
  for (const n of names) edges.push(edge("b/y.ts#caller", `a/x.ts#${n}`));
  edges.push(edge("b/y.ts#caller2", "a/x.ts#beta"));

  const map = buildRepoMap(graphOf(nodes, edges), { hotspots: 2 });
  assert.equal(map.hotspots.length, 2, "capped by opts.hotspots");
  assert.equal(map.hotspots[0].name, "beta", "beta has the highest inDegree");
  assert.equal(map.hotspots[1].name, "alpha", "remaining tie broken by name asc");
});

test("buildRepoMap: hub/hotspot order is identical regardless of node array order (final path-asc tie-break)", () => {
  // Two symbols, same name, same inDegree, different paths — a same-name/
  // same-inDegree tie that `name asc` alone can't resolve deterministically;
  // without a final `path asc` tie-break the reported order depends on
  // whichever happened to come first in `graph.nodes`.
  const fileA = fileNode("alpha/a.ts");
  const fileB = fileNode("beta/b.ts");
  const symInAlpha = symNode("alpha/a.ts", "dup");
  const symInBeta = symNode("beta/b.ts", "dup");
  const callerFile = fileNode("callers/c.ts");
  const edges = [
    edge("callers/c.ts#caller1", "alpha/a.ts#dup"),
    edge("callers/c.ts#caller2", "beta/b.ts#dup"),
  ];

  const forward = buildRepoMap(
    graphOf([fileA, symInAlpha, fileB, symInBeta, callerFile], edges),
  );
  const reversed = buildRepoMap(
    graphOf([callerFile, fileB, symInBeta, fileA, symInAlpha], edges),
  );

  assert.deepEqual(forward.hotspots, reversed.hotspots, "hotspot order must not depend on node array order");
  assert.deepEqual(
    forward.hotspots.map((h) => h.path),
    ["alpha/a.ts", "beta/b.ts"],
    "tied name+inDegree hotspots break the tie by path asc",
  );
});

test("buildRepoMap: symbols with zero inbound edges are never listed as hubs or hotspots", () => {
  const nodes = [fileNode("lib/x.ts"), symNode("lib/x.ts", "lonely"), fileNode("other/y.ts")];
  const map = buildRepoMap(graphOf(nodes, []));
  const lib = map.dirs.find((d) => d.path === "lib")!;
  assert.equal(lib.hubs.length, 0);
  assert.equal(map.hotspots.length, 0);
});

// ── dropped-dirs cap ─────────────────────────────────────────────────────

test("buildRepoMap: dirs beyond maxDirs are capped and counted into dropped", () => {
  const nodes: NodeV1[] = [];
  for (const dir of ["a", "b", "c", "d", "e"]) {
    nodes.push(fileNode(`${dir}/x.ts`));
  }
  const map = buildRepoMap(graphOf(nodes, []), { maxDirs: 2 });
  assert.equal(map.dirs.length, 2);
  assert.equal(map.dropped, 3);
});

// ── scope-aware grouping (multi-scope repos) ────────────────────────────

/** frontend/ (ts) and backend/ (py) as sibling scopes, each with its own
 * sub-dirs so the per-scope dir breakdown has something to group. */
function twoScopeFixture(): GraphV1 {
  const nodes = [
    fileNode("frontend/src/a.ts"),
    symNode("frontend/src/a.ts", "one"),
    fileNode("frontend/lib/b.ts"),
    symNode("frontend/lib/b.ts", "two"),
    symNode("frontend/lib/b.ts", "three"),
    fileNode("backend/app.py"),
    symNode("backend/app.py", "four"),
  ];
  const scopes: ScopeV1[] = [
    { prefix: "backend", label: "backend", markers: ["pyproject.toml"] },
    { prefix: "frontend", label: "frontend", markers: ["package.json"] },
  ];
  return graphOfWithScopes(nodes, [], scopes);
}

test("buildRepoMap: single-scope output is byte-identical whether meta.scopes is absent or the canonical root form", () => {
  const nodes = [fileNode("src/a.ts"), symNode("src/a.ts", "fn")];
  const bare = buildRepoMap(graphOf(nodes, []));
  const canonical = buildRepoMap(
    graphOfWithScopes(nodes, [], [{ prefix: "", label: "", markers: [] }]),
  );
  assert.deepEqual(bare, canonical, "canonical single root scope must not change buildRepoMap's output");
  assert.equal(bare.scopes, undefined, "single-scope RepoMap carries no `scopes` field");
});

test("buildRepoMap: multi-scope graph groups dirs by scope first, dirs within scope second", () => {
  const map = buildRepoMap(twoScopeFixture());

  assert.equal(map.dirs.length, 0, "multi-scope: the flat `dirs` field is empty, `scopes` carries the breakdown");
  assert.ok(map.scopes, "multi-scope RepoMap carries a `scopes` field");
  assert.deepEqual(map.scopes!.map((s) => s.scope), ["backend/", "frontend/"], "scope order follows meta.scopes");

  const backend = map.scopes!.find((s) => s.scope === "backend/")!;
  // backend has a single, root-level (within the scope) file — same rule a
  // single-scope repo-root file follows: with nothing deeper to group by, the
  // file's own path becomes its group (see `dirKey`'s module doc).
  assert.deepEqual(backend.dirs.map((d) => d.path), ["backend/app.py"]);
  assert.equal(backend.dirs[0].symbols, 1);

  const frontend = map.scopes!.find((s) => s.scope === "frontend/")!;
  // frontend has two sub-dirs (src, lib) — dirs within the scope, sorted by
  // symbol count desc, same rule as single-scope dirs.
  assert.deepEqual(
    frontend.dirs.map((d) => d.path),
    ["frontend/lib", "frontend/src"],
    "frontend's own dirs are grouped and sorted independently of backend's",
  );
  assert.equal(frontend.dirs.find((d) => d.path === "frontend/lib")!.symbols, 2);
  assert.equal(frontend.dirs.find((d) => d.path === "frontend/src")!.symbols, 1);
});

test("buildRepoMap: a root scope alongside named scopes gets its own '(root)' group for files outside any sub-project", () => {
  const nodes = [
    fileNode("README.md"),
    fileNode("frontend/src/a.ts"),
    symNode("frontend/src/a.ts", "one"),
  ];
  // An explicit "" (root) entry alongside "frontend" — two scopes, so this
  // takes the multi-scope path (a lone non-root scope with no "" entry is
  // the single-scope case: same `scopes.length <= 1` convention `ask.ts`
  // uses, since `scopeOf` synthesizes a fallback root for it anyway).
  const scopes: ScopeV1[] = [
    { prefix: "", label: "", markers: [] },
    { prefix: "frontend", label: "frontend", markers: ["package.json"] },
  ];
  const map = buildRepoMap(graphOfWithScopes(nodes, [], scopes));

  assert.deepEqual(map.scopes!.map((s) => s.scope).sort(), ["(root)", "frontend/"]);
  const root = map.scopes!.find((s) => s.scope === "(root)")!;
  assert.deepEqual(root.dirs.map((d) => d.path), ["README.md"]);
});

test("buildRepoMap: the >60% split threshold is evaluated PER SCOPE, not pooled across scopes", () => {
  // backend alone holds 4 files, 3 of which (75%) sit under backend/svc — that
  // must split into backend/svc/a, backend/svc/b even though svc is nowhere
  // near 60% of the WHOLE graph's files (it's 3 of 5 total, i.e. exactly at
  // the single-scope-pooled threshold that wouldn't trip the split at all).
  const nodes = [
    fileNode("backend/svc/a/x.ts"),
    fileNode("backend/svc/b/y.ts"),
    fileNode("backend/svc/c/z.ts"),
    fileNode("backend/other.ts"),
    fileNode("frontend/main.ts"),
  ];
  const scopes: ScopeV1[] = [
    { prefix: "backend", label: "backend", markers: ["go.mod"] },
    { prefix: "frontend", label: "frontend", markers: ["package.json"] },
  ];
  const map = buildRepoMap(graphOfWithScopes(nodes, [], scopes));
  const backend = map.scopes!.find((s) => s.scope === "backend/")!;
  const paths = backend.dirs.map((d) => d.path);
  assert.ok(!paths.includes("backend/svc"), "svc holds 75% of backend's own files — must split");
  assert.ok(paths.includes("backend/svc/a"));
  assert.ok(paths.includes("backend/svc/b"));
  assert.ok(paths.includes("backend/svc/c"));
  assert.ok(paths.includes("backend/other.ts"), "backend's non-svc file is its own group (root-level-in-scope file)");
});

test("buildRepoMap: maxDirs caps each scope's dirs independently, with per-scope dropped counts", () => {
  const nodes: NodeV1[] = [];
  for (const dir of ["backend/a", "backend/b", "backend/c"]) nodes.push(fileNode(`${dir}/x.ts`));
  nodes.push(fileNode("frontend/x.ts"));
  const scopes: ScopeV1[] = [
    { prefix: "backend", label: "backend", markers: ["go.mod"] },
    { prefix: "frontend", label: "frontend", markers: ["package.json"] },
  ];
  const map = buildRepoMap(graphOfWithScopes(nodes, [], scopes), { maxDirs: 1 });
  const backend = map.scopes!.find((s) => s.scope === "backend/")!;
  const frontend = map.scopes!.find((s) => s.scope === "frontend/")!;
  assert.equal(backend.dirs.length, 1);
  assert.equal(backend.dropped, 2, "backend alone has 3 dirs, capped to 1 → 2 dropped");
  assert.equal(frontend.dirs.length, 1);
  assert.equal(frontend.dropped, 0, "frontend only has 1 dir — nothing dropped");
});

test("formatRepoMap: multi-scope renders one '## scope/' heading per scope, dirs nested under it", () => {
  const text = formatRepoMap(buildRepoMap(twoScopeFixture()));
  assert.match(text, /^## backend\/$/m);
  assert.match(text, /^## frontend\/$/m);
  const backendIdx = text.indexOf("## backend/");
  const frontendIdx = text.indexOf("## frontend/");
  const frontendLibIdx = text.indexOf("frontend/lib/", frontendIdx);
  assert.ok(backendIdx < frontendIdx, "scopes render in meta.scopes order");
  assert.ok(frontendIdx < frontendLibIdx, "frontend's own dirs render under its own heading, not backend's");
});

// ── formatRepoMap ────────────────────────────────────────────────────────

/** 60-node-ish fixture: a handful of dirs, each with several hub-worthy
 * symbols, enough edges to build up inDegree without exploding sizes. */
function bigFixture(): GraphV1 {
  const nodes: NodeV1[] = [];
  const edges: EdgeV1[] = [];
  const dirs = ["alpha", "beta", "gamma", "delta"];
  for (const dir of dirs) {
    for (let f = 0; f < 3; f++) {
      const path = `${dir}/file${f}.ts`;
      nodes.push(fileNode(path));
      for (let s = 0; s < 4; s++) {
        const name = `${dir}Sym${f}_${s}`;
        nodes.push(symNode(path, name));
        // Give the first symbol in each file a bunch of callers so it's a hub.
        if (s === 0) {
          for (let c = 0; c < 5; c++) edges.push(edge(`${dir}/caller${c}.ts#c`, `${path}#${name}`));
        }
      }
    }
  }
  return graphOf(nodes, edges);
}

test("formatRepoMap: stays under the 6000-char budget and surfaces hub names", () => {
  const map = buildRepoMap(bigFixture());
  const text = formatRepoMap(map);

  assert.ok(text.length <= 6000, `formatted map is ${text.length} chars, expected <= 6000`);
  assert.match(text, /^repo map — \d+ files · \d+ symbols · \d+ edges/);
  for (const d of map.dirs) {
    for (const h of d.hubs) {
      assert.ok(text.includes(h.name), `hub name "${h.name}" must appear in the rendered map`);
    }
  }
});

test("formatRepoMap: notes dropped directories beyond the cap, pointing only at options that actually exist", () => {
  const nodes: NodeV1[] = [];
  for (const dir of ["a", "b", "c", "d"]) nodes.push(fileNode(`${dir}/x.ts`));
  const map = buildRepoMap(graphOf(nodes, []), { maxDirs: 1 });
  const text = formatRepoMap(map);
  assert.match(text, /\+3 more directories not shown/);
  // Regression: the old note said "raise --max-dirs or use --json" — no
  // --max-dirs flag existed, and --json is capped identically (both go
  // through the same `maxDirs`-sliced RepoMap), so dropped dirs were
  // unreachable either way. The reworded note only promises a real escape
  // hatch (the now-real `maxDirs` option) and drops the dead --json mention.
  assert.match(text, /max-dirs/);
  assert.doesNotMatch(text, /--json/);
});

test("buildRepoMap: a raised maxDirs opt actually surfaces previously-dropped dirs (the real --max-dirs escape hatch)", () => {
  const nodes: NodeV1[] = [];
  for (const dir of ["a", "b", "c", "d", "e"]) nodes.push(fileNode(`${dir}/x.ts`));

  const capped = buildRepoMap(graphOf(nodes, []), { maxDirs: 2 });
  assert.equal(capped.dirs.length, 2);
  assert.equal(capped.dropped, 3);

  const raised = buildRepoMap(graphOf(nodes, []), { maxDirs: 10 });
  assert.equal(raised.dirs.length, 5, "raising maxDirs surfaces every dir");
  assert.equal(raised.dropped, 0);
});

test("formatRepoMap: an empty repo map still renders a well-formed header", () => {
  const map = buildRepoMap(graphOf([], []));
  const text = formatRepoMap(map);
  assert.match(text, /^repo map — 0 files · 0 symbols · 0 edges ·\s*$/m);
  assert.match(text, /^hotspots:\s*$/m);
});
