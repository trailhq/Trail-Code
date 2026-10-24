/**
 * What graft *calls* the languages it indexed, as distinct from the tree-sitter
 * grammar it used to parse them.
 *
 * The bug (#36): `.mjs` and `.js` are parsed by the typescript grammar and `.jsx` by
 * the tsx one, and those grammar names were reported verbatim as the languages
 * present. A repo of four `.ts` files and one `.mjs` announced `[typescript]` while
 * the `.mjs` file's symbols were perfectly queryable, so the banner — the natural
 * place to check coverage — sent people looking for a problem that wasn't there, and
 * gave them no way to tell a language that was merely unlabelled from one that
 * really had been skipped.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildGraph } from "../src/graph/build.js";
import { buildRepoMap } from "../src/graph/map.js";
import {
  kotlinParserUnavailableMessage,
  languageLabelOf,
  languageOf,
  swapKotlinGrammarLoaderForTest,
} from "../src/graph/extract.js";
import { readGraph, wiringPath } from "../src/graph/write.js";

/** Every extension graft claims to index, one per grammar/label pairing. */
const INDEXED = [
  "a.ts", "a.mts", "a.cts",
  "a.js", "a.mjs", "a.cjs",
  "a.tsx", "a.jsx",
  "a.py", "a.pyi",
  "a.go",
  "a.R", "a.r",
  "a.java",
"a.kt", "a.kts",
  "a.swift",
  "a.php",
];

test("a file is labelled exactly when it is indexed", () => {
  // The guard that keeps #36 from coming back: both readings come off one table, so
  // adding an extension cannot teach the extractor about it and leave the banner
  // silent (or vice versa — claiming coverage of a file nothing can parse).
  for (const f of [...INDEXED, "a.txt", "a.rs", "README.md", "noextension", ""]) {
    // (".rs" stays a null case here: Rust is breadth-tier, which this table doesn't cover.)
    assert.equal(
      languageOf(f) === null,
      languageLabelOf(f) === null,
      `${f}: languageOf and languageLabelOf disagree about whether it is indexed`,
    );
  }
});

test("labels name the language, not the grammar that parses it", () => {
  assert.equal(languageLabelOf("scripts/tool.mjs"), "javascript");
  assert.equal(languageLabelOf("scripts/tool.cjs"), "javascript");
  assert.equal(languageLabelOf("web/app.js"), "javascript");
  assert.equal(languageLabelOf("web/app.jsx"), "jsx");
  assert.equal(languageLabelOf("src/app.tsx"), "tsx");
  assert.equal(languageLabelOf("src/app.ts"), "typescript");
  assert.equal(languageLabelOf("src/app.mts"), "typescript");
  assert.equal(languageLabelOf("api/main.py"), "python");
  assert.equal(languageLabelOf("api/main.pyi"), "python");
  assert.equal(languageLabelOf("cmd/main.go"), "go");
  assert.equal(languageLabelOf("analysis/model.R"), "r");
  assert.equal(languageLabelOf("analysis/model.r"), "r");
  assert.equal(languageLabelOf("src/main/java/com/acme/App.java"), "java");
assert.equal(languageLabelOf("src/main/kotlin/com/acme/App.kt"), "kotlin");
  assert.equal(languageLabelOf("scripts/main.kts"), "kotlin");
  assert.equal(languageLabelOf("Sources/App/main.swift"), "swift");
  assert.equal(languageLabelOf("app/Models/User.php"), "php");

  // The grammar is unchanged — extraction, the extract cache and every `Language`
  // switch still see exactly what they saw before.
  assert.equal(languageOf("scripts/tool.mjs"), "typescript");
  assert.equal(languageOf("web/app.jsx"), "tsx");
});

test("labels are case-insensitive, like the grammar lookup", () => {
  assert.equal(languageLabelOf("src/App.TSX"), "tsx");
  assert.equal(languageLabelOf("scripts/TOOL.MJS"), "javascript");
});

test("the build banner and repo map report every language they indexed", async () => {
  // #36's repro, generalized: one file per label, all of them genuinely parsed.
  const d = mkdtempSync(join(tmpdir(), "graft-langs-"));
  mkdirSync(join(d, "src"), { recursive: true });
  mkdirSync(join(d, "scripts"), { recursive: true });
  writeFileSync(join(d, "src", "a.ts"), "export function tsOnly(): number {\n  return 1;\n}\n");
  writeFileSync(join(d, "src", "b.tsx"), "export function TsxOnly(): null {\n  return null;\n}\n");
  writeFileSync(join(d, "scripts", "tool.mjs"), "export function mjsOnlySymbol() {\n  return 1;\n}\n");
  writeFileSync(join(d, "scripts", "web.jsx"), "export function JsxOnly() {\n  return null;\n}\n");
  writeFileSync(join(d, "src", "c.py"), "def py_only():\n    return 1\n");
  writeFileSync(join(d, "src", "a.kt"), "fun ktOnly(): Int {\n  return 1\n}\n");
  writeFileSync(join(d, "src", "a.swift"), "func swiftOnly() -> Int {\n  return 1\n}\n");

  const r = await buildGraph(d);
  const kotlinAvailable = !r.errors.some((error) => error.startsWith("Kotlin files were skipped"));
  assert.deepEqual(
    r.languages,
    ["javascript", "jsx", ...(kotlinAvailable ? ["kotlin"] : []), "python", "swift", "tsx", "typescript"],
  );

  // The reported symbol was queryable all along — that mismatch is what the issue was
  // about, so pin both halves together.
  const graph = readGraph(wiringPath(r.contextDir));
  assert.ok(
    graph?.nodes.some((n) => n.name === "mjsOnlySymbol"),
    "the .mjs file really is indexed, which is why omitting its label misled",
  );

  // `map` derives labels from paths independently, so it gets its own assertion.
  assert.deepEqual(buildRepoMap(graph!).totals.languages, r.languages);
});

test("Kotlin is indexed when its optional parser is available", async (t) => {
  if (kotlinParserUnavailableMessage()) {
    t.skip("tree-sitter-kotlin is unavailable in this runtime");
    return;
  }
  const dir = mkdtempSync(join(tmpdir(), "graft-kotlin-available-"));
  writeFileSync(join(dir, "app.kt"), "fun indexedKotlin(): Int = 1\n");
  const result = await buildGraph(dir, { reuse: false });
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.languages, ["kotlin"]);
  const graph = readGraph(wiringPath(result.contextDir))!;
  assert.ok(graph.nodes.some((node) => node.name === "indexedKotlin"), "Kotlin function is indexed");
});

test("a missing Kotlin parser skips Kotlin only and leaves TypeScript indexed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "graft-kotlin-optional-"));
  writeFileSync(join(dir, "app.ts"), "export function stillIndexed() { return 1; }\n");
  writeFileSync(join(dir, "app.kt"), "fun skippedKotlin(): Int = 1\n");
  const restore = swapKotlinGrammarLoaderForTest(() => {
    throw new Error("Cannot find module 'tree-sitter-kotlin'");
  });
  try {
    const result = await buildGraph(dir, { reuse: false });
    assert.equal(result.errors.length, 1, "one Kotlin availability warning");
    assert.match(result.errors[0], /Kotlin files were skipped/);
    assert.deepEqual(result.languages, ["typescript"]);
    const graph = readGraph(wiringPath(result.contextDir))!;
    assert.ok(graph.nodes.some((node) => node.name === "stillIndexed"), "TypeScript remains indexed");
    assert.ok(!graph.nodes.some((node) => node.path === "app.kt"), "Kotlin contributes no partial nodes");
  } finally {
    restore();
  }
});
