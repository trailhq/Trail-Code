/**
 * `graft blast` — the blast radius of a diff, which is what the CI job posts on a
 * pull request.
 *
 * The behaviour worth pinning down is the SEEDING rule, because that is what makes
 * the answer different from "every file that imports this module": a one-line edit
 * inside one function reports that function's dependents, and says nothing about
 * the untouched function next to it in the same file. The fixture below is built
 * for exactly that check — `add` and `mul` live in one file with separate callers.
 *
 * Runs the real CLI through a real git repo (the command reads git, so a fake diff
 * would prove nothing about the parsing).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { runCli, tmpRepo } from "./helpers.js";
import { changedFiles } from "../src/blast/diff.js";

const MATH = `export function add(a: number, b: number): number {
  return a + b;
}

export function mul(a: number, b: number): number {
  return a * b;
}
`;

/** `add`'s body only — same line count, so `mul`'s span never moves. */
const MATH_EDITED = `export function add(a: number, b: number): number {
  return b + a;
}

export function mul(a: number, b: number): number {
  return a * b;
}
`;

function git(dir: string, ...args: string[]): void {
  const r = spawnSync("git", args, { cwd: dir, encoding: "utf8" });
  assert.equal(r.status, 0, `git ${args.join(" ")} failed: ${r.stderr}`);
}

/**
 * A committed, built repo: `add`/`mul` in one file, one caller each, and one
 * second-hop caller of `add`'s caller so `--depth` has something to walk.
 */
function builtRepo(): string {
  const d = tmpRepo("blast");
  mkdirSync(join(d, "src"), { recursive: true });
  writeFileSync(join(d, "src", "math.ts"), MATH);
  writeFileSync(
    join(d, "src", "total.ts"),
    'import { add } from "./math.js";\nexport function total(xs: number[]): number {\n  return xs.reduce((s, x) => add(s, x), 0);\n}\n',
  );
  writeFileSync(
    join(d, "src", "area.ts"),
    'import { mul } from "./math.js";\nexport function area(w: number, h: number): number {\n  return mul(w, h);\n}\n',
  );
  writeFileSync(
    join(d, "src", "report.ts"),
    'import { total } from "./total.js";\nexport function report(xs: number[]): string {\n  return `sum=${total(xs)}`;\n}\n',
  );
  writeFileSync(join(d, "README.md"), "# fixture\n");

  git(d, "init", "-b", "main");
  git(d, "config", "user.email", "test@example.com");
  git(d, "config", "user.name", "test");
  git(d, "add", "-A");
  git(d, "commit", "-m", "initial");

  const build = runCli(["build", d]);
  assert.equal(build.status, 0, build.describe());
  // The build writes ignore rules for its own cache dir; commit them so a later
  // `git add -A` in a test is the test's own edit and nothing else.
  git(d, "add", "-A");
  git(d, "commit", "-m", "index");
  return d;
}

/** Parse `--format json` output, failing with the whole run on bad JSON. */
function blastJson(args: string[]): {
  basis: string;
  changed: { path: string; status: string; ranges: { start: number; end: number }[] }[];
  unindexed: string[];
  deleted: string[];
  seeds: { name: string; path: string; wholeFile: boolean }[];
  impacted: { name: string; path: string; depth: number; relation: string }[];
  modules: { label: string; files: string[]; symbols: { name: string }[]; from: string[] }[];
} {
  const r = runCli(["blast", ...args, "--format", "json"]);
  assert.equal(r.status, 0, r.describe());
  try {
    return JSON.parse(r.stdout);
  } catch {
    assert.fail(`not JSON:\n${r.describe()}`);
  }
}

test("blast: an edit inside one function reports that function's dependents, not the file's", () => {
  const d = builtRepo();
  writeFileSync(join(d, "src", "math.ts"), MATH_EDITED);

  const report = blastJson([d]);

  assert.deepEqual(report.seeds.map((s) => s.name), ["add"], "only the edited function is a seed");
  const names = report.impacted.map((i) => i.name);
  assert.ok(names.includes("total"), `expected total in ${JSON.stringify(names)}`);
  assert.ok(names.includes("report"), `expected the second hop in ${JSON.stringify(names)}`);
  // The point of seeding by symbol: `area` calls `mul`, which this diff never
  // touched, even though it sits in the same changed file.
  assert.ok(!names.includes("area"), `area must not be reported: ${JSON.stringify(names)}`);
});

for (const [key, value] of [["diff.mnemonicPrefix", "true"], ["diff.dstPrefix", "after/"]]) {
  test(`blast: ${key} preserves symbol-level seeds and dependents`, (t) => {
    const d = builtRepo();
    t.after(() => rmSync(d, { recursive: true, force: true }));
    git(d, "config", key, value);
    writeFileSync(join(d, "src", "math.ts"), MATH_EDITED);

    const report = blastJson([d]);
    assert.deepEqual(report.seeds.map((seed) => seed.name), ["add"]);
    assert.ok(report.seeds.every((seed) => !seed.wholeFile));
    assert.deepEqual(report.changed[0].ranges, [{ start: 2, end: 2 }]);
    assert.deepEqual(new Set(report.impacted.map((item) => item.name)), new Set(["total", "report"]));
  });
}

test("blast --depth: one hop stops at the direct caller", () => {
  const d = builtRepo();
  writeFileSync(join(d, "src", "math.ts"), MATH_EDITED);

  const names = blastJson([d, "--depth", "1"]).impacted.map((i) => i.name);
  assert.deepEqual(names, ["total"]);
});

test("blast --base: diffs against the merge base, and reports the ranges it read", () => {
  const d = builtRepo();
  git(d, "checkout", "-b", "feature");
  writeFileSync(join(d, "src", "math.ts"), MATH_EDITED);
  git(d, "add", "-A");
  git(d, "commit", "-m", "tweak add");

  const report = blastJson([d, "--base", "main"]);

  assert.equal(report.basis, "main...HEAD");
  assert.deepEqual(report.changed.map((c) => c.path), ["src/math.ts"]);
  assert.deepEqual(report.changed[0].ranges, [{ start: 2, end: 2 }], "the one changed line");
  assert.ok(report.impacted.some((i) => i.name === "total"));
});

test("blast: a changed file no parser claims is reported, never silently dropped", () => {
  const d = builtRepo();
  writeFileSync(join(d, "README.md"), "# fixture\n\nnow with prose\n");

  const report = blastJson([d]);

  assert.deepEqual(report.unindexed, ["README.md"]);
  assert.deepEqual(report.impacted, [], "nothing to walk from an unindexed file");
});

test("blast: a deleted file is called out, since its dependents are not in this graph", () => {
  const d = builtRepo();
  rmSync(join(d, "src", "area.ts"));

  const report = blastJson([d]);

  assert.deepEqual(report.deleted, ["src/area.ts"]);
  const text = runCli(["blast", d]);
  assert.equal(text.status, 0, text.describe());
  assert.match(text.stdout, /1 deleted file/);
});

test("blast --format markdown: diagram first, detail collapsed under it", () => {
  const d = builtRepo();
  writeFileSync(join(d, "src", "math.ts"), MATH_EDITED);

  const r = runCli(["blast", d, "--format", "markdown"]);
  assert.equal(r.status, 0, r.describe());
  assert.match(r.stdout, /```mermaid\nflowchart TB/);
  // Circles for what can break, labelled by area — never one box per changed file,
  // and never a bare path: with no concept node, the hub symbol names the area.
  assert.match(r.stdout, /A0\(\("total<br\/>2 symbols"\)\)/);
  assert.match(r.stdout, /\| Can be affected \| Symbols \| Nearest hop \| Reached from \|/);
  assert.match(r.stdout, /<details>/);
  assert.match(r.stdout, /`src\/total\.ts:L\d+-L\d+` — total \(calls, depth 1\)/);
  // The fixture ships no tests, so the one changed area must say so — in the glyph
  // on its circle and in the collapsed section.
  assert.match(r.stdout, /✗/);
  assert.match(r.stdout, /no test file reaches it/);
  // Labels carry a line break as markup, not as the literal text of the tag.
  assert.ok(!/br\/\d+ file/.test(r.stdout), "the <br/> in a node label must survive escaping");
});

test("blast --format mermaid: bare diagram, and a comment (not a failure) when there is nothing to draw", () => {
  const d = builtRepo();
  writeFileSync(join(d, "src", "math.ts"), MATH_EDITED);
  const drawn = runCli(["blast", d, "--format", "mermaid"]);
  assert.equal(drawn.status, 0, drawn.describe());
  assert.match(drawn.stdout, /^flowchart TB/);

  // A README-only diff has no dependents: a CI step must not fail on that.
  writeFileSync(join(d, "src", "math.ts"), MATH);
  writeFileSync(join(d, "README.md"), "# fixture\n\nprose\n");
  const empty = runCli(["blast", d, "--format", "mermaid"]);
  assert.equal(empty.status, 0, empty.describe());
  assert.match(empty.stdout, /no dependents to draw/);
});

test("blast: an unknown --base names the CI cause (checkout depth), not a git internal", () => {
  const d = builtRepo();
  const r = runCli(["blast", d, "--base", "origin/nope"]);
  assert.equal(r.status, 1, r.describe());
  assert.match(r.stderr, /base ref "origin\/nope" is not in this checkout/);
  assert.match(r.stderr, /fetch-depth: 0/);
});

test("blast: an area is named after its most-depended-on function, not the last one seen", () => {
  const d = builtRepo();
  // `add` is called by total (and transitively by report); `unused` is called by
  // nothing. Editing both must label the area `add`, whichever order the walk sees
  // them in — before this, the label was whatever symbol the file ended on.
  writeFileSync(
    join(d, "src", "math.ts"),
    "export function add(a: number, b: number): number {\n  return a + b + 0;\n}\n" +
      "export function unused(): number {\n  return 41 + 1;\n}\n",
  );

  const report = blastJson([d]);
  assert.equal(report.areas.length, 1);
  assert.equal(report.areas[0].seedNames[0], "add", `ranked hub, got ${report.areas[0].seedNames.join(", ")}`);
  assert.equal(report.areas[0].label, "add");
});

test("blast: a clean tree reports the last commit rather than nothing at all", () => {
  const d = builtRepo();
  writeFileSync(join(d, "src", "math.ts"), MATH_EDITED);
  git(d, "add", "-A");
  git(d, "commit", "-m", "tweak add");

  const report = blastJson([d]);
  assert.equal(report.basis, "HEAD~1...HEAD");
  assert.ok(report.impacted.some((i) => i.name === "total"));
});

test("diff: hunks carry their text, and the next file's header is not read as a deleted line", () => {
  const d = builtRepo();
  // A `--` line of SQL is the trap: `--- a/x.sql` is a header, `-- comment` is
  // content, and both start with a dash in the patch.
  writeFileSync(join(d, "src", "math.ts"), MATH_EDITED);
  writeFileSync(join(d, "query.sql"), "-- report\n");
  git(d, "add", "-A");
  git(d, "commit", "-m", "edit");

  const res = changedFiles(d, "HEAD~1");
  assert.ok(res);
  const math = res.files.find((f) => f.path === "src/math.ts");
  assert.ok(math);
  assert.deepEqual(math.hunks.map((h) => h.lines), [[
    { n: null, sign: "-", text: "  return a + b;" },
    { n: 2, sign: "+", text: "  return b + a;" },
  ]], "both sides of the edit, with post-image numbering");
  assert.deepEqual(math.ranges, math.hunks.map((h) => ({ start: h.start, end: h.end })), "ranges mirror hunks");
  assert.ok(
    !math.hunks.some((h) => h.lines.some((l) => l.text.includes("query.sql"))),
    "the next file's --- header stayed out of this file's hunk",
  );

  const sql = res.files.find((f) => f.path === "query.sql");
  assert.deepEqual(sql?.hunks[0].lines, [{ n: 1, sign: "+", text: "-- report" }], "a real -- line survives");
});
