import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildGraph } from "../src/graph/build.js";
import { writeGraph, wiringPath } from "../src/graph/write.js";
import { contextDirFor } from "../src/context/node-file.js";
import {
  readWorkspace,
  writeWorkspace,
  loadWorkspaceGraphs,
  coverageNote,
  migrationNote,
  splitWorkspace,
  federateAsk,
  federateCheck,
  federateCallers,
  federateGrep,
  isWorkspaceBuildRoot,
} from "../src/graph/workspace.js";
import { formatAsk } from "../src/ask/ask.js";
import type { GraphV1 } from "../src/graph/types.js";

/** A parent dir with git children (each a `.git` dir + one source file). */
function workspaceFx(children: Record<string, Record<string, string>>): string {
  const parent = mkdtempSync(join(tmpdir(), "ws-"));
  for (const [child, files] of Object.entries(children)) {
    mkdirSync(join(parent, child, ".git"), { recursive: true });
    for (const [name, content] of Object.entries(files)) {
      const path = join(parent, child, name);
      mkdirSync(join(path, ".."), { recursive: true }); // create nested dirs (e.g. src/gateway.ts)
      writeFileSync(path, content);
    }
  }
  return parent;
}

/** Build every git child into its own graft/, then write the workspace index. */
async function buildWorkspace(parent: string): Promise<{ children: string[]; migrated: boolean }> {
  return splitWorkspace(parent, undefined, async (childDir) => {
    await buildGraph(childDir);
  });
}

const REPOS = {
  repoA: { "a.ts": "export function alphaHandler() { return helperThing(); }\nfunction helperThing() { return 1; }\n" },
  repoB: { "b.ts": "export function betaHandler() { return 2; }\n" },
};

/** N unrelated functions, to pad a child's corpus to a realistic size so
 * coverage/idf reflect scale (junk coverage rises with corpus size). */
function pad(n: number): string {
  let s = "";
  for (let i = 0; i < n; i++) s += `export function pad${i}Widget() { const v${i} = ${i}; return v${i}; }\n`;
  return s;
}

test("isWorkspaceBuildRoot: ≥2 git children, no own .git → workspace", () => {
  const p = workspaceFx(REPOS);
  assert.equal(isWorkspaceBuildRoot(p), true);
  rmSync(p, { recursive: true, force: true });
});

test("isWorkspaceBuildRoot: own .git (submodules) → NOT a workspace", () => {
  const p = workspaceFx(REPOS);
  mkdirSync(join(p, ".git"), { recursive: true });
  assert.equal(isWorkspaceBuildRoot(p), false);
  rmSync(p, { recursive: true, force: true });
});

test("child built via parent is byte-identical to building it standalone", async () => {
  const p = workspaceFx(REPOS);
  await buildWorkspace(p);
  const childGraft = contextDirFor(join(p, "repoA"));
  const viaParent = readFileSync(wiringPath(childGraft), "utf8");

  // Rebuild the same child standalone — deterministic writer, same source.
  rmSync(childGraft, { recursive: true, force: true });
  await buildGraph(join(p, "repoA"));
  const standalone = readFileSync(wiringPath(childGraft), "utf8");

  assert.equal(viaParent, standalone);
  rmSync(p, { recursive: true, force: true });
});

test("workspace.json lists both children; parent holds no mega-graph", async () => {
  const p = workspaceFx(REPOS);
  await buildWorkspace(p);
  const ws = readWorkspace(p);
  assert.deepEqual(ws, { version: 1, children: ["repoA", "repoB"] });
  // Parent graft holds ONLY workspace.json — no .graph/wiring.json.
  assert.equal(existsSync(wiringPath(contextDirFor(p))), false);
  assert.equal(existsSync(join(contextDirFor(p), "workspace.json")), true);
  rmSync(p, { recursive: true, force: true });
});

test("ask at the parent federates hits from both children, labeled <child>/", async () => {
  const p = workspaceFx(REPOS);
  await buildWorkspace(p);
  const r = federateAsk(p, undefined, "handler", { limit: 8 });
  const text = formatAsk(r);
  assert.ok(text.includes("[repoA/]"), `expected repoA label:\n${text}`);
  assert.ok(text.includes("[repoB/]"), `expected repoB label:\n${text}`);
  // Pointers are child-prefixed so they open from the parent.
  assert.ok(r.hits.some((h) => h.pointer.startsWith("repoA/")));
  assert.ok(r.hits.some((h) => h.pointer.startsWith("repoB/")));
  rmSync(p, { recursive: true, force: true });
});

test("workspace ask applies file-first selection after cross-repo fusion", async () => {
  const p = workspaceFx({
    repoA: {
      "a.ts":
        `export function quartzAlphaA() { return "quartz"; }\n` +
        `export function quartzBetaA() { return "quartz"; }\n` +
        `export function quartzGammaA() { return "quartz"; }\n`,
      "b.ts": `export function quartzOmegaB() { return "quartz"; }\n`,
    },
    repoB: {
      // Same basename as repoA proves child identity is part of the group key.
      "a.ts":
        `export function quartzAlphaC() { return "quartz"; }\n` +
        `export function quartzBetaC() { return "quartz"; }\n`,
      "d.ts": `export function quartzOmegaD() { return "quartz"; }\n`,
    },
  });
  try {
    await buildWorkspace(p);
    const r = federateAsk(p, undefined, "quartz", {
      limit: 8,
      graphRank: false,
      fileTopLock: false,
    });
    const files = r.hits.map((hit) => hit.pointer.replace(/:L\d+-L\d+$/, ""));
    const firstPass = [...new Set(files)];

    assert.deepEqual(files.slice(0, firstPass.length), [
      "repoA/a.ts",
      "repoB/a.ts",
      "repoB/d.ts",
      "repoA/b.ts",
    ], "selection runs after raw child results have established the fused file order");
    assert.ok(files.slice(firstPass.length).includes("repoA/a.ts"), "later rounds retain sibling spans");
    assert.ok(files.slice(firstPass.length).includes("repoB/a.ts"), "same-path files in different children stay distinct");
  } finally {
    rmSync(p, { recursive: true, force: true });
  }
});

test("default file-aware fusion locks the exact workspace top before projecting span queues", async () => {
  const p = workspaceFx({
    repoA: {
      "a.ts":
        `export function quartzAlphaA() { return "quartz"; }\n` +
        `export function quartzBetaA() { return "quartz"; }\n` +
        `export function quartzGammaA() { return "quartz"; }\n`,
      "b.ts": `export function quartzOmegaB() { return "quartz"; }\n`,
    },
    repoB: {
      "a.ts":
        `export function quartzAlphaC() { return "quartz"; }\n` +
        `export function quartzBetaC() { return "quartz"; }\n`,
      "d.ts": `export function quartzOmegaD() { return "quartz"; }\n`,
    },
  });
  try {
    await buildWorkspace(p);
    const baseline = federateAsk(p, undefined, "quartz", {
      limit: 8,
      graphRank: false,
      fileTopLock: false,
    });
    const a5 = federateAsk(p, undefined, "quartz", {
      limit: 8,
      graphRank: false,
      source: true,
    });
    const explicitA5 = federateAsk(p, undefined, "quartz", {
      limit: 8,
      graphRank: false,
      source: true,
      fileTopLock: true,
    });

    assert.deepEqual(
      a5,
      explicitA5,
      "the workspace default route is exactly the explicit file-aware configuration",
    );

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
      "the parent lock reproduces the exact pre-file-RRF workspace top",
    );

    const files = a5.hits.map((hit) => hit.pointer.replace(/:L\d+-L\d+$/, ""));
    const firstDuplicate = files.findIndex(
      (file, index) => files.indexOf(file) !== index,
    );
    assert.equal(firstDuplicate, 4, "all four child/file documents emit before a tail span");
    assert.equal(new Set(files.slice(0, firstDuplicate)).size, 4);
    assert.ok(files.includes("repoA/a.ts"));
    assert.ok(files.includes("repoB/a.ts"), "same relative paths in different children remain distinct");
    assert.ok(files.slice(firstDuplicate).includes("repoA/a.ts"));
    assert.ok(files.slice(firstDuplicate).includes("repoB/a.ts"));
    const repoBTailScores = a5.hits
      .filter((hit) => hit.pointer.replace(/:L\d+-L\d+$/, "") === "repoB/a.ts")
      .map((hit) => hit.score);
    assert.ok(repoBTailScores.length > 1, "fixture reaches a non-locked queue tail");
    assert.equal(
      new Set(repoBTailScores).size,
      1,
      "every projected span in a non-locked file keeps the same cross-child RRF score",
    );
    const federated = new Set(a5.scopes?.federated ?? []);
    assert.ok(
      a5.scopes?.alsoMatched.every((match) => !federated.has(match.scope)),
      "a locked or otherwise federated scope is never also reported as gated out",
    );
    assert.ok(
      a5.hits.filter((hit) => hit.kind === "symbol").every((hit) => hit.code?.includes("function")),
      "source mode inlines both file leaders and queue tails",
    );
  } finally {
    rmSync(p, { recursive: true, force: true });
  }
});

test("file-union admission preserves the workspace baseline top-lock survivor set", async () => {
  const p = workspaceFx({
    repoStrong: {
      "strong.ts": `export function alphaBetaGamma() { return "alpha beta gamma"; }\n`,
    },
    repoDistributed: {
      "distributed.ts":
        `export function neutralOne() { return "alpha"; }\n` +
        `export function neutralTwo() { return "beta"; }\n` +
        `export function neutralThree() { return "gamma"; }\n`,
    },
  });
  try {
    await buildWorkspace(p);
    const baseline = federateAsk(p, undefined, "alpha beta gamma", {
      limit: 8,
      graphRank: false,
      fileTopLock: false,
    });
    assert.ok(baseline.hits.every((hit) => hit.scope?.startsWith("repoStrong")));
    assert.ok(baseline.scopes?.alsoMatched.some((match) => match.scope === "repoDistributed"));

    const a5 = federateAsk(p, undefined, "alpha beta gamma", {
      limit: 8,
      graphRank: false,
    });
    assert.deepEqual(
      {
        title: a5.hits[0].title,
        pointer: a5.hits[0].pointer,
        score: a5.hits[0].score,
        scope: a5.hits[0].scope,
      },
      {
        title: baseline.hits[0].title,
        pointer: baseline.hits[0].pointer,
        score: baseline.hits[0].score,
        scope: baseline.hits[0].scope,
      },
      "the lock is computed from the original baseline participation gate",
    );
    assert.ok(
      a5.hits.some((hit) => hit.scope?.startsWith("repoDistributed")),
      "file union may admit a newly coherent child into ranks below the lock",
    );
    assert.ok(!a5.scopes?.alsoMatched.some((match) => match.scope === "repoDistributed"));
    const excluded = new Set(a5.scopes?.alsoMatched.map((match) => match.scope) ?? []);
    assert.ok(
      a5.hits.every((hit) => !excluded.has(hit.scope?.split("/")[0] ?? "")),
      "the baseline top lock never resurrects a child reported as gated out",
    );
  } finally {
    rmSync(p, { recursive: true, force: true });
  }
});

test("ask inside a single child = standalone (no federation scopes)", async () => {
  const p = workspaceFx(REPOS);
  await buildWorkspace(p);
  const { ask } = await import("../src/ask/ask.js");
  const r = ask(join(p, "repoA"), "handler", {});
  assert.equal(r.scopes, undefined); // single-scope repo → no scope labels
  assert.ok(r.hits.length > 0);
  assert.ok(!r.hits.some((h) => h.pointer.startsWith("repoA/"))); // paths are child-relative
  rmSync(p, { recursive: true, force: true });
});

test("migration: mega-graph parent split → .graph removed, workspace.json written, exact note", async () => {
  const p = workspaceFx(REPOS);
  // Pre-seed a hand-built combined mega-graph at the parent.
  const mega: GraphV1 = {
    meta: { version: 1, nodeCount: 0, edgeCount: 0, languages: [] },
    nodes: [],
    edges: [],
  };
  writeGraph(mega, contextDirFor(p));
  assert.equal(existsSync(wiringPath(contextDirFor(p))), true);

  const { migrated } = await buildWorkspace(p);
  assert.equal(migrated, true);
  assert.equal(existsSync(wiringPath(contextDirFor(p))), false); // mega-graph gone
  assert.equal(existsSync(join(contextDirFor(p), "workspace.json")), true);

  assert.equal(
    migrationNote(["repoA", "repoB"]),
    "⚠ this folder contains 2 separate git repos — splitting: each repo now gets its own committable graft/ (repoA/graft/, repoB/graft/); the combined graph here is replaced by a workspace index. Queries from here now search all repos, fairly.",
  );
  rmSync(p, { recursive: true, force: true });
});

test("check federation: OK when all in sync, STALE + not-ok when a child drifts", async () => {
  const p = workspaceFx(REPOS);
  await buildWorkspace(p);

  const fresh = await federateCheck(p);
  assert.equal(fresh.ok, true);
  assert.ok(fresh.text.includes("repoA/: OK"));
  assert.ok(fresh.text.includes("repoB/: OK"));

  // Change repoA's code WITHOUT rebuilding → present-and-stale.
  writeFileSync(join(p, "repoA", "a.ts"), "export function alphaHandler() { return 99; }\nexport function newlyAdded() { return 0; }\n");
  const drifted = await federateCheck(p);
  assert.equal(drifted.ok, false);
  assert.ok(drifted.text.includes("repoA/: STALE"));
  rmSync(p, { recursive: true, force: true });
});

test("callers federation resolves a symbol per child, grouped", async () => {
  const p = workspaceFx(REPOS);
  await buildWorkspace(p);
  const { text, found } = federateCallers(p, undefined, "helperThing", {});
  assert.equal(found, true);
  assert.ok(text.includes("## repoA/"));
  rmSync(p, { recursive: true, force: true });
});

test("grep federation merges groups across children with child-prefixed paths", async () => {
  const p = workspaceFx(REPOS);
  await buildWorkspace(p);
  const { result } = federateGrep(p, undefined, "Handler", { ignoreCase: true });
  assert.ok(result.totalHits >= 2);
  const paths = result.groups.map((g) => g.path);
  assert.ok(paths.some((p) => p.startsWith("repoA/")));
  assert.ok(paths.some((p) => p.startsWith("repoB/")));
  rmSync(p, { recursive: true, force: true });
});

test("one unbuilt child is surfaced, not silently skipped", async () => {
  const p = workspaceFx({
    ...REPOS,
    repoC: { "c.ts": "export function gammaHandler() { return 3; }\n" },
  });
  await buildWorkspace(p);
  // Simulate repoC never having been built.
  rmSync(contextDirFor(join(p, "repoC")), { recursive: true, force: true });

  const wg = loadWorkspaceGraphs(p);
  assert.deepEqual(wg.loaded.map((l) => l.child), ["repoA", "repoB"]);
  assert.deepEqual(wg.missing, ["repoC"]);
  assert.equal(
    coverageNote(wg),
    "2 of 3 workspace repos have graphs; run graft build to cover repoC",
  );
  rmSync(p, { recursive: true, force: true });
});

const JUNK = {
  repoA: { "a.ts": "export function invoiceTotalTaxBreakdown() { return sumLineItems(); }\nfunction sumLineItems() { return 0; }\n" },
  repoB: { "b.ts": "export function renderPanel() { const total = 0; return total; }\nfunction helper() { return 1; }\n" },
};

test("federated ask: a junk-body-token child is gated out of the ranking, into alsoMatched", async () => {
  const p = workspaceFx(JUNK);
  await buildWorkspace(p);
  // repoA genuinely matches all query terms (coverage 1.0); repoB matches only
  // the incidental body token "total" (coverage ~0.19) → below 0.25×best.
  const r = federateAsk(p, undefined, "invoice total tax breakdown", { limit: 8 });
  const titles = r.hits.map((h) => h.title);
  assert.ok(titles.some((t) => t.startsWith("invoiceTotalTaxBreakdown")), "repoA genuine hit federates");
  assert.ok(!titles.some((t) => t.startsWith("renderPanel")), `junk hit must NOT federate:\n${titles.join("\n")}`);
  assert.ok(r.hits.every((h) => h.scope!.startsWith("repoA")), "only repoA federates");
  assert.deepEqual(r.scopes?.alsoMatched.map((m) => m.scope), ["repoB"], "junk child reported in alsoMatched");
  const a5 = federateAsk(p, undefined, "invoice total tax breakdown", {
    limit: 8,
    fileTopLock: true,
  });
  assert.ok(a5.hits.some((hit) => hit.title.startsWith("invoiceTotalTaxBreakdown")));
  assert.ok(!a5.hits.some((hit) => hit.title.startsWith("renderPanel")));
  assert.deepEqual(
    a5.scopes?.alsoMatched.map((match) => match.scope),
    ["repoB"],
    "file-aware ranking gates on fresh top-file coverage instead of stale metadata",
  );
  rmSync(p, { recursive: true, force: true });
});

test("federated ask: a genuinely-shared query still federates both children", async () => {
  const p = workspaceFx(REPOS);
  await buildWorkspace(p);
  const r = federateAsk(p, undefined, "handler", { limit: 8 });
  const scopeSet = new Set(r.hits.map((h) => h.scope!.split("/")[0]));
  assert.ok(scopeSet.has("repoA") && scopeSet.has("repoB"), "both children federate a shared term");
  rmSync(p, { recursive: true, force: true });
});

test("federated ask: --in <child> narrows to that child; --in <unknown> errors listing repos", async () => {
  const p = workspaceFx(REPOS);
  await buildWorkspace(p);
  const scoped = federateAsk(p, undefined, "handler", { limit: 8, in: "repoA" });
  assert.ok(scoped.hits.length > 0);
  assert.ok(scoped.hits.every((h) => h.scope!.startsWith("repoA")), "--in repoA excludes repoB");
  // trailing slash tolerated, same as single-repo --in
  assert.ok(federateAsk(p, undefined, "handler", { in: "repoA/" }).hits.every((h) => h.scope!.startsWith("repoA")));
  assert.throws(
    () => federateAsk(p, undefined, "handler", { in: "nope" }),
    /no workspace repo "nope".*repoA.*repoB/s,
  );
  rmSync(p, { recursive: true, force: true });
});

test("federated ask: explicit --in <weak child> bypasses the cross-child gate (footer hint is reachable)", async () => {
  // repoJunk matches `position` only in a body token — gated OUT of the fused
  // ranking and reported in alsoMatched with a `narrow with --in repoJunk` hint.
  // Following that hint (--in repoJunk) MUST return repoJunk's hits, not empty:
  // an explicit single-child scope has no cross-child fairness concern.
  const p = workspaceFx({
    repoStrong: { "m.ts": "export function scrollbarOverlay() { return computeThumb(); }\nfunction computeThumb() { return 1; }\n" },
    repoJunk: { "m.ts": "export function drawFrame() { const position = 0; return position; }\nfunction helper() { return 1; }\n" },
  });
  await buildWorkspace(p);
  // Unscoped: repoJunk is gated to alsoMatched (documents the hint the user follows).
  const unscoped = federateAsk(p, undefined, "scrollbar overlay position", { limit: 8 });
  assert.ok(unscoped.scopes?.alsoMatched.some((m) => m.scope === "repoJunk"), "junk reported in alsoMatched");
  // Following the hint: --in repoJunk returns repoJunk's own (weak) hits.
  const scoped = federateAsk(p, undefined, "scrollbar overlay position", { limit: 8, in: "repoJunk" });
  assert.ok(scoped.hits.length > 0, "explicit --in on a gate-weak child must not return empty");
  assert.ok(scoped.hits.every((h) => h.scope!.startsWith("repoJunk")), "--in repoJunk stays in repoJunk");
  rmSync(p, { recursive: true, force: true });
});

for (const padN of [0, 200]) {
  test(`strength gate: body-only junk (\`position\`) gated out at ${padN ? "~200" : "~30"}-node scale`, async () => {
    const strongPad = padN ? { "pad.ts": pad(padN) } : {};
    const p = workspaceFx({
      repoStrong: { "m.ts": "export function scrollbarOverlay() { return computeThumb(); }\nfunction computeThumb() { return 1; }\n", ...strongPad },
      repoJunk: { "m.ts": "export function drawFrame() { const position = 0; return position; }\nfunction helper() { return 1; }\n", ...strongPad },
    });
    await buildWorkspace(p);
    const r = federateAsk(p, undefined, "scrollbar overlay position", { limit: 8 });
    const titles = r.hits.map((h) => h.title);
    assert.ok(titles.some((t) => t.startsWith("scrollbarOverlay")), "name-match child federates");
    assert.ok(!titles.some((t) => t.startsWith("drawFrame")), `body-only junk must NOT federate:\n${titles.join("\n")}`);
    assert.ok(r.hits.every((h) => h.scope!.startsWith("repoStrong")), "only the strong child federates");
    assert.deepEqual(r.scopes?.alsoMatched.map((m) => m.scope), ["repoJunk"], "junk reported in alsoMatched");
    rmSync(p, { recursive: true, force: true });
  });
}

test("strength gate: 3-child payment/gateway/refund — strong + mid federate, incidental-var junk gated out", async () => {
  const p = workspaceFx({
    repoStrong: { "m.ts": "export function paymentGatewayRefund() { return 1; }\n", "pad.ts": pad(25) },
    repoMid: { "m.ts": "export function refundPayment() { return 1; }\n", "pad.ts": pad(25) }, // partial name match
    repoJunk: { "m.ts": "export function renderList() { const gateway = 0; return gateway; }\n", "pad.ts": pad(25) },
  });
  await buildWorkspace(p);
  const r = federateAsk(p, undefined, "payment gateway refund", { limit: 8 });
  const scopes = new Set(r.hits.map((h) => h.scope!.split("/")[0]));
  assert.ok(scopes.has("repoStrong") && scopes.has("repoMid"), "genuine name matches federate");
  assert.ok(!scopes.has("repoJunk"), "incidental-var junk excluded from the ranking");
  assert.ok(r.scopes?.alsoMatched.some((m) => m.scope === "repoJunk"), "junk reported in alsoMatched");
  rmSync(p, { recursive: true, force: true });
});

test("strength gate: a legit COMMON-term (low-idf) name match is NOT overcorrected out", async () => {
  let cfg = "export function loadConfig() { return 1; }\n";
  for (let i = 0; i < 15; i++) cfg += `export function config${i}Reader() { return ${i}; }\n`; // "config" common → low idf
  const p = workspaceFx({
    repoConfig: { "m.ts": cfg, "pad.ts": pad(25) },
    repoOther: { "m.ts": "export function unrelatedThing() { return 0; }\n", "pad.ts": pad(25) },
  });
  await buildWorkspace(p);
  const r = federateAsk(p, undefined, "config loader", { limit: 8 });
  assert.ok(r.hits.some((h) => h.scope!.startsWith("repoConfig")), "real partial-relevance (low-idf name hit) must still federate");
  rmSync(p, { recursive: true, force: true });
});

for (const [kind, junkFiles] of [
  ["file basename gateway.ts", { "src/gateway.ts": "export function renderList() { return 0; }\n" }],
  ["dir segment gateway/", { "gateway/handler.ts": "export function renderList() { return 0; }\n" }],
] as const) {
  test(`strength gate: junk matching only a ${kind} (no symbol named for the term) is gated out`, async () => {
    const p = workspaceFx({
      repoStrong: { "m.ts": "export function paymentGatewayRefund() { return 1; }\n", "pad.ts": pad(25) },
      repoJunk: { ...junkFiles, "pad.ts": pad(25) },
    });
    await buildWorkspace(p);
    const r = federateAsk(p, undefined, "payment gateway refund", { limit: 8 });
    assert.ok(r.hits[0]?.title.startsWith("paymentGatewayRefund"), `strong repo's real hit must be #1, got: ${r.hits[0]?.title}`);
    assert.ok(!r.hits.some((h) => h.scope!.startsWith("repoJunk")), "coincidental path-name junk must NOT federate");
    assert.ok(r.scopes?.alsoMatched.some((m) => m.scope === "repoJunk"), "junk reported in alsoMatched");
    rmSync(p, { recursive: true, force: true });
  });
}

test("readWorkspace: rejects foreign/invalid json as not-a-workspace", () => {
  const p = mkdtempSync(join(tmpdir(), "ws-"));
  mkdirSync(contextDirFor(p), { recursive: true });
  writeFileSync(join(contextDirFor(p), "workspace.json"), "{}");
  assert.equal(readWorkspace(p), null);
  writeWorkspace(p, { version: 1, children: ["x", "a"] });
  assert.deepEqual(readWorkspace(p), { version: 1, children: ["a", "x"] });
  rmSync(p, { recursive: true, force: true });
});

test("splitWorkspace: re-split keeps registry children discovery can't see, prunes dead/escaping entries", async () => {
  const p = workspaceFx(REPOS);
  await buildWorkspace(p);
  // A child nested deeper than immediate-dir discovery, added to the registry
  // by hand — mirrors a parent root whose git repos aren't immediate children.
  mkdirSync(join(p, "nested", "repoC", ".git"), { recursive: true });
  writeFileSync(join(p, "nested", "repoC", "c.ts"), "export function gammaHandler() { return 3; }\n");
  const ws = readWorkspace(p, undefined)!;
  writeWorkspace(p, { version: 1, children: [...ws.children, "nested/repoC", "gone", "../outside"] });

  const { children } = await buildWorkspace(p); // discovery alone sees only repoA/repoB
  assert.ok(children.includes("nested/repoC"), "hand-registered nested child survives the re-split");
  assert.deepEqual(readWorkspace(p, undefined)!.children, ["nested/repoC", "repoA", "repoB"]);
  assert.ok(existsSync(contextDirFor(join(p, "nested", "repoC"))), "surviving registered child was built too");
  rmSync(p, { recursive: true, force: true });
});
