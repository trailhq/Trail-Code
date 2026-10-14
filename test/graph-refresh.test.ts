/**
 * The pre-query freshness gate. Two things matter: it notices working-tree edits
 * that nobody committed (or even made through the agent), and it never turns a
 * working query into a failing one.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { buildGraph } from "../src/graph/build.js";
import { ensureFreshChildren, ensureFreshGraph, refreshNote } from "../src/graph/refresh.js";
import { extractCachePath, rewriteExtractCacheForTest } from "../src/graph/extract-cache.js";
import { fingerprintPath, isClean, probeDrift } from "../src/graph/fingerprint.js";
import { readGraph, wiringPath } from "../src/graph/write.js";
import { acquireLock, readStats, releaseLock, writeStats, emptyStats } from "../src/util/state.js";
import { callTool } from "../src/mcp/tools.js";
import type { GraphV1 } from "../src/graph/types.js";
import { chmodDenialUnavailable } from "./helpers.js";

const MATH = "export function add(a: number, b: number): number {\n  return a + b;\n}\n";
/** A *function*, because a plain `export const` is not extracted as a symbol node. */
const MUL = "export function mul(a: number, b: number): number {\n  return a * b;\n}\n";

function repo(): string {
  const d = mkdtempSync(join(tmpdir(), "graft-refresh-"));
  mkdirSync(join(d, "src"), { recursive: true });
  writeFileSync(join(d, "src", "math.ts"), MATH);
  return d;
}

const outOf = (d: string): string => join(d, "graft");
const graphOf = (d: string): GraphV1 => readGraph(wiringPath(outOf(d))) as GraphV1;
const hasSymbol = (d: string, id: string): boolean => graphOf(d).nodes.some((n) => n.id === id);

/** Each test owns the env switch; `graph-load.test.ts` sets it process-wide for
 * its own file, and these run in a separate process. */
function withRefreshDisabled<T>(fn: () => T): T {
  process.env.GRAFT_NO_REFRESH = "1";
  try {
    return fn();
  } finally {
    delete process.env.GRAFT_NO_REFRESH;
  }
}

test("probeDrift: clean after a build, then reports what moved", async () => {
  const d = repo();
  await buildGraph(d);
  const clean = probeDrift(d, outOf(d));
  assert.ok(clean && isClean(clean));

  writeFileSync(join(d, "src", "math.ts"), `${MATH}export const X = 1;\n`);
  writeFileSync(join(d, "src", "new.ts"), "export const N = 2;\n");
  const drift = probeDrift(d, outOf(d));
  assert.deepEqual(drift, { changed: ["src/math.ts"], added: ["src/new.ts"], removed: [] });

  rmSync(join(d, "src", "new.ts"));
  rmSync(join(d, "src", "math.ts"));
  assert.deepEqual(probeDrift(d, outOf(d)), { changed: [], added: [], removed: ["src/math.ts"] });
});

test("probeDrift returns null when no fingerprint was ever written", () => {
  const d = repo();
  mkdirSync(outOf(d), { recursive: true });
  assert.equal(probeDrift(d, outOf(d)), null);
});

test("ensureFreshGraph picks up an uncommitted edit before the query sees the graph", async () => {
  const d = repo();
  await buildGraph(d);
  assert.equal(hasSymbol(d, "src/math.ts#mul"), false);

  // Exactly the state that used to answer stale: a file edited in the working
  // tree, nothing committed, no hook having flagged anything.
  writeFileSync(join(d, "src", "math.ts"), `${MATH}export function mul(a: number, b: number): number {\n  return a * b;\n}\n`);

  const r = await ensureFreshGraph(d);
  assert.equal(r.refreshed, true);
  assert.deepEqual(r.drift?.changed, ["src/math.ts"]);
  assert.equal(hasSymbol(d, "src/math.ts#mul"), true);
  assert.match(refreshNote(r) ?? "", /^\[graft\] refreshed the graph \(1 file changed\)/);
});

test("ensureFreshGraph is a no-op on a clean tree", async () => {
  const d = repo();
  await buildGraph(d);
  const before = readFileSync(wiringPath(outOf(d)), "utf8");
  const r = await ensureFreshGraph(d);
  assert.equal(r.refreshed, false);
  assert.equal(refreshNote(r), null, "silence when there is nothing to say");
  assert.equal(readFileSync(wiringPath(outOf(d)), "utf8"), before, "the graph is not even rewritten");
});

test("ensureFreshGraph rebuilds once when the graph predates the fingerprint", async () => {
  const d = repo();
  await buildGraph(d);
  rmSync(fingerprintPath(outOf(d)));

  const first = await ensureFreshGraph(d);
  assert.equal(first.refreshed, true, "no fingerprint = unknown state, so rebuild");
  assert.equal(first.drift, undefined);
  // ...and that rebuild lays one down, so it costs one build, not one per query.
  const second = await ensureFreshGraph(d);
  assert.equal(second.refreshed, false);
});

test("ensureFreshGraph does nothing when there is no graph at all", async () => {
  const d = repo();
  const r = await ensureFreshGraph(d);
  assert.equal(r.refreshed, false);
  assert.equal(probeDrift(d, outOf(d)), null, "and it did not build one behind the user's back");
});

test("GRAFT_NO_REFRESH and { disabled } both short-circuit", async () => {
  const d = repo();
  await buildGraph(d);
  writeFileSync(join(d, "src", "math.ts"), `${MATH}export const X = 1;\n`);

  const off = await withRefreshDisabled(() => ensureFreshGraph(d));
  assert.equal(off.refreshed, false);
  const flagged = await ensureFreshGraph(d, { disabled: true });
  assert.equal(flagged.refreshed, false);
  assert.equal(hasSymbol(d, "src/math.ts#X"), false, "the graph must be untouched");

  const on = await ensureFreshGraph(d);
  assert.equal(on.refreshed, true);
});

test("a rebuild already in flight is waited out, then reported — never a hang", async () => {
  const d = repo();
  await buildGraph(d);
  writeFileSync(join(d, "src", "math.ts"), `${MATH}export const X = 1;\n`);

  assert.equal(acquireLock(d), true, "hold the lock the way a background sync would");
  const started = Date.now();
  const r = await ensureFreshGraph(d);
  const waited = Date.now() - started;
  releaseLock(d);

  assert.equal(r.refreshed, false);
  assert.match(r.note ?? "", /already in flight/);
  assert.ok(waited >= 1000 && waited < 10000, `should wait out the lock briefly, waited ${waited}ms`);
});

/**
 * The gate must leave `stats.json` completely alone, and this is load-bearing rather
 * than merely tidy. `handleStop` only spawns the end-of-turn `graft build` when
 * `stats.dirty` is set. A refresh writes the graph but deliberately not the markdown
 * projections, so if it cleared `dirty` — which is exactly what "flip the statusline
 * to ✓ synced mid-turn" would mean — the one thing that rebuilds `graft/`'s cards
 * and INDEX.md would stop running, and the passive surface an agent greps would
 * never catch up.
 */
test("a refresh leaves the statusline stats alone, so the Stop hook still fires", async () => {
  const d = repo();
  await buildGraph(d);
  writeFileSync(join(d, "src", "math.ts"), `${MATH}export const X = 1;\n`);

  // No stats file (a repo with no Claude Code wiring): nothing is created.
  await ensureFreshGraph(d);
  assert.equal(readStats(d), null);

  writeStats(d, { ...emptyStats(), dirty: true, staleCount: 3 });
  writeFileSync(join(d, "src", "math.ts"), `${MATH}export const Y = 2;\n`);
  const r = await ensureFreshGraph(d);
  assert.equal(r.refreshed, true, "the graph itself was rebuilt");

  const s = readStats(d);
  assert.equal(s?.dirty, true, "still dirty — the passive surface has not been rebuilt");
  assert.equal(s?.staleCount, 3, "and the edit hook's count is not overwritten");
  assert.equal(s?.syncedAt, null);
});

test("a failed rebuild still answers from the graph on disk", async (t) => {
  // Windows lands here too, not just root: the denial below is a directory mode, and
  // Windows ignores those outright (see the helper). Before writeGraph became atomic
  // this test denied by chmod-ing the FILE, which Windows *does* honour — so the
  // Windows leg used to pass, and silently started replacing the read-only graph
  // through the rename instead. Skipping says so rather than asserting vacuously.
  const why = chmodDenialUnavailable();
  if (why) return t.skip(why);
  const d = repo();
  await buildGraph(d);
  const before = readFileSync(wiringPath(outOf(d)), "utf8");
  writeFileSync(join(d, "src", "math.ts"), `${MATH}export const X = 1;\n`);

  // Make the graph write itself fail: the query must degrade to the old graph, not
  // start erroring because a rebuild couldn't happen. writeGraph is atomic (temp +
  // rename), and a rename can replace a read-only FILE, so the unwritable target has
  // to be the DIRECTORY — which is also the realistic "can't write here" case.
  const graphDir = dirname(wiringPath(outOf(d)));
  chmodSync(graphDir, 0o500); // r-x: the temp write fails, old wiring.json stays put
  const r = await ensureFreshGraph(d);
  chmodSync(graphDir, 0o700);

  assert.equal(r.refreshed, false);
  assert.match(r.note ?? "", /refresh skipped/);
  assert.equal(readFileSync(wiringPath(outOf(d)), "utf8"), before, "the old graph is intact");
  assert.match(refreshNote(r) ?? "", /^\[graft\] graph refresh skipped/);

  // The lock must have been released, or every later query would report a
  // rebuild-in-flight that will never finish.
  assert.equal(acquireLock(d), true);
  releaseLock(d);
});

/**
 * The probe and the builder must agree on what "unchanged" means, in both
 * directions. Each of the next three tests is a case where they didn't, and the
 * graph went permanently stale while every surface reported healthy.
 */
test("GRAFT_REFRESH=hash: drift the probe reports is drift the rebuild repairs", async () => {
  const d = repo();
  await buildGraph(d);
  const f = join(d, "src", "math.ts");

  // The state mtime-preserving tooling leaves behind: new bytes, but both sidecars
  // recording the file's current `(size, mtimeMs)` against its *old* hash. Written
  // out directly rather than via `utimesSync`, which takes float seconds and can't
  // put a millisecond mtime back exactly.
  const swapped = MATH.replace("add", "sum");
  assert.equal(swapped.length, MATH.length, "fixture must be a same-size rewrite");
  writeFileSync(f, swapped);
  const now = statSync(f);
  const fp = JSON.parse(readFileSync(fingerprintPath(outOf(d)), "utf8"));
  const staleHash = fp.files["src/math.ts"][2];
  fp.files["src/math.ts"] = [now.size, now.mtimeMs, staleHash];
  writeFileSync(fingerprintPath(outOf(d)), JSON.stringify(fp));
  rewriteExtractCacheForTest(outOf(d), (files) => {
    Object.assign(files["src/math.ts"], { size: now.size, mtimeMs: now.mtimeMs });
  });

  // Nobody notices without the flag — that's the documented trade-off, and the
  // whole reason the flag exists.
  assert.ok(isClean(probeDrift(d, outOf(d))!));

  process.env.GRAFT_REFRESH = "hash";
  try {
    assert.deepEqual(probeDrift(d, outOf(d)), { changed: ["src/math.ts"], added: [], removed: [] });
    const r = await ensureFreshGraph(d);
    assert.equal(r.refreshed, true);
    // The bug: the probe hashed, the builder trusted the stat, so the rebuild
    // replayed the old parse and the next probe reported the same drift forever.
    assert.equal(hasSymbol(d, "src/math.ts#sum"), true, "the rebuild must actually re-parse it");
    assert.equal(hasSymbol(d, "src/math.ts#add"), false);
    assert.ok(isClean(probeDrift(d, outOf(d))!), "and the drift is now gone, not permanent");
  } finally {
    delete process.env.GRAFT_REFRESH;
  }
});

test("a file that becomes readable again is picked up through the probe", async (t) => {
  const why = chmodDenialUnavailable();
  if (why) return t.skip(why);
  const d = repo();
  const hidden = join(d, "src", "hidden.ts");
  writeFileSync(hidden, "export function reachable(): number {\n  return 1;\n}\n");
  chmodSync(hidden, 0o000);
  await buildGraph(d);
  assert.equal(hasSymbol(d, "src/hidden.ts#reachable"), false);

  // Recorded-but-unreadable must not read as new on every query...
  assert.ok(isClean(probeDrift(d, outOf(d))!), "an unreadable file doesn't churn the probe");

  // ...but a chmod changes neither size nor mtime, so trusting the stat here left
  // the file permanently missing from the graph.
  chmodSync(hidden, 0o644);
  assert.deepEqual(probeDrift(d, outOf(d)), { changed: ["src/hidden.ts"], added: [], removed: [] });
  const r = await ensureFreshGraph(d);
  assert.equal(r.refreshed, true);
  assert.equal(hasSymbol(d, "src/hidden.ts#reachable"), true);
});

test("an unwritable cache costs reuse, not correctness", async (t) => {
  // A mode on a *directory* is the one denial Windows ignores completely, so unlike
  // the read-only-file case below there is no portable way to run this there.
  const why = chmodDenialUnavailable();
  if (why) return t.skip(why);
  const d = repo();
  await buildGraph(d);

  // The write has to be made to fail for real. An earlier version of this test
  // chmod'd extract.json itself — useless, because the sidecars go out through
  // `writeJsonAtomic`, and rename(2) needs write permission on the *directory*, not
  // on the file. It returned true, the test passed, and it would have passed against
  // the pre-fix code too.
  const cache = join(outOf(d), ".cache");
  const memo = extractCachePath(outOf(d))!;
  assert.ok(existsSync(memo), "a memo exists to begin with");
  const before = readFileSync(memo, "utf8");

  writeFileSync(join(d, "src", "math.ts"), `${MATH}${MUL}`);
  chmodSync(cache, 0o500);
  await buildGraph(d);
  chmodSync(cache, 0o700);

  assert.equal(readFileSync(memo, "utf8"), before, "the memo really could not be written");
  assert.ok(hasSymbol(d, "src/math.ts#mul"), "but the graph itself was rebuilt");

  // Losing the memo and the fingerprint is a performance failure, not a correctness
  // one: the next query rebuilds because it can't prove it doesn't need to. Once the
  // directory is writable again the fast path comes back on its own.
  await buildGraph(d);
  const drift = probeDrift(d, outOf(d));
  assert.ok(drift, "a fingerprint exists, so the probe has a fast path");
  assert.ok(isClean(drift), "and it says the graph matches the tree");
  assert.deepEqual((await ensureFreshGraph(d)).refreshed, false, "so a query stops rebuilding");
});

/**
 * The query path writes the graph, the ask sidecar and the fingerprint — and stops.
 * Cards and INDEX.md are what a human reads and what the agent greps; they are
 * rebuilt by an explicit `graft build`, which is what the `Stop` hook runs at the
 * end of a turn. Keeping them off the query path is what makes a refresh cheap, and
 * it means a read-only card or an unparseable hand-written concept node can never be
 * reached — let alone made permanent — by a retrieval call.
 */
test("a refresh rebuilds the graph but not the markdown projections", async () => {
  const d = repo();
  await buildGraph(d);

  const index = join(outOf(d), "INDEX.md");
  const card = join(outOf(d), "src", "math.md");
  const newCard = join(outOf(d), "src", "extra.md");
  assert.ok(existsSync(index) && existsSync(card), "an explicit build wrote both");
  const indexBefore = readFileSync(index, "utf8");
  const cardBefore = readFileSync(card, "utf8");

  writeFileSync(join(d, "src", "extra.ts"), MUL);
  const r = await ensureFreshGraph(d);

  assert.equal(r.refreshed, true);
  assert.equal(hasSymbol(d, "src/extra.ts#mul"), true, "the graph is current");
  assert.equal(existsSync(newCard), false, "no card for it yet");
  assert.equal(readFileSync(index, "utf8"), indexBefore, "INDEX.md untouched");
  assert.equal(readFileSync(card, "utf8"), cardBefore, "existing cards untouched");

  // An explicit build — the Stop hook's job — is what catches the surface up.
  await buildGraph(d);
  assert.equal(existsSync(newCard), true);
});

test("a refresh never writes the repo's .gitignore", async () => {
  const d = repo();
  await buildGraph(d); // an explicit build DOES self-ignore — that part is unchanged
  const ignore = join(d, ".gitignore");
  assert.match(readFileSync(ignore, "utf8"), /graft\//);

  // A repo that excludes graft/ some other way (.git/info/exclude, a global
  // core.excludesfile) and deliberately has no line here. A query is a read; it must
  // not hand the user an unexplained modification to a tracked file.
  rmSync(ignore);
  writeFileSync(join(d, "src", "math.ts"), `${MATH}${MUL}`);
  const r = await ensureFreshGraph(d);

  assert.equal(r.refreshed, true, "the refresh still happened");
  assert.equal(existsSync(ignore), false, "and it left .gitignore alone");
});

test("after waiting out another process's rebuild, the waiter does not rebuild too", async () => {
  const d = repo();
  await buildGraph(d);
  writeFileSync(join(d, "src", "math.ts"), `${MATH}${MUL}`);

  // Stand in for the process that got there first: take the lock, do the rebuild it
  // would have done, then release while our caller is still waiting.
  assert.equal(acquireLock(d), true);
  setTimeout(() => {
    void buildGraph(d).then(() => releaseLock(d));
  }, 150);

  const r = await ensureFreshGraph(d);
  assert.equal(r.refreshed, false, "the work was already done — re-probe, don't redo it");
  assert.equal(refreshNote(r), null, "and nothing to report");
  assert.equal(hasSymbol(d, "src/math.ts#mul"), true, "the edit is in the graph either way");
});

test("a fingerprint from a different extractor is not trusted", async () => {
  const d = repo();
  await buildGraph(d);
  assert.ok(isClean(probeDrift(d, outOf(d))!));

  // Same bytes on disk, different extractor: the memo drops its entries, so the
  // prints describe nodes nothing would rebuild. "Unknown" is the only safe answer.
  const fp = JSON.parse(readFileSync(fingerprintPath(outOf(d)), "utf8"));
  writeFileSync(fingerprintPath(outOf(d)), JSON.stringify({ ...fp, extractor: "0:0" }));
  assert.equal(probeDrift(d, outOf(d)), null);
});

test("a workspace refreshes its children even under a --dir override", async () => {
  const d = mkdtempSync(join(tmpdir(), "graft-refresh-ws-"));
  const child = join(d, "api");
  mkdirSync(join(child, "src"), { recursive: true });
  writeFileSync(join(child, "src", "math.ts"), MATH);
  await buildGraph(child);

  const shared = join(d, "shared-context");
  mkdirSync(shared, { recursive: true });
  writeFileSync(join(shared, "workspace.json"), JSON.stringify({ version: 1, children: ["api"] }));

  writeFileSync(join(child, "src", "math.ts"), `${MATH}export function mul(a: number, b: number): number {\n  return a * b;\n}\n`);
  // `contextDirFor` returns an override verbatim, so forwarding this to the child
  // resolved it to the parent's dir — no wiring.json there, so every child was
  // silently skipped and the query answered from a stale child graph.
  const r = await ensureFreshChildren(d, ["api"], { contextDir: shared });
  assert.equal(r.refreshed, true);
  assert.match(r.note ?? "", /api/);
  assert.equal(hasSymbol(child, "src/math.ts#mul"), true);
});

test("callTool refreshes before answering — except for graft_check_freshness", async () => {
  const d = repo();
  await buildGraph(d);
  writeFileSync(join(d, "src", "math.ts"), `${MATH}export function mul(a: number, b: number): number {\n  return a * b;\n}\n`);

  // graft_check_freshness is the drift report: refreshing first would make it always say OK.
  const check = await callTool(d, "graft_check_freshness", {});
  assert.equal(check.isError, false);
  assert.ok(!check.text.startsWith("[graft] refreshed"));
  assert.equal(hasSymbol(d, "src/math.ts#mul"), false, "check must not rebuild");

  const ask = await callTool(d, "graft_find_code", { query: "multiply two numbers" });
  assert.equal(ask.isError, false);
  assert.match(ask.text, /^\[graft\] refreshed the graph/);
  assert.equal(hasSymbol(d, "src/math.ts#mul"), true);
  assert.match(ask.text, /mul/, "and the answer knows about the symbol that was never committed");

  const again = await callTool(d, "graft_find_code", { query: "multiply two numbers" });
  assert.ok(!again.text.startsWith("[graft] refreshed"), "nothing moved — no note, no rebuild");
});

test("a process killed while holding the lock releases it", async (t) => {
  // Windows has no SIGTERM: `child.kill()` there calls TerminateProcess, so no
  // handler runs and nothing can release the lock on the way out. The safety net on
  // that platform is the stale-lock reclaim (`LOCK_STALE_MS`), covered above.
  if (process.platform === "win32") {
    return t.skip("no SIGTERM on Windows — kill() terminates without unwinding, so a handler cannot run");
  }
  const d = repo();
  const cache = join(outOf(d), ".cache");
  mkdirSync(cache, { recursive: true });
  const lock = join(cache, ".sync.lock");

  // `execFileSync(..., { timeout })` — which is how the Claude Code prompt hook runs
  // `graft ask` — enforces its timeout with SIGTERM, and node's default disposition
  // for that is to exit without unwinding. So the `finally` that releases the lock
  // never ran, and the abandoned lock then blocked the background sync and made every
  // query wait-then-answer-stale until it aged out.
  // `file://` URLs, not native paths: a dynamic `import("D:\\…\\state.ts")` fails on
  // Windows, where ESM reads the drive letter as a URL scheme.
  const mod = (rel: string) => JSON.stringify(new URL(rel, import.meta.url).href);
  const child = spawn(
    process.execPath,
    ["--import", "tsx", "-e",
      `const { acquireLockIn } = await import(${mod("../src/util/state.ts")});
       const { releaseOnSignal } = await import(${mod("../src/graph/refresh.ts")});
       const cache = process.argv[1];
       if (!acquireLockIn(cache)) { process.exit(9); }
       releaseOnSignal(cache);
       process.stdout.write("held\\n");
       setInterval(() => {}, 1000);`,
      cache],
    { stdio: ["ignore", "pipe", "inherit"] },
  );
  await new Promise<void>((done, fail) => {
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (c: string) => { if (c.includes("held")) done(); });
    child.on("exit", (code) => fail(new Error(`child exited early (${code})`)));
  });
  assert.ok(existsSync(lock), "the child holds the lock");

  child.kill("SIGTERM");
  const [code, signal] = await new Promise<[number | null, string | null]>((done) =>
    child.on("exit", (c, s) => done([c, s])),
  );

  assert.ok(!existsSync(lock), "the lock must not outlive the process that took it");
  assert.equal(signal, "SIGTERM", "and the exit still reports the signal, for whoever is waiting on us");
  assert.equal(code, null);
});
