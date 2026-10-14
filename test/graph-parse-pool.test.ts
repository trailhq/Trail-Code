import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { availableParallelism, tmpdir } from "node:os";
import { join } from "node:path";
import { extractOne } from "../src/graph/extract-one.js";
import { warmGenericGrammars } from "../src/graph/generic.js";
import { listSourceStats } from "../src/graph/source-files.js";
import { contentHash } from "../src/util/id.js";

const RS = "pub fn f() {}\npub fn g() { f() }\n";

function repo(): string {
  const d = mkdtempSync(join(tmpdir(), "graft-pool-"));
  mkdirSync(join(d, "src"), { recursive: true });
  writeFileSync(join(d, "src", "math.ts"), "export function add(a: number, b: number): number { return a + b; }\n");
  writeFileSync(join(d, "src", "lib.rs"), RS);
  return d;
}

test("extractOne: a fresh file is parsed and its entry carries the tier label", async () => {
  const d = repo();
  await warmGenericGrammars(["rust"]);
  const files = listSourceStats(d, join(d, "graft"));
  const rs = files.find((f) => f.rel === "src/lib.rs")!;
  const ts = files.find((f) => f.rel === "src/math.ts")!;
  const r1 = extractOne(rs, null);
  assert.equal(r1.kind, "parsed");
  if (r1.kind !== "parsed") return;
  assert.equal(r1.label, "rust");
  assert.ok(r1.entry.nodes.some((n) => n.id === "src/lib.rs#f"));
  assert.equal(r1.entry.hash, contentHash(RS));
  const r2 = extractOne(ts, null);
  assert.equal(r2.kind, "parsed");
  if (r2.kind !== "parsed") return;
  assert.equal(r2.label, "typescript");
});

test("extractOne: matching bytes report reused without parsing", () => {
  const d = repo();
  const rs = listSourceStats(d, join(d, "graft")).find((f) => f.rel === "src/lib.rs")!;
  assert.deepEqual(extractOne(rs, contentHash(RS)), { kind: "reused", hash: contentHash(RS) });
});

test("extractOne: an unreadable file is skipped with an empty-hash entry that names the file", () => {
  const r = extractOne({ abs: join(tmpdir(), "does-not-exist-graft.rs"), rel: "nope.rs", size: 0, mtimeMs: 0 }, null);
  assert.equal(r.kind, "skipped");
  if (r.kind !== "skipped") return;
  assert.equal(r.entry.hash, "");
  assert.match(r.entry.error ?? "", /^nope\.rs: /);
});

import { buildGraph } from "../src/graph/build.js";
import { readGraph, wiringPath } from "../src/graph/write.js";
import { contextDirFor } from "../src/context/node-file.js";
import type { CruxSummarizer, FileCruxInput, NodeCrux } from "../src/ai/crux.js";

/** Same shape as RecordingCrux in test/graph-enrich-checkpoint.test.ts. */
class TrivialCrux implements CruxSummarizer {
  calls: string[] = [];
  async describeFile(input: FileCruxInput): Promise<NodeCrux[]> {
    this.calls.push(input.path);
    return input.nodes.map((n) => ({ id: n.id, summary: `crux ${n.id}`, crux_start: 0, crux_end: 0 }));
  }
}

test("a --deep build summarizes from disk without buildGraph holding every source", async () => {
  const d = repo();
  const crux = new TrivialCrux();
  const r = await buildGraph(d, { reuse: false, summarizer: crux });
  assert.equal(r.errors.length, 0, r.errors.join("; "));
  assert.ok(crux.calls.includes("src/lib.rs"));
  const g = readGraph(wiringPath(contextDirFor(d)))!;
  assert.equal(g.nodes.find((n) => n.id === "src/lib.rs#f")!.summary_state, "ready");
});

test("a file edited between parse and summary is left pending, not summarized against the wrong lines", async () => {
  const d = repo();
  // With concurrency 1 the enrich pass visits files in dirty-node order, which is
  // `listSourceStats` order: src/lib.rs first, then src/math.ts. On the FIRST
  // describeFile call (src/lib.rs) we edit the file summarized SECOND (src/math.ts)
  // so its on-disk bytes no longer hash to what was parsed. buildGraph's
  // SourceLookup.get re-hashes before handing over the source and returns undefined
  // on a mismatch, so src/math.ts is left pending — never summarized against changed
  // bytes. Drop that hash check and math.ts goes "ready" here, which is the bug.
  let edited = false;
  const crux: CruxSummarizer = {
    async describeFile(input) {
      if (!edited) { edited = true; writeFileSync(join(d, "src", "math.ts"), "export function add(a: number, b: number): number {\n  return a + b + 0;\n}\n"); }
      return input.nodes.map((n) => ({ id: n.id, summary: `crux ${n.id}`, crux_start: 0, crux_end: 0 }));
    },
  };
  const r = await buildGraph(d, { reuse: false, summarizer: crux, concurrency: 1 });
  assert.equal(r.errors.length, 0, r.errors.join("; "));
  const g = readGraph(wiringPath(contextDirFor(d)))!;
  const first = g.nodes.filter((n) => n.path === "src/lib.rs");
  const second = g.nodes.filter((n) => n.path === "src/math.ts");
  assert.ok(first.length > 0, "src/lib.rs contributed nodes");
  assert.ok(second.length > 0, "src/math.ts contributed nodes");
  // The first file was summarized against the exact bytes it was parsed from.
  for (const n of first) assert.equal(n.summary_state, "ready", `${n.id} should be ready`);
  // The second file changed on disk between parse and summary; every one of its
  // nodes must be left pending — never a "ready" summary computed against the
  // wrong lines. This is what fails if the hash check in SourceLookup.get is gone.
  for (const n of second) assert.notEqual(n.summary_state, "ready", `${n.id} must not be ready against changed bytes`);
});

import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { PARSE_POOL_MIN_FILES, parseWorkerEntry, poolSize, runParsePool } from "../src/graph/parse-pool.js";

test("poolSize: 0 unless GRAFT_PARSE_WORKERS is set or the caller asks; then bounded by cores, memory and work", () => {
  assert.equal(poolSize(100_000, {}, 8, 64e9), 0, "never automatic");
  assert.equal(poolSize(100_000, { GRAFT_PARSE_WORKERS: "0" }, 8, 64e9), 0);
  assert.equal(poolSize(100_000, { GRAFT_PARSE_WORKERS: "3" }, 8, 64e9), 3);
  assert.equal(poolSize(100_000, { GRAFT_PARSE_WORKERS: "auto" }, 8, 64e9), 7, "auto = cores - 1");
  assert.equal(poolSize(100_000, { GRAFT_PARSE_WORKERS: "auto" }, 64, 1e9), 3, "memory-capped at ~300 MB per child");
  assert.equal(poolSize(50, { GRAFT_PARSE_WORKERS: "auto" }, 64, 64e9), 0, "under the minimum, in-thread");
  assert.equal(poolSize(PARSE_POOL_MIN_FILES * 2, { GRAFT_PARSE_WORKERS: "auto" }, 64, 64e9), 2, "work-capped");
  assert.equal(poolSize(100_000, { GRAFT_PARSE_WORKERS: "garbage" }, 8, 64e9), 0, "unparseable = in-thread");
});

test("parseWorkerEntry points at a file that exists", () => {
  assert.ok(existsSync(parseWorkerEntry()), parseWorkerEntry());
});

test("runParsePool returns the same results, in file order, as extractOne in-thread", async () => {
  const d = repo();
  for (let i = 0; i < 30; i++) writeFileSync(join(d, "src", `m${i}.rs`), `pub fn m${i}() { f() }\n`);
  await warmGenericGrammars(["rust"]);
  const files = listSourceStats(d, join(d, "graft"));
  const inThread = files.map((f) => extractOne(f, null));
  const pooled = await runParsePool(files, () => null, { generic: ["rust"], container: [] }, { workers: 2 });
  assert.deepEqual(pooled, inThread);
});

test("runParsePool honours cachedHash and reports reused", async () => {
  const d = repo();
  const files = listSourceStats(d, join(d, "graft"));
  const rs = files.find((f) => f.rel === "src/lib.rs")!;
  const pooled = await runParsePool(files, (rel) => (rel === rs.rel ? contentHash(RS) : null), { generic: ["rust"], container: [] }, { workers: 2 });
  assert.deepEqual(pooled[files.indexOf(rs)], { kind: "reused", hash: contentHash(RS) });
});

/** A child entry that behaves like parse-worker.ts except where `mode` says otherwise.
 * `slow-stop` logs each child's start to `spawned.log`, warms slowly, crashes 500 ms
 * into a boom job, and lingers 1200 ms after `stop` before its clean exit.
 * `retire-waits` marks every result `retire` and then, like parse-worker.ts, exits
 * only when the pool sends `stop`. */
function fakeWorker(dir: string, mode: "crash-on-boom" | "never-ready" | "always-crash" | "hang-on-boom" | "slow-stop" | "retire-waits"): string {
  const entry = join(dir, `worker-${mode}.mjs`);
  const src = pathToFileURL(join(process.cwd(), "src", "graph")).href;
  writeFileSync(entry, [
    `import { appendFileSync } from "node:fs";`,
    `import { extractOne } from ${JSON.stringify(src + "/extract-one.ts")};`,
    `import { warmGenericGrammars } from ${JSON.stringify(src + "/generic.ts")};`,
    `const mode = ${JSON.stringify(mode)};`,
    `if (mode === 'slow-stop') appendFileSync(${JSON.stringify(join(dir, "spawned.log"))}, process.pid + "\\n");`,
    "const sleep = (ms) => new Promise((r) => setTimeout(r, ms));",
    "process.on('message', async (m) => {",
    "  if (m.type === 'init') {",
    "    if (mode === 'never-ready') return;",
    "    await warmGenericGrammars(m.generic);",
    "    if (mode === 'slow-stop') await sleep(1500);",
    "    process.send({ type: 'ready' });",
    "  } else if (m.type === 'job') {",
    "    const boom = m.f.rel.endsWith('boom.rs');",
    "    if (mode === 'always-crash' || (mode === 'crash-on-boom' && boom)) process.exit(9);",
    "    if (mode === 'hang-on-boom' && boom) return;",
    "    if (mode === 'slow-stop' && boom) { setTimeout(() => process.exit(9), 500); return; }",
    "    const done = { type: 'done', seq: m.seq, result: extractOne(m.f, m.cachedHash) };",
    "    if (mode === 'retire-waits') done.retire = true;",
    "    process.send(done);",
    "  } else if (m.type === 'stop') {",
    "    if (mode === 'slow-stop') setTimeout(() => process.exit(0), 1200); else process.exit(0);",
    "  }",
    "});",
    "process.on('disconnect', () => process.exit(0));",
  ].join("\n"));
  return entry;
}

/** The real parse-worker.ts, with a listener registered ahead of its own that
 * swaps the rust grammar for one that aborts like a real Emscripten abort when a
 * `*boom.rs` job arrives — so the child's WASM runtime is poisoned for real. */
function poisoningWorker(dir: string): string {
  const src = pathToFileURL(join(process.cwd(), "src", "graph")).href;
  const swap = join(dir, "swap-on-boom.mjs");
  writeFileSync(swap, [
    `import { swapGrammarForTest } from ${JSON.stringify(src + "/generic.ts")};`,
    "process.on('message', (m) => {",
    "  if (m.type !== 'job' || !m.f.rel.endsWith('boom.rs')) return;",
    "  const real = swapGrammarForTest('rust', null);",
    "  swapGrammarForTest('rust', { language: real.language, query: real.query,",
    "    parser: { parse() { throw new WebAssembly.RuntimeError('Aborted(). test abort'); }, reset() {}, delete() {} } });",
    "});",
  ].join("\n"));
  const entry = join(dir, "worker-poisoning.mjs");
  writeFileSync(entry, [
    `import ${JSON.stringify(pathToFileURL(swap).href)};`,
    `import ${JSON.stringify(src + "/parse-worker.ts")};`,
  ].join("\n"));
  return entry;
}

const byRel = (files: ReturnType<typeof listSourceStats>) => files.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));

test("runParsePool: a child whose WASM runtime is poisoned is stopped after its result and replaced free of charge", async () => {
  const d = repo();
  for (const n of [1, 2, 3]) writeFileSync(join(d, "src", `a${n}boom.rs`), `pub fn b${n}() {}\n`);
  for (let i = 0; i < 4; i++) writeFileSync(join(d, "src", `z${i}.rs`), `pub fn z${i}() {}\n`);
  await warmGenericGrammars(["rust"]);
  const files = byRel(listSourceStats(d, join(d, "graft")));
  let fellBack = false;
  // One worker, three poisoning files: three retirements against a respawn budget of 2.
  const results = await runParsePool(files, () => null, { generic: ["rust"], container: [] }, {
    workers: 1, entry: poisoningWorker(d), onFallback: () => { fellBack = true; },
  });
  files.forEach((f, i) => {
    const r = results[i];
    if (f.rel.endsWith("boom.rs")) {
      assert.equal(r.kind, "error", f.rel);
      if (r.kind === "error") assert.match(r.message, /Aborted\(\)/, "the child's own result, not a retry");
    } else {
      assert.equal(r.kind, "parsed", `${f.rel}: ${r.kind === "error" ? r.message : r.kind}`);
    }
  });
  assert.equal(fellBack, false, "a retirement is not a crash: the pool never fell back to in-thread");
});

test("runParsePool: a retiring child is told to stop; it never has to race its result with its own exit", { timeout: 60_000 }, async () => {
  const d = repo();
  for (let i = 0; i < 3; i++) writeFileSync(join(d, "src", `r${i}.rs`), `pub fn r${i}() {}\n`);
  await warmGenericGrammars(["rust"]);
  const files = listSourceStats(d, join(d, "graft"));
  let fellBack = false;
  // The fake exits only on `stop`. A pool that waits for a retiring child to exit
  // by itself hangs here (and the test times out).
  const results = await runParsePool(files, () => null, { generic: ["rust"], container: [] }, {
    workers: 1, entry: fakeWorker(d, "retire-waits"), onFallback: () => { fellBack = true; },
  });
  assert.deepEqual(results, files.map((f) => extractOne(f, null)), "every result came from a child, once");
  assert.equal(fellBack, false);
});

test("runParsePool: past workers * 4 retirements each one costs a respawn credit, so an always-poisoning grammar falls back", { timeout: 120_000 }, async () => {
  const d = mkdtempSync(join(tmpdir(), "graft-pool-retire-"));
  mkdirSync(join(d, "src"), { recursive: true });
  // Every file poisons the child that parses it.
  for (let i = 0; i < 12; i++) writeFileSync(join(d, "src", `f${String(i).padStart(2, "0")}boom.rs`), `pub fn f${i}() {}\n`);
  await warmGenericGrammars(["rust"]);
  const files = byRel(listSourceStats(d, join(d, "graft")));
  let fellBack = false;
  // One worker: 4 free retirements, then one credit each against a budget of 2,
  // so the 7th retirement exhausts it and the parent parses the remaining 5.
  const results = await runParsePool(files, () => null, { generic: ["rust"], container: [] }, {
    workers: 1, entry: poisoningWorker(d), onFallback: () => { fellBack = true; },
  });
  assert.equal(fellBack, true, "the pool gave up instead of forking a child per file");
  assert.deepEqual(results.map((r) => r.kind), [...Array(7).fill("error"), ...Array(5).fill("parsed")]);
});

test("runParsePool: a parked file keeps its real content hash", async () => {
  const d = repo();
  writeFileSync(join(d, "src", "boom.rs"), "pub fn boom() {}\n");
  await warmGenericGrammars(["rust"]);
  const files = listSourceStats(d, join(d, "graft"));
  const results = await runParsePool(files, () => null, { generic: ["rust"], container: [] }, { workers: 2, entry: fakeWorker(d, "crash-on-boom") });
  const boom = results[files.findIndex((f) => f.rel === "src/boom.rs")];
  assert.equal(boom.kind, "error");
  if (boom.kind !== "error") return;
  assert.equal(boom.entry.hash, contentHash("pub fn boom() {}\n"));
});

test("runParsePool: once the pool has worked, the in-thread fallback never parses a job that killed a child", async () => {
  const d = repo();
  writeFileSync(join(d, "src", "a.rs"), "pub fn a() {}\n");
  writeFileSync(join(d, "src", "b1boom.rs"), "pub fn b1() {}\n");
  writeFileSync(join(d, "src", "b2boom.rs"), "pub fn b2() {}\n");
  await warmGenericGrammars(["rust"]);
  const files = byRel(listSourceStats(d, join(d, "graft")));
  assert.equal(files[0].rel, "src/a.rs");
  let fellBack = false;
  // One worker (budget 2): a.rs succeeds, b1boom.rs kills two children and is
  // parked, b2boom.rs kills the third and the budget is gone: the rest of the
  // queue goes in-thread, but b2boom.rs must not be parsed in the parent.
  const results = await runParsePool(files, () => null, { generic: ["rust"], container: [] }, {
    workers: 1, entry: fakeWorker(d, "crash-on-boom"), onFallback: () => { fellBack = true; },
  });
  const b2 = results[files.findIndex((f) => f.rel === "src/b2boom.rs")];
  assert.equal(b2.kind, "error");
  if (b2.kind !== "error") return;
  assert.match(b2.message, /^src\/b2boom\.rs: parse failed — parser process exited \(code 9\) on this file; not retried in-process/);
  assert.equal(b2.entry.hash, contentHash("pub fn b2() {}\n"));
  assert.equal(results[files.findIndex((f) => f.rel === "src/lib.rs")].kind, "parsed", "the untouched rest still parses in-thread");
  assert.equal(fellBack, true, "the pool reported its fallback");
});

test("runParsePool: a child's clean exit after stop neither burns a respawn credit nor forks a replacement", async () => {
  const d = repo();
  const only = ["src/boom.rs", "src/lib.rs"];
  writeFileSync(join(d, "src", "boom.rs"), "pub fn boom() {}\n");
  await warmGenericGrammars(["rust"]);
  const files = byRel(listSourceStats(d, join(d, "graft"))).filter((f) => only.includes(f.rel));
  // Two children: A takes boom.rs, B takes lib.rs, finishes, is told to stop and
  // lingers 1200 ms. A crashes 500 ms in; its retry waits for a fresh child (1.5 s
  // warm-up), so B's clean exit lands while boom.rs is back in the queue — 700 ms
  // after A's crash, and at least 800 ms before the replacement is ready.
  await runParsePool(files, () => null, { generic: ["rust"], container: [] }, { workers: 2, entry: fakeWorker(d, "slow-stop") });
  const spawned = readFileSync(join(d, "spawned.log"), "utf8").trim().split("\n");
  assert.equal(spawned.length, 3, "A, B and A's one replacement — B's stop exit forks nothing");
});

test("runParsePool: a job killed at the timeout says it timed out", async () => {
  const d = repo();
  writeFileSync(join(d, "src", "boom.rs"), "pub fn boom() {}\n");
  await warmGenericGrammars(["rust"]);
  const files = listSourceStats(d, join(d, "graft"));
  const results = await runParsePool(files, () => null, { generic: ["rust"], container: [] }, { workers: 2, entry: fakeWorker(d, "hang-on-boom"), jobTimeoutMs: 500 });
  const boom = results[files.findIndex((f) => f.rel === "src/boom.rs")];
  assert.equal(boom.kind, "error");
  if (boom.kind !== "error") return;
  assert.match(boom.message, /^src\/boom\.rs: parse failed — parser process timed out after 0\.5 s on this file twice$/);
});

test("runParsePool: a fork() that throws is a dead child, not a rejected build", async () => {
  const d = repo();
  await warmGenericGrammars(["rust"]);
  const files = listSourceStats(d, join(d, "graft"));
  let fellBack = false;
  // A NUL in the path makes fork() throw synchronously (ERR_INVALID_ARG_VALUE).
  const results = await runParsePool(files, () => null, { generic: ["rust"], container: [] }, {
    workers: 2, entry: join(d, "no\u0000such.mjs"), onFallback: () => { fellBack = true; },
  });
  assert.deepEqual(results, files.map((f) => extractOne(f, null)));
  assert.equal(fellBack, true);
});

test("runParsePool: a child that dies mid-job costs that file two attempts, then an error; the rest still parse", async () => {
  const d = repo();
  writeFileSync(join(d, "src", "boom.rs"), "pub fn boom() {}\n");
  await warmGenericGrammars(["rust"]);
  const files = listSourceStats(d, join(d, "graft"));
  const results = await runParsePool(files, () => null, { generic: ["rust"], container: [] }, { workers: 2, entry: fakeWorker(d, "crash-on-boom") });
  const boom = results[files.findIndex((f) => f.rel === "src/boom.rs")];
  assert.equal(boom.kind, "error");
  if (boom.kind !== "error") return;
  assert.match(boom.message, /src\/boom\.rs: parse failed — parser process exited/);
  assert.equal(results[files.findIndex((f) => f.rel === "src/lib.rs")].kind, "parsed");
});

test("runParsePool: children that never become ready are killed at the warm-up timeout and the parent parses in-thread", async () => {
  const d = repo();
  await warmGenericGrammars(["rust"]);
  const files = listSourceStats(d, join(d, "graft"));
  const t0 = Date.now();
  const results = await runParsePool(files, () => null, { generic: ["rust"], container: [] }, { workers: 2, entry: fakeWorker(d, "never-ready"), warmTimeoutMs: 1500 });
  // A death before "ready" costs two respawn credits, so a pool of 2 (budget
  // workers*2 = 4) burns out in two 1500ms warm-up waves (~3s), not the four the
  // old one-credit rule would have run (~6s). Bound it below three waves so the
  // faster give-up is enforced, not just "did not hang".
  const elapsed = Date.now() - t0;
  assert.ok(elapsed < 4000, `fell back after two warm-up waves, not more (was ${elapsed}ms)`);
  assert.deepEqual(results, files.map((f) => extractOne(f, null)), "in-thread fallback produced the full result set");
});

test("runParsePool: children that always crash fall back to in-thread parsing instead of rejecting", async () => {
  const d = repo();
  for (let i = 0; i < 10; i++) writeFileSync(join(d, "src", `c${i}.rs`), `pub fn c${i}() {}\n`);
  await warmGenericGrammars(["rust"]);
  const files = listSourceStats(d, join(d, "graft"));
  let fellBack = false;
  const results = await runParsePool(files, () => null, { generic: ["rust"], container: [] }, { workers: 2, entry: fakeWorker(d, "always-crash"), onFallback: () => { fellBack = true; } });
  assert.equal(results.length, files.length);
  assert.ok(results.every((r) => r.kind === "parsed"), "every file was parsed in-thread after the pool gave up");
  assert.equal(fellBack, true, "the pool reported its fallback, so the CLI does not claim N parser processes");
});

test("runParsePool: a file that kills every child with no other work is treated as environmental and parsed in-thread", async () => {
  // boom.rs is the ONLY file, so no job ever completes in a child (succeeded === 0).
  // The crashes are therefore taken to be environmental (fork/loader/permissions),
  // not this file poisoning the parser, so the parked job is parsed in-thread.
  const d = mkdtempSync(join(tmpdir(), "graft-pool-solo-"));
  mkdirSync(join(d, "src"), { recursive: true });
  writeFileSync(join(d, "src", "boom.rs"), "pub fn boom() {}\n");
  await warmGenericGrammars(["rust"]);
  const files = listSourceStats(d, join(d, "graft"));
  assert.equal(files.length, 1);
  const results = await runParsePool(files, () => null, { generic: ["rust"], container: [] }, { workers: 2, entry: fakeWorker(d, "crash-on-boom") });
  assert.equal(results.length, 1);
  assert.equal(results[0].kind, "parsed");
});

test("buildGraph with parseWorkers writes byte-identical wiring.json to the in-thread build", async () => {
  const d = repo();
  for (let i = 0; i < 40; i++) writeFileSync(join(d, "src", `p${i}.rs`), `pub fn p${i}() { f() }\n`);
  const inThread = await buildGraph(d, { reuse: false });
  assert.equal(inThread.parseWorkers, 0);
  const a = readFileSync(wiringPath(contextDirFor(d)), "utf8");
  const pooled = await buildGraph(d, { reuse: false, parseWorkers: 2 });
  assert.equal(pooled.parseWorkers, Math.min(2, availableParallelism()), "clamped to the core count on a small runner");
  assert.equal(pooled.poolFallback, false, "the children did the parsing");
  assert.equal(inThread.poolFallback, false);
  assert.equal(pooled.parsed, inThread.parsed);
  assert.equal(readFileSync(wiringPath(contextDirFor(d)), "utf8"), a);
  assert.equal((await buildGraph(d, { reuse: false, parseWorkers: "auto" })).parseWorkers, 0, "auto on 42 files stays in-thread");
});

test("buildGraph never forks unless asked, whatever the environment says", async () => {
  const d = repo();
  const prev = process.env.GRAFT_PARSE_WORKERS;
  process.env.GRAFT_PARSE_WORKERS = "4";
  try {
    const r = await buildGraph(d, { reuse: false });
    assert.equal(r.parseWorkers, 0, "the env var is read by the CLI, not by buildGraph");
  } finally {
    if (prev === undefined) delete process.env.GRAFT_PARSE_WORKERS; else process.env.GRAFT_PARSE_WORKERS = prev;
  }
});
