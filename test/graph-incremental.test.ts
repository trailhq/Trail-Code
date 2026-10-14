/**
 * The extraction cache's contract: replaying unchanged files must be
 * indistinguishable from re-parsing them. Every test here is a variation on
 * "cold build == incremental build" — because that equality is what lets a
 * rebuild run before every query.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { buildGraph } from "../src/graph/build.js";
import { extractCachePath, extractorStamp, readExtractCache, rewriteExtractCacheForTest, stampDir, writeExtractCache } from "../src/graph/extract-cache.js";
import { fingerprintPath, isClean, probeDrift, readFingerprint } from "../src/graph/fingerprint.js";
import { readAskIndex } from "../src/ask/index-file.js";
import { readGraph, wiringPath } from "../src/graph/write.js";
import type { GraphV1 } from "../src/graph/types.js";
import { chmodDenialUnavailable } from "./helpers.js";
import { writeBuildConfig } from "../src/util/state.js";

const MATH = [
  "export function add(a: number, b: number): number {",
  "  return a + b;",
  "}",
  "export function sub(a: number, b: number): number {",
  "  return add(a, -b);",
  "}",
  "",
].join("\n");

const APP = ['import { add } from "./math.js";', "export function main(): number {", "  return add(1, 2);", "}", ""].join("\n");

function repo(): string {
  const d = mkdtempSync(join(tmpdir(), "graft-incr-"));
  mkdirSync(join(d, "src"), { recursive: true });
  writeFileSync(join(d, "src", "math.ts"), MATH);
  writeFileSync(join(d, "src", "app.ts"), APP);
  return d;
}

function gitRun(root: string, args: string[]): void {
  execFileSync("git", args, { cwd: root, stdio: "ignore" });
}

function commitRepo(root: string, message: string): void {
  gitRun(root, ["add", "-A"]);
  gitRun(root, [
    "-c", "user.name=Graft Tests",
    "-c", "user.email=graft-tests@example.invalid",
    "commit", "-qm", message,
  ]);
}

const outOf = (d: string): string => join(d, "graft");
const wiringOf = (d: string): string => readFileSync(wiringPath(outOf(d)), "utf8");

test("an incremental rebuild writes byte-identical wiring.json to a cold one", async () => {
  const d = repo();
  await buildGraph(d, { reuse: false });
  const cold = wiringOf(d);
  await buildGraph(d);
  assert.equal(wiringOf(d), cold, "replaying cached parses must not change a single byte of the graph");
});

test("A3: an incremental rebuild is still byte-identical to a cold one on a duplicate-name-bearing fixture", async () => {
  const d = mkdtempSync(join(tmpdir(), "graft-incr-dup-"));
  mkdirSync(join(d, "src"), { recursive: true });
  writeFileSync(join(d, "src", "dup.ts"), "export function helper(): void {}\nexport function helper(): void {}\n");

  await buildGraph(d, { reuse: false });
  const cold = wiringOf(d);
  await buildGraph(d);
  assert.equal(wiringOf(d), cold, "replaying cached parses must not change a single byte, even with minted ordinal ids");

  const g = readGraph(wiringPath(outOf(d))) as GraphV1;
  const ids = g.nodes.map((n) => n.id);
  assert.equal(new Set(ids).size, ids.length, "ids stay unique across cold/incremental");
  assert.ok(
    ids.includes("src/dup.ts#helper") && ids.includes("src/dup.ts#helper~2"),
    "sanity: the dup actually minted an ordinal id",
  );
});

test("unchanged files are replayed, not re-parsed", async () => {
  const d = repo();
  const first = await buildGraph(d);
  assert.equal(first.parsed, 2, "cold build parses every file");
  assert.equal(first.reused, 0);

  const second = await buildGraph(d);
  assert.equal(second.parsed, 0, "nothing changed — nothing to parse");
  assert.equal(second.reused, 2);

  // Same content, newer mtime: the stat check misses, the hash check saves it.
  const later = new Date(Date.now() + 5000);
  utimesSync(join(d, "src", "math.ts"), later, later);
  const third = await buildGraph(d);
  assert.equal(third.parsed, 0, "a touch changes no bytes, so it must not cost a parse");
  assert.equal(third.reused, 2);
});

test("an edit re-parses only the file that changed, and lands in the graph", async () => {
  const d = repo();
  await buildGraph(d);
  writeFileSync(join(d, "src", "math.ts"), `${MATH}export function mul(a: number, b: number): number {\n  return a * b;\n}\n`);
  const r = await buildGraph(d);
  assert.equal(r.parsed, 1);
  assert.equal(r.reused, 1);
  const g = readGraph(wiringPath(outOf(d))) as GraphV1;
  assert.ok(g.nodes.some((n) => n.id === "src/math.ts#mul"), "the new symbol must be in the graph");

  // ...and the result is still exactly what a cold build would produce.
  const warm = wiringOf(d);
  await buildGraph(d, { reuse: false });
  assert.equal(warm, wiringOf(d));
});

test("adding and deleting files stays consistent with a cold build", async () => {
  const d = repo();
  await buildGraph(d);

  writeFileSync(join(d, "src", "extra.ts"), "export const EXTRA = 1;\n");
  const added = await buildGraph(d);
  assert.equal(added.parsed, 1, "only the new file is parsed");
  assert.equal(added.reused, 2);

  rmSync(join(d, "src", "app.ts"));
  await buildGraph(d);
  const g = readGraph(wiringPath(outOf(d))) as GraphV1;
  assert.ok(!g.nodes.some((n) => n.path === "src/app.ts"), "a deleted file leaves no nodes behind");

  const cache = readExtractCache(outOf(d));
  assert.ok(!("src/app.ts" in cache.files), "and no cache entry");
  const fp = readFingerprint(outOf(d));
  assert.ok(fp && !("src/app.ts" in fp.files), "and no fingerprint entry");

  const warm = wiringOf(d);
  await buildGraph(d, { reuse: false });
  assert.equal(warm, wiringOf(d));
});

test("the ask sidecar still covers every node after an incremental rebuild", async () => {
  const d = repo();
  await buildGraph(d);
  writeFileSync(join(d, "src", "app.ts"), `${APP}export function other(): number {\n  return 7;\n}\n`);
  await buildGraph(d);

  const g = readGraph(wiringPath(outOf(d))) as GraphV1;
  const idx = readAskIndex(outOf(d));
  assert.ok(idx, "sidecar written");
  // ask.ts falls back to live tokenization unless the sidecar covers every node
  // by id — a replayed node with no body would silently degrade ranking.
  assert.equal(idx!.docs.length, g.nodes.length);
  const ids = new Set(idx!.docs.map((doc) => doc.id));
  for (const n of g.nodes) assert.ok(ids.has(n.id), `sidecar missing ${n.id}`);
  const replayed = idx!.docs.find((doc) => doc.id === "src/math.ts#add");
  assert.ok(replayed && replayed.body.length > 0, "a replayed node must keep its body tokens");
});

test("the cache holds pristine Tier-1 output — no enrichment leaks into it", async () => {
  const d = repo();
  await buildGraph(d);
  // Stamp a summary onto the graph the way a `--deep` build would, then rebuild
  // structurally: the meaning layer must survive (it is keyed on body_hash in
  // wiring.json) while the extraction cache stays free of it.
  const path = wiringPath(outOf(d));
  const g = readGraph(path) as GraphV1;
  const target = g.nodes.find((n) => n.id === "src/math.ts#add");
  assert.ok(target);
  target!.summary = "adds two numbers";
  target!.summary_state = "ready";
  writeFileSync(path, `${JSON.stringify(g, null, 2)}\n`);

  await buildGraph(d);
  const after = readGraph(path) as GraphV1;
  const kept = after.nodes.find((n) => n.id === "src/math.ts#add");
  assert.equal(kept?.summary, "adds two numbers", "an unchanged body keeps its summary");
  assert.equal(kept?.summary_state, "ready");

  const cache = readExtractCache(outOf(d));
  const cachedNode = cache.files["src/math.ts"].nodes.find((n) => n.id === "src/math.ts#add");
  assert.ok(cachedNode);
  assert.equal(cachedNode!.summary, null, "the parse memo must not carry meaning-layer state");
  assert.equal(cachedNode!.summary_state, "pending", "it holds extractFile's output, pre-enrichment");
});

test("every file on disk lands in the fingerprint", async () => {
  const d = repo();
  await buildGraph(d);
  const fp = readFingerprint(outOf(d));
  assert.ok(fp);
  assert.deepEqual(Object.keys(fp!.files).sort(), ["src/app.ts", "src/math.ts"]);
});

test("initialized submodule files share the graph and freshness fingerprint (#74)", async () => {
  const parent = repo();
  const child = mkdtempSync(join(tmpdir(), "graft-incr-submodule-"));
  try {
    execFileSync("git", ["init", "-q"], { cwd: parent });
    commitRepo(parent, "parent fixture");

    execFileSync("git", ["init", "-q"], { cwd: child });
    mkdirSync(join(child, "src"), { recursive: true });
    writeFileSync(join(child, ".gitignore"), "*.generated.ts\n");
    writeFileSync(join(child, "src", "sub.ts"), "export function subValue(): number { return 1; }\n");
    commitRepo(child, "child fixture");

    gitRun(parent, [
      "-c", "protocol.file.allow=always",
      "submodule", "add", "-q", child.replace(/\\/g, "/"), "modules/child",
    ]);
    commitRepo(parent, "add child submodule");

    const checkout = join(parent, "modules", "child", "src");
    writeFileSync(join(checkout, "visible.ts"), "export const visible = 1;\n");
    writeFileSync(join(checkout, "ignored.generated.ts"), "export const ignored = 1;\n");

    const defaultBuild = await buildGraph(parent);
    assert.equal(defaultBuild.files, 2, "submodules stay outside the graph by default");
    const defaultGraph = readGraph(wiringPath(outOf(parent))) as GraphV1;
    assert.ok(!defaultGraph.nodes.some((n) => n.path.startsWith("modules/child/")));

    writeBuildConfig(parent, { followSubmodules: true });
    const first = await buildGraph(parent);
    assert.equal(first.files, 4);
    const graph = readGraph(wiringPath(outOf(parent))) as GraphV1;
    assert.ok(graph.nodes.some((n) => n.id === "modules/child/src/sub.ts#subValue"));
    assert.ok(graph.nodes.some((n) => n.path === "modules/child/src/visible.ts"));
    assert.ok(!graph.nodes.some((n) => n.path.endsWith("ignored.generated.ts")));
    assert.deepEqual(Object.keys(readFingerprint(outOf(parent))!.files).sort(), [
      "modules/child/src/sub.ts",
      "modules/child/src/visible.ts",
      "src/app.ts",
      "src/math.ts",
    ]);
    assert.ok(isClean(probeDrift(parent, outOf(parent))!));

    writeFileSync(join(checkout, "sub.ts"), "export function changedSubValue(): number { return 2; }\n");
    writeFileSync(join(checkout, "added.ts"), "export const added = 1;\n");
    rmSync(join(checkout, "visible.ts"));
    writeFileSync(join(checkout, "another.generated.ts"), "export const stillIgnored = 1;\n");

    assert.deepEqual(probeDrift(parent, outOf(parent)), {
      changed: ["modules/child/src/sub.ts"],
      added: ["modules/child/src/added.ts"],
      removed: ["modules/child/src/visible.ts"],
    });

    await buildGraph(parent);
    const refreshed = readGraph(wiringPath(outOf(parent))) as GraphV1;
    assert.ok(refreshed.nodes.some((n) => n.id === "modules/child/src/sub.ts#changedSubValue"));
    assert.ok(refreshed.nodes.some((n) => n.path === "modules/child/src/added.ts"));
    assert.ok(!refreshed.nodes.some((n) => n.path === "modules/child/src/visible.ts"));
    assert.ok(isClean(probeDrift(parent, outOf(parent))!));
  } finally {
    rmSync(parent, { recursive: true, force: true });
    rmSync(child, { recursive: true, force: true });
  }
});

test("gitignored generated files stay out of the graph, fingerprint, and drift probe (#39)", async () => {
  const d = repo();
  try {
    execFileSync("git", ["init", "-q"], { cwd: d });
    writeFileSync(join(d, ".gitignore"), "Scripts/bundles/\n");
    mkdirSync(join(d, "Scripts", "bundles"), { recursive: true });
    const bundle = join(d, "Scripts", "bundles", "app.js");
    writeFileSync(bundle, "export function generatedBundle(): number { return 1; }\n");

    await buildGraph(d);
    const graph = readGraph(wiringPath(outOf(d))) as GraphV1;
    assert.ok(!graph.nodes.some((n) => n.path === "Scripts/bundles/app.js"));
    assert.deepEqual(Object.keys(readFingerprint(outOf(d))!.files).sort(), ["src/app.ts", "src/math.ts"]);

    writeFileSync(bundle, "export function generatedBundle(): number { return 2; }\n");
    assert.ok(isClean(probeDrift(d, outOf(d))!), "ignored output changes must not trigger a refresh");
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test("an unreadable file is still recorded, so it can't look new on every probe", async (t) => {
  const why = chmodDenialUnavailable();
  if (why) return t.skip(why);
  const d = repo();
  const secret = join(d, "src", "secret.ts");
  writeFileSync(secret, "export function secretFn(): number {\n  return 1;\n}\n");
  chmodSync(secret, 0o000);

  const r = await buildGraph(d);
  assert.ok(
    r.errors.some((e) => e.startsWith("src/secret.ts:")),
    `expected a read error for src/secret.ts, got ${JSON.stringify(r.errors)}`,
  );
  // The point: it IS in the fingerprint. Otherwise the probe would report it as a
  // new file forever and every single query would trigger a rebuild.
  const fp = readFingerprint(outOf(d));
  assert.ok(fp && "src/secret.ts" in fp.files);
  const drift = probeDrift(d, outOf(d));
  assert.ok(drift && isClean(drift), `expected a clean probe, got ${JSON.stringify(drift)}`);

  // And the error keeps being reported while the file stays unreadable.
  const again = await buildGraph(d);
  assert.ok(again.errors.some((e) => e.startsWith("src/secret.ts:")));

  // A chmod changes neither size nor mtime, so recovery must not depend on the
  // stat fast path — the file has to be retried on the next build regardless.
  chmodSync(secret, 0o644);
  const recovered = await buildGraph(d);
  assert.deepEqual(recovered.errors, []);
  const g = readGraph(wiringPath(outOf(d))) as GraphV1;
  assert.ok(g.nodes.some((n) => n.id === "src/secret.ts#secretFn"), "the once-unreadable file is indexed now");
});

/**
 * The stamp is the memo's second key: the file hash says "these bytes", the stamp
 * says "and this is the code that parsed them". Get it wrong and a fixed extractor
 * silently keeps serving output from the broken one.
 */
test("extractorStamp: a real identity for the loaded extraction code", () => {
  const s = extractorStamp();
  assert.notEqual(s, "unknown", "path resolution must work under both tsx and dist/, or invalidation silently stops");
  assert.match(s, /^[0-9a-f]{16}$/);
  assert.equal(s, extractorStamp(), "memoized — the cost is paid once per process");
});

test("the stamp moves for any module in the extractor directory, not just one", () => {
  const dir = mkdtempSync(join(tmpdir(), "graft-stamp-"));
  writeFileSync(join(dir, "extract.js"), "export const a = 1;\n");
  writeFileSync(join(dir, "bindings.js"), "export const b = 1;\n");
  writeFileSync(join(dir, "notes.txt"), "not code\n");
  const base = stampDir(dir, ".js", "0.8.0");

  assert.equal(stampDir(dir, ".js", "0.8.0"), base, "stable for identical input");

  // The bug this replaces: only `extract.js` was watched, so a receiver-type fix
  // in bindings.js left the stamp — and therefore every cached parse — untouched.
  writeFileSync(join(dir, "bindings.js"), "export const b = 2;\n");
  const afterSibling = stampDir(dir, ".js", "0.8.0");
  assert.notEqual(afterSibling, base, "a sibling module's content must count");

  // A grammar upgrade changes parse output without touching any of graft's files.
  assert.notEqual(stampDir(dir, ".js", "0.8.1"), afterSibling, "the package version must count");

  // Non-code in the same directory must not churn the memo.
  writeFileSync(join(dir, "notes.txt"), "still not code\n");
  assert.equal(stampDir(dir, ".js", "0.8.0"), afterSibling, "a non-module file in the directory must not churn the memo");

  const beforeRename = afterSibling;
  rmSync(join(dir, "bindings.js"));
  writeFileSync(join(dir, "renamed.js"), "export const b = 2;\n");
  assert.notEqual(stampDir(dir, ".js", "0.8.0"), beforeRename, "a rename at identical content is still a change");
});

test("a memo written by a different extractor is dropped, not replayed", async () => {
  const d = repo();
  await buildGraph(d);
  const cache = readExtractCache(outOf(d));
  assert.ok(Object.keys(cache.files).length > 0);

  // The header carries the extractor identity; rewriting it with a foreign stamp
  // is a memo produced by a different extractor, keyed under our own filename.
  writeExtractCache(outOf(d), { ...cache, extractor: "deadbeefdeadbeef" });
  assert.deepEqual(readExtractCache(outOf(d)).files, {}, "entries from an unknown extractor are worthless");

  // So the next build re-parses everything rather than trusting them.
  const cold = await buildGraph(d);
  assert.equal(cold.reused, 0);
  assert.equal(cold.parsed, cold.files);
});

test("two grafts on one repo keep separate memos instead of evicting each other", async () => {
  const d = repo();
  await buildGraph(d);
  const cache = join(outOf(d), ".cache");
  const mine = extractCachePath(outOf(d))!;
  assert.ok(existsSync(mine));
  // The mechanism: the identity is in the FILENAME, not only inside the file. A
  // single shared `extract.json` is what made two installs evict each other.
  assert.ok(basename(mine).includes(extractorStamp()!), `stamp missing from ${basename(mine)}`);
  assert.ok(basename(fingerprintPath(outOf(d))).includes(extractorStamp()!), "same for the probe sidecar");

  // Stand in for the other install — `graft init` wires the MCP server as
  // `npx -y @nanonets/graft` while the hooks run the locally installed dist, so two
  // different versions on one repo is the DEFAULT setup, not an exotic one. With a
  // single shared filename they took turns rejecting each other's entries and
  // cold-re-parsing the whole repo on every call.
  const theirs = join(cache, "extract.0000000000000000.json");
  writeFileSync(theirs, readFileSync(mine, "utf8"));

  const again = await buildGraph(d);
  assert.equal(again.parsed, 0, "our own memo still applies");
  assert.equal(again.reused, again.files);
  assert.ok(existsSync(theirs), "and the other install's memo is left intact");

  // Bounded, though: `.cache/` must not grow a file per version forever.
  for (const n of ["1111", "2222", "3333"]) {
    writeFileSync(join(cache, `extract.${n}00000000000000.json`), "{}");
  }
  await buildGraph(d);
  const left = readdirSync(cache).filter((f) => f.startsWith("extract."));
  assert.ok(left.length <= 2, `pruned to at most 2, found ${left.join(", ")}`);
  assert.ok(left.includes(basename(mine)), "and the surviving one is the memo in use");
});

test("with no extractor identity, nothing is memoized — and 'unknown' is never stored", async () => {
  const d = repo();
  await buildGraph(d);

  // Every sidecar on disk must name a real identity. `"unknown"` used to be both the
  // failure sentinel AND a value written into the files, so every later run compared
  // equal to it and extractor-change invalidation silently stopped working forever.
  for (const f of readdirSync(join(outOf(d), ".cache"))) {
    if (!f.endsWith(".json") && !f.endsWith(".ndjson")) continue;
    assert.ok(!f.includes("unknown"), `${f} is filed under the failure sentinel`);
    if (f.endsWith(".ndjson")) {
      // The extract memo is NDJSON — its extractor identity is on the header line, not
      // parseable as whole-file JSON — so read it back through readExtractCache.
      assert.notEqual(readExtractCache(outOf(d)).extractor, "unknown", `${f} stores the sentinel`);
      continue;
    }
    const body = JSON.parse(readFileSync(join(outOf(d), ".cache", f), "utf8")) as { extractor?: string };
    if (body.extractor !== undefined) assert.notEqual(body.extractor, "unknown", `${f} stores the sentinel`);
  }
  assert.equal(stampDir(mkdtempSync(join(tmpdir(), "graft-empty-")), ".js"), null, "an empty dir has no identity");
});

test("an incremental rebuild leaves the ask sidecar agreeing with the graph", async () => {
  const d = repo();
  await buildGraph(d);

  writeFileSync(join(d, "src", "math.ts"), `${MATH}export function mul(a: number): number {\n  return a * 2;\n}\n`);
  await buildGraph(d); // warm: math.ts re-parsed, everything else replayed

  // The sidecar is built from the in-memory graph, never from a re-read of
  // wiring.json (whose nodes have had `body_text` stripped), so a replayed node
  // has to arrive with its body intact for the pair to agree.
  const idx = readAskIndex(outOf(d));
  const g = readGraph(wiringPath(outOf(d))) as GraphV1;
  assert.equal(idx?.docs.length, g.nodes.length, "the pair agrees on the node set");
  assert.ok(idx!.docs.some((doc) => doc.id.endsWith("#mul")), "including the new symbol");
});

/**
 * `graft check` re-reads and re-hashes every file; the builder must too. If the
 * builder trusted `(size, mtimeMs)` the way the probe does, then on a filesystem with
 * coarse mtime granularity a same-length edit inside one tick would leave `graft
 * check` reporting drift that the `graft build` it recommends could not repair — the
 * documented fix, doing nothing, forever.
 */
test("a build repairs an edit that leaves size and mtime untouched", async () => {
  const d = repo();
  await buildGraph(d);
  const file = join(d, "src", "math.ts");
  const size = statSync(file).size;

  // A rename to a same-length name.
  writeFileSync(file, readFileSync(file, "utf8").replace("export function add", "export function sum"));
  assert.equal(statSync(file).size, size, "the edit is size-neutral");

  // Now make the memo's record match the file's stat *as it is now* while keeping the
  // pre-edit hash and nodes. That is precisely the state a 1s-granularity mount hands
  // you for free, and it avoids `utimesSync`, whose float-seconds round-trip can't
  // reproduce an mtimeMs exactly.
  const now = statSync(file);
  rewriteExtractCacheForTest(outOf(d), (files) => {
    files["src/math.ts"].size = now.size;
    files["src/math.ts"].mtimeMs = now.mtimeMs;
  });

  const r = await buildGraph(d);
  assert.equal(r.parsed, 1, "the file was re-parsed despite the identical stat");
  const ids = (readGraph(wiringPath(outOf(d))) as GraphV1).nodes.map((n) => n.id);
  assert.ok(ids.includes("src/math.ts#sum"), "and the graph reflects the rename");
  assert.equal(ids.includes("src/math.ts#add"), false, "the old symbol is gone");
});
