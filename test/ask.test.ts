/**
 * Tests for `graft ask` — specifically the `source` option, which turns the
 * pack from a locator (pointers only) into a retriever (source inlined at each
 * span). The retriever behaviour is what makes ask substitutive: the agent
 * reads the span from the pack instead of opening the file.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { buildGraph } from "../src/graph/build.js";
import { ask, formatAsk, skeleton, formatSkeleton, isTestPath } from "../src/ask/ask.js";

test("isTestPath: de-ranks test files, not real source", () => {
  for (const p of ["server/download_test.go", "packages/x/tests/foo.test.tsx", "a/__tests__/b.ts", "src/api.spec.ts", "pkg/foo/bar_test.go"])
    assert.ok(isTestPath(p), `${p} should be a test path`);
  for (const p of ["server/download.go", "packages/element/src/selection.ts", "src/api.ts", "cmd/root.go"])
    assert.ok(!isTestPath(p), `${p} should NOT be a test path`);
});

test("isTestPath: recognizes pytest's test_*.py prefix and conftest, even outside a tests/ dir", () => {
  // pytest's dominant convention is the FILENAME prefix test_*.py — and repos put
  // these outside a tests/-named dir (kombu uses t/unit/). Missing these swamps
  // `ask` with test methods on well-tested Python repos.
  for (const p of [
    "t/unit/transport/test_qpid.py",   // kombu layout
    "t/unit/test_messaging.py",
    "test_foo.py",                     // bare pytest file
    "src/pkg/test_utils.py",           // pytest file beside source
    "conftest.py", "a/b/conftest.py",  // pytest fixtures file
  ]) assert.ok(isTestPath(p), `${p} should be a test path`);
  // must NOT over-match ordinary source that merely contains "test"
  for (const p of ["src/contest.py", "src/latest_value.py", "pkg/attestation.py"])
    assert.ok(!isTestPath(p), `${p} should NOT be a test path`);
});

test("test files rank below the source they exercise for a non-test query, but not for a test-seeking one", async () => {
  const dir = mkdtempSync(join(tmpdir(), "graft-ask-testrank-"));
  try {
    writeFileSync(
      join(dir, "download.ts"),
      `export function downloadChunk(url: string): string {\n` +
        `  // stall detection before the first byte arrives\n` +
        `  return url;\n` +
        `}\n`,
    );
    writeFileSync(
      join(dir, "download.test.ts"),
      `import { downloadChunk } from "./download";\n` +
        `// stall detection test exercising downloadChunk before first byte\n` +
        `export function testDownloadChunkStall(): void { downloadChunk("x"); }\n`,
    );
    await buildGraph(dir);
    // Non-test query: the real source must outrank its mirror test file, even
    // though the test contains the same literals ("download", "stall", "detection").
    const r = ask(dir, "download chunk stall detection first byte");
    const src = r.hits.findIndex((h) => /(^|\/)download\.ts(:|$)/.test(h.pointer));
    const tst = r.hits.findIndex((h) => /download\.test\.ts/.test(h.pointer));
    assert.ok(src >= 0, "source hit present");
    assert.ok(tst === -1 || src < tst, "source ranks above its test for a non-test query");
    // Test-seeking query: the penalty lifts, so the test file surfaces.
    const rt = ask(dir, "tests for downloadChunk stall");
    assert.ok(rt.hits.some((h) => /download\.test\.ts/.test(h.pointer)), "test file surfaces for a test-seeking query");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("test de-ranking survives normalization when a test is the strongest lexical match (#37)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "graft-ask-test-normalization-"));
  try {
    writeFileSync(
      join(dir, "selector.ts"),
      `export function choose(request: string): string {\n` +
        `  // Select the engine for a request and follow the fallback chain.\n` +
        `  return request;\n` +
        `}\n`,
    );
    writeFileSync(
      join(dir, "selector.test.ts"),
      `import { choose } from "./selector";\n` +
        `export function testWhereEngineSelectedForRequestFallbackChain(): void {\n` +
        `  choose("request");\n` +
        `}\n`,
    );
    await buildGraph(dir);

    const r = ask(dir, "where engine selected for request fallback chain");
    const source = r.hits.findIndex((h) => /(^|\/)selector\.ts(:|$)/.test(h.pointer));
    const testHit = r.hits.findIndex((h) => /selector\.test\.ts/.test(h.pointer));
    assert.ok(source >= 0, "implementation hit present");
    assert.ok(testHit === -1 || source < testHit, "implementation ranks above the stronger lexical test match");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeFixture(): string {
  const dir = mkdtempSync(join(tmpdir(), "graft-ask-"));
  writeFileSync(
    join(dir, "math.ts"),
    `export function addNumbers(a: number, b: number): number {\n` +
      `  return a + b;\n` +
      `}\n`,
  );
  return dir;
}

test("ask without source returns pointers but no inlined code", async () => {
  const dir = makeFixture();
  try {
    await buildGraph(dir); // $0, structure-only — cards + wiring.json
    const r = ask(dir, "addNumbers");
    const hit = r.hits.find((h) => h.title.startsWith("addNumbers"));
    assert.ok(hit, "should locate the addNumbers symbol");
    assert.match(hit.pointer, /^math\.ts:L\d+-L\d+$/);
    assert.equal(hit.code, undefined, "no source inlined without the option");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** Stamp a crux onto the addNumbers node in the fixture's committed wiring.json
 * (fixtures build keyless, so Tier-2 fields ship null). */
function stampCrux(dir: string, code: string): void {
  const p = join(dir, "graft", ".graph", "wiring.json");
  const g = JSON.parse(readFileSync(p, "utf8"));
  const n = g.nodes.find((n: any) => n.name === "addNumbers");
  n.crux = { code, span: "L2-L2" };
  writeFileSync(p, JSON.stringify(g));
}

test("ask --source inlines the crux by default, the whole span with full", async () => {
  const dir = makeFixture();
  try {
    await buildGraph(dir);
    stampCrux(dir, "return a + b;");
    const cruxed = ask(dir, "addNumbers", { source: true });
    const hit = cruxed.hits.find((h) => h.title.startsWith("addNumbers"))!;
    assert.match(hit.code!, /^return a \+ b;/, "crux excerpt inlined, not the definition");
    assert.match(hit.code!, /rerun with --full/, "escalation marker present");
    const full = ask(dir, "addNumbers", { source: true, full: true });
    const fullHit = full.hits.find((h) => h.title.startsWith("addNumbers"))!;
    assert.match(fullHit.code!, /export function addNumbers/, "full definition span inlined");
    assert.doesNotMatch(fullHit.code!, /rerun with --full/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ask --source falls back to the span when a node has no crux", async () => {
  const dir = makeFixture();
  try {
    await buildGraph(dir); // keyless: crux is null on every node
    const r = ask(dir, "addNumbers", { source: true });
    const hit = r.hits.find((h) => h.title.startsWith("addNumbers"))!;
    assert.match(hit.code!, /export function addNumbers/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("skeleton lists a file's definitions in span order, matches by basename", async () => {
  const dir = mkdtempSync(join(tmpdir(), "graft-skel-"));
  try {
    writeFileSync(
      join(dir, "api.ts"),
      `export function first(a: number): number {\n  return a;\n}\n\n` +
        `export function second(b: string): string {\n  return b;\n}\n`,
    );
    await buildGraph(dir);
    const r = skeleton(dir, "api.ts");
    assert.deepEqual(r.entries.map((e) => e.name), ["first", "second"], "span order");
    assert.match(r.entries[0].signature ?? "", /first/);
    const byBase = skeleton(dir, "api.ts");
    assert.equal(byBase.file, "api.ts");
    const txt = formatSkeleton(r);
    assert.match(txt, /graft skeleton — api\.ts/);
    assert.match(txt, /L\d+-L\d+ {2}function first/);
    assert.match(skeleton(dir, "nope.ts").note ?? "", /no definitions/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("skeleton names a size-skipped file instead of denying it exists (#370)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "graft-skel-size-"));
  try {
    writeFileSync(join(dir, "ok.ts"), "export function keep() { return 1; }\n");
    writeFileSync(join(dir, "big.ts"), Buffer.alloc(1_000_001, 0x61));
    const built = await buildGraph(dir);
    assert.equal(built.skipped?.length, 1);
    assert.equal(built.skipped?.[0].path, "big.ts");
    const r = skeleton(dir, "big.ts");
    assert.equal(r.entries.length, 0);
    assert.match(r.note ?? "", /skipped big\.ts/);
    assert.match(r.note ?? "", /1 MB cap/);
    const miss = ask(dir, "zzzzNotASymbolAnywhere");
    assert.match(miss.note ?? "", /skipped big\.ts/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ask reports coverage: 1.0 when every query term hits, low on mostly-off-corpus prompts", async () => {
  const dir = makeFixture();
  try {
    await buildGraph(dir);
    const exact = ask(dir, "addNumbers");
    assert.equal(exact.coverage, 1, "single term, fully matched");
    // Conversational prompt: only "numbers" overlaps the corpus (a common term
    // there, so low idf weight); the six off-corpus words each carry the heavy
    // df=0 weight unmatched, sinking the share under the injection floor.
    const chatty = ask(dir, "thanks looks good please continue numbers tomorrow morning");
    assert.ok(chatty.hits.length > 0, "still returns lexical hits");
    assert.ok((chatty.coverage ?? 1) < 0.15, `coverage should be under the floor, got ${chatty.coverage}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ask file-first selection preserves baseline file order and delays sibling spans", async () => {
  const dir = mkdtempSync(join(tmpdir(), "graft-ask-file-first-"));
  try {
    writeFileSync(
      join(dir, "a.ts"),
      `export function quartzAlpha(): string { return "quartz"; }\n` +
        `export function quartzBeta(): string { return "quartz"; }\n` +
        `export function quartzGamma(): string { return "quartz"; }\n`,
    );
    writeFileSync(join(dir, "b.ts"), `export function quartzDelta(): string { return "quartz"; }\n`);
    writeFileSync(join(dir, "c.ts"), `export function quartzEpsilon(): string { return "quartz"; }\n`);
    await buildGraph(dir);

    const baseline = ask(dir, "quartz", { graphRank: false, limit: 20, fileFirst: false });
    const pathOf = (pointer: string) => pointer.split(":")[0];
    const baselineFiles = baseline.hits.map((hit) => pathOf(hit.pointer));
    const baselineFileOrder = [...new Set(baselineFiles)];
    assert.ok(baselineFileOrder.length >= 3, "fixture produces at least three ranked files");
    assert.ok(new Set(baselineFiles.slice(0, 3)).size < 3, "baseline prefix contains sibling spans");

    const selected = ask(dir, "quartz", { graphRank: false, limit: 20 });
    const selectedFiles = selected.hits.map((hit) => pathOf(hit.pointer));
    assert.deepEqual(
      selectedFiles.slice(0, baselineFileOrder.length),
      baselineFileOrder,
      "the first pass is the exact baseline first-occurrence file order",
    );
    assert.equal(selected.hits[0].pointer, baseline.hits[0].pointer, "top hit is frozen by construction");
    assert.equal(selected.coverage, baseline.coverage, "top-hit relevance coverage is unchanged");
    assert.equal(selected.coverageStrong, baseline.coverageStrong, "top-hit strength coverage is unchanged");
    assert.ok(
      selectedFiles.slice(baselineFileOrder.length).includes("a.ts"),
      "later rounds retain additional exact spans instead of imposing quota one",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ask bounded file scoring rewards one anchor without moving singleton scores", async () => {
  const dir = mkdtempSync(join(tmpdir(), "graft-ask-file-complement-"));
  try {
    writeFileSync(
      join(dir, "a.ts"),
      `export function amberShard(): string { return "amber"; }\n` +
        `export function cobaltShard(): string { return "cobalt"; }\n`,
    );
    writeFileSync(
      join(dir, "b.ts"),
      `export function amberCobalt(): string { return "amber cobalt"; }\n`,
    );
    await buildGraph(dir);

    const baseline = ask(dir, "amber cobalt", {
      graphRank: false,
      limit: 20,
      fileFirst: false,
    });
    const bounded = ask(dir, "amber cobalt", {
      graphRank: false,
      limit: 20,
      fileFirst: false,
      fileComplement: true,
    });
    const byTitle = (hits: AskHit[]) => new Map(hits.map((hit) => [hit.title, hit]));
    const baselineByTitle = byTitle(baseline.hits);
    const boundedByTitle = byTitle(bounded.hits);

    const siblingTitles = ["amberShard · function", "cobaltShard · function"];
    const gains = siblingTitles.map((title) => ({
      a0: baselineByTitle.get(title)?.score ?? 0,
      bounded: boundedByTitle.get(title)?.score ?? 0,
    }));
    assert.equal(
      gains.filter((gain) => gain.bounded > gain.a0).length,
      1,
      "only the raw-lexical anchor receives the bounded residual",
    );
    assert.ok(
      Math.max(...gains.map((gain) => gain.bounded)) > Math.max(...gains.map((gain) => gain.a0)),
    );
    assert.equal(
      bounded.hits.filter((hit) => hit.pointer.startsWith("a.ts:")).length,
      1,
      "true file candidates project one representative instead of retaining sibling documents",
    );

    const singletonBefore = baselineByTitle.get("amberCobalt · function")?.score;
    const singletonAfter = boundedByTitle.get("amberCobalt · function")?.score;
    assert.notEqual(singletonBefore, undefined);
    assert.equal(singletonAfter, singletonBefore, "the unrelated singleton keeps its exact score");
    assert.deepEqual(
      bounded.hits.map((hit) => hit.score),
      [...bounded.hits].map((hit) => hit.score).sort((a, b) => b - a),
      "the adapter keeps score-sorted symbol selection when file-first is disabled",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("default file-aware ranking locks the exact baseline top hit and delays secondary spans", async () => {
  const dir = mkdtempSync(join(tmpdir(), "graft-ask-a5-lock-"));
  try {
    writeFileSync(
      join(dir, "a.ts"),
      `export function amberShard(): string { return "amber"; }\n` +
        `export function cobaltShard(): string { return "cobalt"; }\n`,
    );
    writeFileSync(
      join(dir, "b.ts"),
      `export function amberCobalt(): string { return "amber cobalt"; }\n`,
    );
    await buildGraph(dir);
    writeFileSync(
      join(dir, "graft", "a5-concept.md"),
      `---\nslug: a5-concept\nname: Aardvark amber cobalt\nsources:\n  - path: b.ts\n---\n` +
        `Amber cobalt behavior overview.\n`,
    );

    const baseline = ask(dir, "amber cobalt", {
      graphRank: false,
      limit: 20,
      fileFirst: false,
    });
    const unlocked = ask(dir, "amber cobalt", {
      graphRank: false,
      limit: 20,
      fileFirst: false,
      fileComplement: true,
    });
    const a5 = ask(dir, "amber cobalt", {
      graphRank: false,
      limit: 20,
    });
    const explicitA5 = ask(dir, "amber cobalt", {
      graphRank: false,
      limit: 20,
      fileFirst: true,
      fileComplement: true,
      fileTopLock: true,
    });

    assert.deepEqual(
      a5,
      explicitA5,
      "the default route is exactly the explicit file-aware configuration",
    );

    assert.equal(baseline.hits[0].kind, "concept", "fixture gives the baseline a concept top hit");
    assert.ok(
      (unlocked.hits.find((hit) => hit.title === "amberShard · function")?.score ?? 0) >
        (baseline.hits.find((hit) => hit.title === "amberShard · function")?.score ?? 0),
      "the fixture exercises a live bounded file-score gain under the locked top",
    );
    assert.deepEqual(
      {
        kind: a5.hits[0].kind,
        title: a5.hits[0].title,
        pointer: a5.hits[0].pointer,
        score: a5.hits[0].score,
      },
      {
        kind: baseline.hits[0].kind,
        title: baseline.hits[0].title,
        pointer: baseline.hits[0].pointer,
        score: baseline.hits[0].score,
      },
      "file-aware ranking preserves the exact baseline top candidate, including concepts",
    );
    assert.equal(a5.coverage, baseline.coverage);
    assert.equal(a5.coverageStrong, baseline.coverageStrong);

    const symbolFiles = a5.hits
      .filter((hit) => hit.kind === "symbol")
      .map((hit) => hit.pointer.split(":")[0]);
    assert.deepEqual(symbolFiles.slice(0, 2), ["b.ts", "a.ts"]);
    assert.ok(
      symbolFiles.slice(2).includes("a.ts"),
      "file-aware ranking retains a.ts's second exact span after both files emitted a leader",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("bounded file grouping happens before the output limit", async () => {
  const dir = mkdtempSync(join(tmpdir(), "graft-ask-file-before-limit-"));
  try {
    const crowded = Array.from(
      { length: 45 },
      (_, index) => `export function crowded${index}(): string { return "needle"; }\n`,
    ).join("");
    writeFileSync(join(dir, "crowded.ts"), crowded);
    writeFileSync(
      join(dir, "other.ts"),
      `export function other(): string { return "needle"; }\n`,
    );
    await buildGraph(dir);

    const result = ask(dir, "needle", {
      graphRank: false,
      limit: 2,
      fileFirst: false,
      fileComplement: true,
    });
    const files = result.hits.map((hit) => hit.pointer.split(":")[0]);

    assert.equal(result.hits.length, 2);
    assert.deepEqual(new Set(files), new Set(["crowded.ts", "other.ts"]));
    const a5 = ask(dir, "needle", {
      graphRank: false,
      limit: 2,
      fileComplement: true,
      fileTopLock: true,
    });
    assert.deepEqual(
      new Set(a5.hits.map((hit) => hit.pointer.split(":")[0])),
      new Set(["crowded.ts", "other.ts"]),
      "file-aware ranking groups the complete candidate set before applying the output limit",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ask bounded file scoring keeps the source first and preserves the outer test penalty", async () => {
  const dir = mkdtempSync(join(tmpdir(), "graft-ask-file-complement-tests-"));
  try {
    writeFileSync(
      join(dir, "download.ts"),
      `export function downloadStallFallback(): string { return "download stall fallback"; }\n`,
    );
    writeFileSync(
      join(dir, "download.test.ts"),
      `export function testDownloadStall(): string { return "download stall"; }\n` +
        `export function testDownloadFallback(): string { return "download fallback"; }\n`,
    );
    await buildGraph(dir);

    const options = { graphRank: false, limit: 20, fileFirst: false } as const;
    const baseline = ask(dir, "download stall fallback", {
      ...options,
    });
    const bounded = ask(dir, "download stall fallback", {
      ...options,
      fileComplement: true,
    });
    const scoreByPointer = (hits: AskHit[]) => new Map(hits.map((hit) => [hit.pointer, hit.score]));
    const baselineScores = scoreByPointer(baseline.hits);
    const boundedScores = scoreByPointer(bounded.hits);

    assert.match(bounded.hits[0].pointer, /^download\.ts:/, "the source definition remains first");
    const testPointers = baseline.hits.filter((hit) => hit.pointer.startsWith("download.test.ts:")).map((hit) => hit.pointer);
    assert.equal(
      testPointers.filter((pointer) => (boundedScores.get(pointer) ?? 0) > (baselineScores.get(pointer) ?? 0)).length,
      1,
      "only one test-file representative receives the discounted file score",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ask finds a symbol by a term that appears only in its body (body-indexing)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "graft-ask-body-"));
  try {
    // "stripe" is nowhere in the name/signature — only inside the body.
    writeFileSync(
      join(dir, "pay.ts"),
      `export function checkout(amount: number): string {\n` +
        `  const token = createStripeCharge(amount);\n` +
        `  return token;\n` +
        `}\n`,
    );
    await buildGraph(dir);
    const r = ask(dir, "stripe");
    const hit = r.hits.find((h) => h.title.startsWith("checkout"));
    assert.ok(hit, "checkout is findable via a term that only appears in its body");
    assert.match(hit.pointer, /^pay\.ts:L\d+-L\d+$/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ask surfaces a file by a term only in its module-level code (file-body indexing)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "graft-ask-file-"));
  try {
    // "telemetry" appears only in a module-level constant — inside no function
    // or class — so only file-level residual indexing can make it findable.
    writeFileSync(
      join(dir, "settings.ts"),
      `export const FEATURE_FLAG_TELEMETRY = false;\n\n` +
        `export function init(): number {\n  return 1;\n}\n`,
    );
    await buildGraph(dir);
    const r = ask(dir, "telemetry");
    const hit = r.hits.find((h) => h.pointer === "settings.ts");
    assert.ok(hit, "the file surfaces via a term that lives only in module-level code");
    assert.ok(hit.title.endsWith("· file"), "it is the file node, pointed at the whole file (no span)");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ask indexes a symbol past the 32KB tree-sitter boundary (chunked parse)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "graft-ask-big-"));
  try {
    // Build a >32KB Python file with the distinctive symbol AFTER the 32KB mark,
    // so it is only reachable if the whole file parsed (string parse caps at 32KB).
    let body = "";
    for (let i = 0; body.length < 40000; i++) body += `def filler_${i}():\n    return ${i}\n\n`;
    body += `def zzz_needle_marker():\n    return "found"\n`;
    assert.ok(body.length > 32768, "fixture must exceed the 32KB parse limit");
    writeFileSync(join(dir, "big.py"), body);
    await buildGraph(dir);
    const r = ask(dir, "zzz_needle_marker");
    assert.ok(
      r.hits.find((h) => h.title.startsWith("zzz_needle_marker")),
      "a symbol defined past the 32KB boundary is indexed and findable",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── Structural intent: resolveSymbol fix + loud fallthrough ────────────────

/** `Cache.get` is called (via `c.get(key)`) from `loadItem`; `unusedHelper` is
 * never called by anything, so structural resolves the subject but finds zero
 * edges. Same shapes the traversal-core fixture (test/graph-traverse.test.ts)
 * uses for the qualified-name bug class. */
function qualifiedFixture(): string {
  const dir = mkdtempSync(join(tmpdir(), "graft-ask-qualified-"));
  writeFileSync(
    join(dir, "cache.ts"),
    `export class Cache {\n` +
      `  get(key: string): string {\n` +
      `    return key;\n` +
      `  }\n` +
      `}\n\n` +
      `export function loadItem(key: string): string {\n` +
      `  const c = new Cache();\n` +
      `  return c.get(key);\n` +
      `}\n\n` +
      `export function unusedHelper(): number {\n` +
      `  return 42;\n` +
      `}\n`,
  );
  return dir;
}

test("ask: 'who calls Cache.get' resolves via qualified id-suffix (the previously-broken case)", async () => {
  const dir = qualifiedFixture();
  try {
    await buildGraph(dir);
    const r = ask(dir, "who calls Cache.get");
    assert.equal(r.mode, "structural");
    assert.equal(r.subject, "get");
    assert.ok(
      r.hits.some((h) => h.title === "loadItem"),
      "loadItem calls Cache.get, and must show up as a caller",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ask: structural subject resolves but has zero edges — falls through to lexical with a loud note", async () => {
  const dir = qualifiedFixture();
  try {
    await buildGraph(dir);
    const r = ask(dir, "who calls unusedHelper");
    assert.equal(r.mode, "lexical", "never a bare empty structural result");
    assert.ok(r.note, "a fallthrough note must be set");
    assert.match(r.note!, /structural index: no entries for 'unusedHelper'/);
    assert.match(r.note!, /graft callers 'unusedHelper'/);
    assert.ok(r.hits.length > 0, "lexical fallback still finds the function by name");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ask: structural intent for an unresolvable subject also falls through with a note, never a silent null", async () => {
  const dir = qualifiedFixture();
  try {
    await buildGraph(dir);
    const r = ask(dir, "who calls NoSuchSymbolXyz");
    assert.notEqual(r.mode, "structural");
    assert.ok(r.note, "a fallthrough note must be set even when nothing resolved");
    assert.match(r.note!, /structural index: no entries for 'NoSuchSymbolXyz'/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("formatAsk: the structural fallthrough note prints prominently, before any hit line", async () => {
  const dir = qualifiedFixture();
  try {
    await buildGraph(dir);
    const r = ask(dir, "who calls unusedHelper");
    const out = formatAsk(r);
    assert.ok(out.startsWith("graft ask —"), "header is the first line");
    const noteIdx = out.indexOf("⚠ structural index: no entries");
    assert.ok(noteIdx > 0, "the note is rendered");
    const firstHitIdx = out.search(/\n1\.\s/); // lexical hit numbering starts at "1. "
    assert.ok(firstHitIdx === -1 || noteIdx < firstHitIdx, "the note prints before any hit");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── Scope-aware ranking: per-scope rank + RRF fusion (multi-scope repos) ────

/** Two sub-projects under one root: `frontend/` (ts, ~6 symbols) and
 * `backend/` (py, ~30 symbols — 5× bigger), each with its own project marker
 * so scope discovery splits them, and each with error-handling symbols so a
 * "how are errors handled" query matches in BOTH scopes. Without fusion the
 * backend's sheer size drowns the frontend's hits. */
function multiScopeFixture(): string {
  const dir = mkdtempSync(join(tmpdir(), "graft-ask-scopes-"));
  mkdirSync(join(dir, "frontend", "src"), { recursive: true });
  mkdirSync(join(dir, "backend"), { recursive: true });
  writeFileSync(join(dir, "frontend", "package.json"), "{}\n");
  writeFileSync(join(dir, "backend", "pyproject.toml"), `[project]\nname = "backend"\n`);
  writeFileSync(
    join(dir, "frontend", "src", "errors.ts"),
    `export function handleErrors(err: Error): string {\n` +
      `  // errors from the ui are handled with a banner\n` +
      `  return renderBanner(err.message);\n` +
      `}\n\n` +
      `export function renderBanner(msg: string): string {\n` +
      `  return "banner: " + msg;\n` +
      `}\n\n` +
      `export function reportErrors(err: Error): string {\n` +
      `  // handled errors are also reported upstream\n` +
      `  return handleErrors(err);\n` +
      `}\n\n` +
      `export function clearBanner(): string {\n  return "";\n}\n\n` +
      `export function bannerVisible(): boolean {\n  return false;\n}\n\n` +
      `export function resetUi(): string {\n  return "reset";\n}\n`,
  );
  let py =
    `def handle_errors(exc):\n` +
    `    """errors are handled by returning a serialized problem response"""\n` +
    `    return {"error": str(exc)}\n\n\n` +
    `def wrap_errors(fn):\n` +
    `    """errors raised by route handlers get handled and logged here"""\n` +
    `    return fn\n\n\n`;
  for (let i = 0; i < 28; i++) py += `def route_${i}(payload):\n    return payload\n\n\n`;
  writeFileSync(join(dir, "backend", "app.py"), py);
  return dir;
}

test("ask on a multi-scope repo: top hits federate both scopes, labeled, with a matched-in footer", async () => {
  const dir = multiScopeFixture();
  try {
    await buildGraph(dir);
    const r = ask(dir, "how are errors handled", { limit: 10 });
    const scopesHit = new Set(r.hits.map((h) => h.scope));
    assert.ok(scopesHit.has("frontend"), "top-10 contains a frontend/ hit despite backend being 5× bigger");
    assert.ok(scopesHit.has("backend"), "top-10 contains a backend/ hit");
    assert.ok(r.scopes, "multi-scope result carries fusion telemetry");
    const out = formatAsk(r);
    assert.match(out, /\[frontend\/\] /, "frontend hits carry a scope label");
    assert.match(out, /\[backend\/\] /, "backend hits carry a scope label");
    assert.match(out, /matched in: .*frontend\/ \(\d+\)/, "footer reports frontend's hit count");
    assert.match(out, /matched in: .*backend\/ \(\d+\)/, "footer reports backend's hit count");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("file-first selection preserves a multi-scope result's top relevance and file order", async () => {
  const dir = multiScopeFixture();
  try {
    await buildGraph(dir);
    const baseline = ask(dir, "how are errors handled", { limit: 30, fileFirst: false });

    const selected = ask(dir, "how are errors handled", { limit: 30 });
    const pathOf = (pointer: string) => pointer.split(":")[0];
    const baselineFileOrder = [...new Set(baseline.hits.map((hit) => pathOf(hit.pointer)))];
    const selectedFiles = selected.hits.map((hit) => pathOf(hit.pointer));

    assert.deepEqual(selectedFiles.slice(0, baselineFileOrder.length), baselineFileOrder);
    assert.equal(selected.hits[0].pointer, baseline.hits[0].pointer);
    assert.equal(selected.coverage, baseline.coverage);
    assert.equal(selected.coverageStrong, baseline.coverageStrong);
    assert.deepEqual(selected.scopes, baseline.scopes, "selection does not alter scope participation metadata");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("bounded scoring applies at most one anchor boost per file before comparable-scope combination", async () => {
  const dir = multiScopeFixture();
  try {
    await buildGraph(dir);
    const query = "errors handled banner reported serialized logged";
    const baseline = ask(dir, query, {
      graphRank: false,
      limit: 100,
      fileFirst: false,
    });
    const bounded = ask(dir, query, {
      graphRank: false,
      limit: 100,
      fileFirst: false,
      fileComplement: true,
    });
    const before = new Map(baseline.hits.map((hit) => [hit.pointer, hit.score]));
    const changedByFile = new Map<string, number>();
    for (const hit of bounded.hits) {
      const old = before.get(hit.pointer);
      assert.notEqual(old, undefined, `${hit.pointer} remains the same concrete candidate`);
      assert.ok(hit.score >= old!, "term pooling never lowers an existing candidate score");
      if (hit.score > old!) {
        const file = hit.pointer.split(":")[0];
        changedByFile.set(file, (changedByFile.get(file) ?? 0) + 1);
      }
    }
    assert.ok(changedByFile.size > 0, "the distributed fixture exercises bounded scoring");
    for (const [file, count] of changedByFile)
      assert.equal(count, 1, `${file} contributes exactly one boosted representative`);
    const emittedFiles = bounded.hits.map((hit) => hit.pointer.split(":")[0]);
    assert.equal(
      new Set(emittedFiles).size,
      emittedFiles.length,
      "comparable-scope combination consumes one representative per exact file",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("file-aware ranking keeps the exact multi-scope baseline top before queue projection", async () => {
  const dir = multiScopeFixture();
  try {
    await buildGraph(dir);
    const query = "errors handled banner reported serialized logged";
    const baseline = ask(dir, query, {
      graphRank: false,
      limit: 100,
      fileFirst: false,
    });
    const a5 = ask(dir, query, {
      graphRank: false,
      limit: 100,
      fileComplement: true,
      fileTopLock: true,
    });

    assert.deepEqual(
      {
        kind: a5.hits[0].kind,
        title: a5.hits[0].title,
        pointer: a5.hits[0].pointer,
        score: a5.hits[0].score,
        scope: a5.hits[0].scope,
      },
      {
        kind: baseline.hits[0].kind,
        title: baseline.hits[0].title,
        pointer: baseline.hits[0].pointer,
        score: baseline.hits[0].score,
        scope: baseline.hits[0].scope,
      },
    );
    assert.equal(a5.coverage, baseline.coverage);
    assert.equal(a5.coverageStrong, baseline.coverageStrong);
    assert.deepEqual(a5.scopes, baseline.scopes);

    const symbolFiles = a5.hits
      .filter((hit) => hit.kind === "symbol")
      .map((hit) => hit.pointer.split(":")[0]);
    const firstDuplicate = symbolFiles.findIndex(
      (file, index) => symbolFiles.indexOf(file) !== index,
    );
    assert.ok(firstDuplicate > 0, "fixture retains at least one secondary span");
    assert.equal(
      new Set(symbolFiles.slice(0, firstDuplicate)).size,
      firstDuplicate,
      "no secondary span appears before every preceding file leader",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** Cross-seam repro (final-review bug): a monorepo-shaped single-graph repo
 * with two marker-carrying sub-scopes — `api/` has REAL symbols named for the
 * query terms; `junk/` has NO such symbol, only a body comment repeating ONE
 * of the two query terms ("gateway", never "timeout") — an incidental
 * single-token collision: `coverageStrong` 0 (no name/path match, file-kind
 * node) and `coverage` well under `HIGH_FLOOR` (the missing term's absence
 * dominates the idf-weighted share) — NOT a case the broad-coverage recall
 * valve is meant to rescue, which requires BOTH terms to appear somewhere.
 * The repetition is load-bearing: it inflates junk's RAW bm25 score to ~34%
 * of api's raw best — ABOVE the OLD `0.25 × raw-lexical-best` ratio gate
 * (the exact gate Task 5 proved "far too lenient, leaks junk" for workspace
 * federation) — so pre-fix, `rankScopesAndFuse` let `junk/` federate beside
 * `api/`'s genuine hits and RRF's rank-only math floated it to rank #2;
 * post-fix, the match-STRENGTH gate (same as `federateAsk`) correctly excludes
 * it regardless of the raw ratio. */
function crossSeamMonorepoFixture(): string {
  const dir = mkdtempSync(join(tmpdir(), "graft-ask-crossseam-"));
  mkdirSync(join(dir, "api"), { recursive: true });
  mkdirSync(join(dir, "junk"), { recursive: true });
  writeFileSync(join(dir, "api", "package.json"), `{ "name": "api", "version": "1.0.0" }\n`);
  writeFileSync(join(dir, "junk", "package.json"), `{ "name": "junk", "version": "1.0.0" }\n`);
  writeFileSync(
    join(dir, "api", "gateway.ts"),
    `/** Thrown when the upstream call exceeds the deadline. */\n` +
      `export class GatewayTimeout extends Error {\n` +
      `  constructor(public readonly ms: number) {\n` +
      `    super(\`gateway timeout after \${ms}ms\`);\n` +
      `  }\n` +
      `}\n\n` +
      `export function callUpstream(ms: number): void {\n` +
      `  if (ms > 5000) throw new GatewayTimeout(ms);\n` +
      `}\n\n` +
      `export function retryUpstream(attempts: number): void {\n` +
      `  for (let i = 0; i < attempts; i++) callUpstream(1000);\n` +
      `}\n\n` +
      `export class UpstreamClient {\n` +
      `  send(payload: string): string {\n    return payload;\n  }\n` +
      `  close(): void {}\n` +
      `}\n\n` +
      `export function buildClient(): UpstreamClient {\n  return new UpstreamClient();\n}\n`,
  );
  writeFileSync(
    join(dir, "junk", "widget.ts"),
    `// gateway gateway gateway gateway gateway gateway gateway gateway gateway\n` +
      `// gateway gateway gateway gateway gateway gateway gateway gateway gateway\n` +
      `// gateway gateway gateway gateway gateway gateway gateway gateway gateway\n` +
      `// unrelated helper widget — nothing to do with upstream call handling at all.\n` +
      `export class Widget {\n` +
      `  render(): string {\n    return "widget";\n  }\n` +
      `  resize(w: number, h: number): void {}\n` +
      `}\n\n` +
      `export class Panel {\n  layout(): void {}\n}\n\n` +
      `export function makeWidget(): Widget {\n  return new Widget();\n}\n\n` +
      `export function makePanel(): Panel {\n  return new Panel();\n}\n`,
  );
  return dir;
}

test("cross-seam fix: a monorepo scope with only a body-comment collision is gated to alsoMatched, not ranked ahead of the genuine scope", async () => {
  const dir = crossSeamMonorepoFixture();
  try {
    await buildGraph(dir);
    const r = ask(dir, "gateway timeout", { limit: 10 });
    assert.ok(
      !r.hits.some((h) => h.scope === "junk"),
      `junk/ must not appear in the ranked hits at all, got: ${r.hits.map((h) => `[${h.scope}] ${h.title}`).join(", ")}`,
    );
    assert.ok(r.hits.some((h) => h.scope === "api"), "api/'s genuine hits still rank");
    assert.ok(r.scopes, "fusion telemetry present");
    assert.ok(
      r.scopes!.alsoMatched.some((m) => m.scope === "junk"),
      "junk/ must be reported in alsoMatched instead",
    );
    const out = formatAsk(r);
    assert.match(out, /also matched: junk\/ — narrow with --in junk\//, `expected an alsoMatched footer, got:\n${out}`);
    assert.doesNotMatch(out, /\[junk\/\]/, "no junk/-labeled hit anywhere in the rendered output");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── `--in <path-prefix>`: filter docs before scoring ────────────────────────

/** `prefix/docA.ts` + `prefix-sibling/docB.ts` — a plain `path.startsWith`
 * would wrongly let "prefix" match "prefix-sibling" too; segment-aware
 * matching (same rule as `scopeOf`) must not. */
function siblingPrefixFixture(): string {
  const dir = mkdtempSync(join(tmpdir(), "graft-ask-in-sibling-"));
  mkdirSync(join(dir, "widgets"), { recursive: true });
  mkdirSync(join(dir, "widgets-extra"), { recursive: true });
  writeFileSync(join(dir, "widgets", "a.ts"), `export function needlefind(): number {\n  return 1;\n}\n`);
  writeFileSync(join(dir, "widgets-extra", "b.ts"), `export function needlefind2(): number {\n  return 2;\n}\n`);
  return dir;
}

test("ask --in: filters to nodes under the prefix, segment-aware ('widgets' must not match 'widgets-extra')", async () => {
  const dir = siblingPrefixFixture();
  try {
    await buildGraph(dir);
    const r = ask(dir, "needlefind", { in: "widgets", limit: 20 });
    assert.ok(r.hits.length > 0, "the widgets/ hit is still found");
    assert.ok(
      r.hits.every((h) => h.pointer.startsWith("widgets/")),
      `every hit must be under widgets/, got: ${r.hits.map((h) => h.pointer).join(", ")}`,
    );
    assert.ok(
      !r.hits.some((h) => h.pointer.startsWith("widgets-extra/")),
      "widgets-extra/ must NOT be pulled in by a naive substring/prefix match",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** `filler/` (30 files) all define `zzzcommonword`, making it common GLOBALLY
 * (low idf); `proj/` has `zzzraretoken` (+ a duplicate, so it's the common
 * term LOCALLY once filler/ is filtered out) and `zzzcommonword_b` (rare
 * locally, once filler/ is gone). This flips which one outranks the other
 * between the unfiltered and `--in`-filtered corpora — proof `--in` recomputes
 * idf over the filtered set rather than reusing the global one. */
function idfShiftFixture(): string {
  const dir = mkdtempSync(join(tmpdir(), "graft-ask-in-idf-"));
  mkdirSync(join(dir, "filler"), { recursive: true });
  mkdirSync(join(dir, "proj"), { recursive: true });
  for (let i = 0; i < 30; i++) {
    writeFileSync(join(dir, "filler", `f${i}.ts`), `export function zzzcommonword(): number {\n  return ${i};\n}\n`);
  }
  writeFileSync(join(dir, "proj", "docA.ts"), `export function zzzraretoken(): number {\n  return 1;\n}\n`);
  writeFileSync(join(dir, "proj", "docC.ts"), `export function zzzraretoken_dup(): number {\n  return 2;\n}\n`);
  writeFileSync(join(dir, "proj", "docB.ts"), `export function zzzcommonword_b(): number {\n  return 3;\n}\n`);
  return dir;
}

test("ask --in: per-scope idf differs from global — a term's rank flips relative to another between filtered and unfiltered", async () => {
  const dir = idfShiftFixture();
  try {
    await buildGraph(dir);
    const query = "zzzraretoken zzzcommonword";
    const rankOf = (r: ReturnType<typeof ask>["hits"], title: string) => r.findIndex((h) => h.title.startsWith(title));

    const global = ask(dir, query, { limit: 40 });
    const rareGlobal = rankOf(global.hits, "zzzraretoken ");
    const commonBGlobal = rankOf(global.hits, "zzzcommonword_b");
    assert.ok(rareGlobal >= 0 && commonBGlobal >= 0, "both candidates present globally");
    assert.ok(rareGlobal < commonBGlobal, "globally, the rare term (high idf) outranks the diluted common term");

    const filtered = ask(dir, query, { limit: 40, in: "proj" });
    const rareFiltered = rankOf(filtered.hits, "zzzraretoken ");
    const commonBFiltered = rankOf(filtered.hits, "zzzcommonword_b");
    assert.ok(rareFiltered >= 0 && commonBFiltered >= 0, "both candidates present filtered");
    assert.ok(
      commonBFiltered < rareFiltered,
      "filtered to proj/, zzzcommonword_b (now the locally-rare term) overtakes zzzraretoken (now locally-common)",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ask --in: unknown/no-match prefix throws a scope-enumerating error", async () => {
  const dir = multiScopeFixture();
  try {
    await buildGraph(dir);
    assert.throws(
      () => ask(dir, "how are errors handled", { in: "wrong" }),
      /nothing indexed under "wrong\/" — scopes here: .*frontend\/.*backend\/.* \(or any path prefix\)/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ask --in: unknown prefix on a single-scope repo throws without a scopes-here clause", async () => {
  const dir = makeFixture();
  try {
    await buildGraph(dir);
    assert.throws(() => ask(dir, "addNumbers", { in: "nosuchdir" }), /nothing indexed under "nosuchdir\/"/);
    assert.throws(() => ask(dir, "addNumbers", { in: "nosuchdir" }), (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.doesNotMatch(err.message, /scopes here:/);
      assert.match(err.message, /\(or any path prefix\)/);
      return true;
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI: `graft ask --in <unknown>` exits 1 with the scope-enumerating error on stderr", async () => {
  const dir = multiScopeFixture();
  try {
    await buildGraph(dir);
    let threw: (Error & { status?: number; stderr?: string }) | undefined;
    try {
      execFileSync(
        process.execPath,
        ["--import", "tsx", "src/cli.ts", "ask", "how are errors handled", dir, "--in", "wrong"],
        { encoding: "utf8", stdio: "pipe" },
      );
    } catch (err) {
      threw = err as Error & { status?: number; stderr?: string };
    }
    assert.ok(threw, "the CLI must exit non-zero");
    assert.equal(threw!.status, 1);
    assert.match(threw!.stderr ?? "", /✗ nothing indexed under "wrong\/"/);
    assert.match(threw!.stderr ?? "", /scopes here:.*frontend\/.*backend\//);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ask: a zero-hit query on a multi-scope graph appends scope enumeration to the empty note", async () => {
  const dir = multiScopeFixture();
  try {
    await buildGraph(dir);
    const r = ask(dir, "zzzznomatchatallxyz");
    assert.equal(r.mode, "empty");
    assert.match(r.note ?? "", /no matching nodes — try different words/);
    assert.match(r.note ?? "", /scopes here: .*frontend\/.*backend\//);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ask --in on the multi-scope fixture: filtering to one scope carries no scope labels, even though the repo is multi-scope", async () => {
  const dir = multiScopeFixture();
  try {
    await buildGraph(dir);
    const r = ask(dir, "how are errors handled", { limit: 10, in: "frontend" });
    assert.ok(r.hits.length > 0);
    assert.ok(
      r.hits.every((h) => h.scope === "frontend"),
      "only frontend/ hits survive the filter",
    );
    assert.equal(r.scopes, undefined, "single scope remaining under the prefix — no fusion metadata");
    const out = formatAsk(r);
    assert.doesNotMatch(out, /\[frontend\/\] |\[backend\/\] |matched in:|also matched:/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── Review fix: `--in` must not blind the sidecar's per-doc body bags ──────

/** A term that appears ONLY in a function's body (never its name/signature),
 * same shape as the pre-existing body-indexing test — but the node lives
 * inside a directory that IS the `--in` prefix, so this catches the sidecar
 * bypass bug: a build writes `body_text` into `.cache/ask-index.json` and
 * then strips it from `wiring.json` (see `write.ts`), so a graph loaded from
 * disk has NO other source for body tokens. Disabling the sidecar under
 * `--in` (rather than just its global df/avgdl) silently empties every
 * node's body bag, making a body-only term unfindable everywhere, including
 * under its own directory. */
test("ask --in: a body-only term is still found when filtered to its own directory (sidecar body bags must survive --in)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "graft-ask-in-body-"));
  try {
    mkdirSync(join(dir, "widgets"), { recursive: true });
    writeFileSync(
      join(dir, "widgets", "pay.ts"),
      `export function checkout(amount: number): string {\n` +
        `  const token = createStripeCharge(amount);\n` +
        `  return token;\n` +
        `}\n`,
    );
    await buildGraph(dir);
    // Unfiltered: sanity-check the term is findable at all (pins the existing
    // body-indexing contract this test's fixture depends on).
    const unfiltered = ask(dir, "stripe");
    assert.ok(unfiltered.hits.some((h) => h.title.startsWith("checkout")), "sanity: findable unfiltered");

    const r = ask(dir, "stripe", { in: "widgets" });
    const hit = r.hits.find((h) => h.title.startsWith("checkout"));
    assert.ok(hit, "checkout must still be findable via its body-only term when --in filters to its OWN directory");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── Review fix: `--in` accepts a trailing slash ─────────────────────────────

test("ask --in: a trailing slash is accepted — `--in frontend/` behaves exactly like `--in frontend`", async () => {
  const dir = multiScopeFixture();
  try {
    await buildGraph(dir);
    const withSlash = ask(dir, "how are errors handled", { limit: 10, in: "frontend/" });
    const withoutSlash = ask(dir, "how are errors handled", { limit: 10, in: "frontend" });
    assert.ok(withSlash.hits.length > 0, "the tool's own suggested `--in scope/` (with slash) must not come up empty");
    assert.deepEqual(
      withSlash.hits.map((h) => h.pointer),
      withoutSlash.hits.map((h) => h.pointer),
      "trailing slash must not change which hits are returned",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── Review fix: `--in` must also narrow structural queries, not silently no-op ──

/** Same symbol NAME (`handle`) defined independently in two directories, each
 * with its own distinct caller — `resolveSymbol` matches both by name alone,
 * so without `--in` a structural query's subject is ambiguous (both nodes),
 * and both callers show up. `--in` must narrow the SUBJECT resolution to the
 * one under the prefix (same "narrow resolveSymbol" semantics
 * `callers`/`callees`/`impact --in` already have), not just filter docs. */
function duplicateNameFixture(): string {
  const dir = mkdtempSync(join(tmpdir(), "graft-ask-in-structural-"));
  mkdirSync(join(dir, "frontend"), { recursive: true });
  mkdirSync(join(dir, "backend"), { recursive: true });
  writeFileSync(
    join(dir, "frontend", "a.ts"),
    `export function handle(): number {\n  return 1;\n}\n\n` +
      `export function frontendCaller(): number {\n  return handle();\n}\n`,
  );
  writeFileSync(
    join(dir, "backend", "b.ts"),
    `export function handle(): number {\n  return 2;\n}\n\n` +
      `export function backendCaller(): number {\n  return handle();\n}\n`,
  );
  return dir;
}

test("ask --in: structural queries narrow the resolved subject by prefix, not just the lexical docs", async () => {
  const dir = duplicateNameFixture();
  try {
    await buildGraph(dir);

    const unfiltered = ask(dir, "who calls handle");
    assert.equal(unfiltered.mode, "structural");
    assert.ok(unfiltered.hits.some((h) => h.title === "frontendCaller"), "sanity: both callers show up unfiltered");
    assert.ok(unfiltered.hits.some((h) => h.title === "backendCaller"), "sanity: both callers show up unfiltered");

    const r = ask(dir, "who calls handle", { in: "frontend" });
    assert.equal(r.mode, "structural", "still resolves structurally once narrowed to frontend's handle");
    assert.ok(r.hits.some((h) => h.title === "frontendCaller"), "frontend's caller must be found");
    assert.ok(
      !r.hits.some((h) => h.title === "backendCaller"),
      "backend's handle/caller must not leak in when --in=frontend",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ask --in: a structural subject that exists ONLY outside the prefix falls through loudly, never a silent no-op", async () => {
  const dir = duplicateNameFixture();
  try {
    await buildGraph(dir);
    // "handle" only resolves under backend/ once frontend/ is filtered out via
    // an --in that excludes it entirely (a prefix with no "handle" at all).
    mkdirSync(join(dir, "docs"), { recursive: true });
    writeFileSync(join(dir, "docs", "readme.ts"), `export function docsOnly(): number {\n  return 0;\n}\n`);
    await buildGraph(dir);
    const r = ask(dir, "who calls handle", { in: "docs" });
    assert.notEqual(r.mode, "structural", "no `handle` under docs/ — must fall through, not silently return nothing");
    assert.ok(r.note, "a fallthrough note must be set");
    assert.match(r.note!, /structural index: no entries for 'handle'/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** The regression pin Task 7's cross-version gate relies on: on a single-scope
 * graph the fusion code paths must be completely inert. `meta.scopes` hand-set
 * to the canonical single form vs deleted (an old graph) must produce
 * byte-identical `formatAsk` output — the early branch keys on
 * `scopesOfGraph(graph).length <= 1`, and both forms take it. */
test("regression pin: single-scope ask output is byte-equal with canonical meta.scopes vs no meta.scopes", async () => {
  const dir = makeFixture();
  try {
    await buildGraph(dir);
    const p = join(dir, "graft", ".graph", "wiring.json");
    const g = JSON.parse(readFileSync(p, "utf8"));
    delete g.meta.scopes;
    writeFileSync(p, JSON.stringify(g));
    const absent = formatAsk(ask(dir, "addNumbers", { source: true }));
    g.meta.scopes = [{ prefix: "", label: "", markers: [] }];
    writeFileSync(p, JSON.stringify(g));
    const canonical = formatAsk(ask(dir, "addNumbers", { source: true }));
    assert.equal(canonical, absent, "single-scope output must not drift by a byte");
    assert.doesNotMatch(absent, /matched in:|also matched:|\[\w+\/\] /, "zero new output on single-scope");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ask with source inlines the actual span from disk", async () => {
  const dir = makeFixture();
  try {
    await buildGraph(dir);
    const r = ask(dir, "addNumbers", { source: true });
    const hit = r.hits.find((h) => h.title.startsWith("addNumbers"));
    assert.ok(hit, "should locate the addNumbers symbol");
    assert.ok(hit.code, "source should be inlined");
    assert.match(hit.code, /return a \+ b;/, "inlined code is the real definition body");
    // formatAsk renders it as a fenced block so it drops into agent context.
    assert.match(formatAsk(r), /```[\s\S]*return a \+ b;[\s\S]*```/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
