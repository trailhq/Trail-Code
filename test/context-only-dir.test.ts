/**
 * #252 — `graft build --deep --only-dir` must not walk the whole repo.
 *
 * Tier-1 wiring already honors `--only-dir` (`filterByOnlyDirs`). The Tier-2
 * concept pass (`buildContext`) and its freshness check (`checkContext`) must
 * enumerate the same whitelist — otherwise out-of-scope files get summarized
 * and pulled into concept synthesis, and `graft check` reports them as added.
 *
 * No LLM: a recording summarizer is the queue. Wiring assertions reuse
 * `buildGraph` so this file cannot drift from `graph-only-dir.test.ts`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { buildContext } from "../src/context/build.js";
import { checkContext } from "../src/context/check.js";
import { buildGraph } from "../src/graph/build.js";
import { readGraph, wiringPath } from "../src/graph/write.js";
import { Graft } from "../src/engine.js";
import { fakeProviders, tmpRepo } from "./helpers.js";
import type { FileSummary, Summarizer, Synthesizer } from "../src/index.js";

function repoWithOutOfScope(): string {
  const d = tmpRepo("ctx-only-dir");
  mkdirSync(join(d, "src"), { recursive: true });
  mkdirSync(join(d, "tools"), { recursive: true });
  mkdirSync(join(d, "docs"), { recursive: true });
  writeFileSync(join(d, "src", "a.ts"), "// [[In Scope]]\nexport const a = 1;\n");
  writeFileSync(join(d, "tools", "b.ts"), "// [[Out Of Scope Tools]]\nexport const b = 2;\n");
  // `.md` is not a concept-pass extension; a source file under docs/ is the
  // evidence-copy case from #252 (backend sources kept under docs/**).
  writeFileSync(join(d, "docs", "c.ts"), "// [[Out Of Scope Docs]]\nexport const c = 3;\n");
  return d;
}

function recording(): {
  summarized: string[];
  synthesized: string[];
  summarizer: Summarizer;
  synthesizer: Synthesizer;
} {
  const summarized: string[] = [];
  const synthesized: string[] = [];
  const inner = fakeProviders();
  return {
    summarized,
    synthesized,
    summarizer: {
      async summarize(code: string, opts: { path: string }) {
        summarized.push(opts.path);
        return inner.summarizer.summarize(code, opts);
      },
    },
    synthesizer: {
      async synthesize(files: FileSummary[]) {
        for (const f of files) synthesized.push(f.path);
        return inner.synthesizer.synthesize(files);
      },
    },
  };
}

function manifestPaths(dir: string): string[] {
  const manifest = JSON.parse(readFileSync(join(dir, "graft", "manifest.json"), "utf8")) as {
    files: Array<{ path: string }>;
  };
  return manifest.files.map((f) => f.path).sort();
}

test("an explicit empty selection restores the full concept scope after a restricted build", async () => {
  const dir = repoWithOutOfScope();
  const rec = recording();
  try {
    await buildGraph(dir, { onlyDirs: ["src"] });
    await buildContext(dir, {
      model: "fake", summarizer: rec.summarizer, synthesizer: rec.synthesizer,
      onlyDirs: [],
    });
    assert.deepEqual([...rec.summarized].sort(), ["docs/c.ts", "src/a.ts", "tools/b.ts"]);
    assert.deepEqual(manifestPaths(dir), ["docs/c.ts", "src/a.ts", "tools/b.ts"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("#252: buildContext --only-dir src does not summarize or synthesize out-of-scope files", async () => {
  const dir = repoWithOutOfScope();
  const rec = recording();
  try {
    const r = await buildContext(dir, {
      model: "fake",
      summarizer: rec.summarizer,
      synthesizer: rec.synthesizer,
      onlyDirs: ["src"],
    });
    assert.deepEqual(r.errors, []);
    assert.deepEqual([...rec.summarized].sort(), ["src/a.ts"]);
    assert.deepEqual([...rec.synthesized].sort(), ["src/a.ts"]);
    assert.deepEqual(manifestPaths(dir), ["src/a.ts"]);
    assert.ok(!rec.summarized.includes("tools/b.ts"));
    assert.ok(!rec.summarized.includes("docs/c.ts"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("#252: multiple onlyDirs keep prefix semantics (src + tools, not docs)", async () => {
  const dir = repoWithOutOfScope();
  const rec = recording();
  try {
    await buildContext(dir, {
      model: "fake",
      summarizer: rec.summarizer,
      synthesizer: rec.synthesizer,
      onlyDirs: ["src", "tools"],
    });
    assert.deepEqual([...rec.summarized].sort(), ["src/a.ts", "tools/b.ts"]);
    assert.ok(!rec.summarized.includes("docs/c.ts"));
    assert.deepEqual(manifestPaths(dir), ["src/a.ts", "tools/b.ts"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("#252: concept pass falls back to the fingerprint whitelist when onlyDirs is omitted", async () => {
  const dir = repoWithOutOfScope();
  const rec = recording();
  try {
    await buildGraph(dir, { onlyDirs: ["src"] });
    await buildContext(dir, {
      model: "fake",
      summarizer: rec.summarizer,
      synthesizer: rec.synthesizer,
    });
    assert.deepEqual([...rec.summarized].sort(), ["src/a.ts"], "fingerprint onlyDirs must gate the concept walk");
    assert.deepEqual(manifestPaths(dir), ["src/a.ts"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("#252: checkContext does not report excluded files as coverage after a limited deep build", async () => {
  const dir = repoWithOutOfScope();
  try {
    await buildGraph(dir, { onlyDirs: ["src"] });
    await buildContext(dir, { model: "fake", ...fakeProviders(), onlyDirs: ["src"] });
    const check = checkContext(dir);
    assert.equal(check.ok, true, `expected clean check, got ${JSON.stringify(check)}`);
    assert.ok(!check.coverage.includes("tools/b.ts"));
    assert.ok(!check.coverage.includes("docs/c.ts"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("#252: Graft.init forwards onlyDirs (the --deep CLI path)", async () => {
  const dir = repoWithOutOfScope();
  const rec = recording();
  try {
    const engine = new Graft({ summarizer: rec.summarizer, synthesizer: rec.synthesizer });
    await engine.init(dir, { onlyDirs: ["src"] });
    assert.deepEqual([...rec.summarized].sort(), ["src/a.ts"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("#252: wiring still indexes only the whitelist when both layers run", async () => {
  const dir = repoWithOutOfScope();
  try {
    await buildContext(dir, { model: "fake", ...fakeProviders(), onlyDirs: ["src"] });
    await buildGraph(dir, { onlyDirs: ["src"] });
    const graph = readGraph(wiringPath(join(dir, "graft")));
    assert.ok(graph, "expected a wiring graph");
    const paths = new Set(graph!.nodes.map((n) => n.path));
    assert.ok(paths.has("src/a.ts"), "src stays in the wiring graph");
    assert.ok(!paths.has("tools/b.ts"), "tools must stay out of wiring");
    assert.ok(!paths.has("docs/c.ts"), "docs must stay out of wiring");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
