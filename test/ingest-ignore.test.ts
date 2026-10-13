/**
 * Unit tests for the ignore-file engine: the gitignore-dialect parser, the
 * last-match-wins matcher (with Git's directory-negation constraint), and the
 * source-resolution order (cursor < graftignore < explicit).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeJsonAtomic } from "../src/util/state.js";
import {
  createMatcher,
  parseIgnoreText,
  resolveIgnoreSources,
  matcherFor,
  GRAFT_NO_GRAFTIGNORE,
} from "../src/ingest/ignore.js";
import type { IgnoreSource } from "../src/ingest/ignore.js";

const one = (text: string): IgnoreSource => parseIgnoreText("test", text);
const match = (text: string) => createMatcher([one(text)]);
const matchSources = (texts: string[]) => createMatcher(texts.map((t) => one(t)));

test("comments and blank lines are dropped", () => {
  const m = match("# a comment\n\n   \n*.log\n");
  assert.equal(m.isIgnored("a.log"), true);
  assert.equal(m.isIgnored("a.ts"), false);
  assert.deepEqual(m.errors(), []);
});

test("a bare name matches files and directories at any depth", () => {
  const m = match("node_modules\n");
  assert.equal(m.isIgnored("node_modules"), true);
  assert.equal(m.isIgnored("node_modules/x"), true);
  assert.equal(m.isIgnored("src/node_modules"), true);
  assert.equal(m.isIgnored("src/node_modules/x/y.ts"), true);
  assert.equal(m.isIgnored("src/lib.ts"), false);
});

test("a trailing slash is a directory rule and excludes everything under it", () => {
  const m = match("out/\n");
  assert.equal(m.isIgnored("out"), true);
  assert.equal(m.isIgnored("out/a.js"), true);
  assert.equal(m.isIgnored("src/out/deep/x.js"), true);
  assert.equal(m.isIgnored("outside.js"), false, "must not prefix-match the name");
});

test("a leading slash anchors to the repo root", () => {
  const m = match("/test\n");
  assert.equal(m.isIgnored("test/x.js"), true);
  assert.equal(m.isIgnored("src/test/x.js"), false, "anchored: not at other depths");
});

test("a pattern containing a slash is relative to the repo root (git rule)", () => {
  const m = match("src/generated\n");
  assert.equal(m.isIgnored("src/generated/a.js"), true);
  assert.equal(m.isIgnored("lib/src/generated/a.js"), false, "slash patterns are root-relative");
});

test("wildcards: * stays within a segment, ? is one char, ** spans segments", () => {
  const m = match("*.min.js\nfoo/**\napi/??.js\n");
  assert.equal(m.isIgnored("a.min.js"), true);
  assert.equal(m.isIgnored("deep/dir/a.min.js"), true, "bare name matches any depth");
  assert.equal(m.isIgnored("a.min.css"), false);
  assert.equal(m.isIgnored("foo/one/two.ts"), true, "** spans any depth");
  assert.equal(m.isIgnored("foo/"), true);
  assert.equal(m.isIgnored("bar.ts"), false);
  assert.equal(m.isIgnored("api/12.js"), true);
  assert.equal(m.isIgnored("api/123.js"), false);
});

test("[...] character classes, negated and escaped", () => {
  const m = match("[abc].log\n[!0-9].log\na\\[b\\].ts\n");
  assert.equal(m.isIgnored("a.log"), true);
  assert.equal(m.isIgnored("d.log"), true, "[!0-9] matches letters");
  assert.equal(m.isIgnored("1.log"), false, "[!0-9] excludes digits");
  assert.equal(m.isIgnored("z.log"), true);
  assert.equal(m.isIgnored("a[b].ts"), true, "escaped brackets are literal");
  assert.equal(m.isIgnored("axb.ts"), false);
});

test("an unparseable pattern is reported and its rule is inert", () => {
  const s = one("[abc\nok.log\n");
  assert.equal(s.rules.length, 2, "the line still parses as a rule");
  const m = createMatcher([s]);
  assert.equal(m.errors().length, 1);
  assert.equal(m.errors()[0].line, 1);
  assert.match(m.errors()[0].message, /invalid pattern/);
  assert.equal(m.isIgnored("ok.log"), true, "the valid rule still works");
  assert.equal(m.isIgnored("xabc"), false, "the broken rule matches nothing");
});

test("the LAST matching rule across files wins, in file order", () => {
  const m = matchSources(["*.log", "!keep.log", "*.log"]);
  assert.equal(m.isIgnored("src/keep.log"), true, "the re-stated exclusion is last");
  assert.equal(m.isIgnored("src/other.log"), true);
  // Flipping the last rule to a negation flips the verdict.
  const m2 = matchSources(["*.log", "!keep.log"]);
  assert.equal(m2.isIgnored("src/keep.log"), false);
  assert.equal(m2.isIgnored("src/other.log"), true);
});

test("a later file's rule overrides an earlier file's, in order", () => {
  const m = matchSources(["gen/*", "!gen/keep.ts"]);
  assert.equal(m.isIgnored("gen/a.ts"), true);
  assert.equal(m.isIgnored("gen/keep.ts"), false);
  // The same rules in the reverse order must flip the verdict for gen/keep.ts.
  const reversed = matchSources(["!gen/keep.ts", "gen/*"]);
  assert.equal(reversed.isIgnored("gen/keep.ts"), true, "order is the contract");
});

test("a negation that is the file's LAST matching rule re-includes it (git: *.ts / !keep.ts)", () => {
  const m = matchSources(["*.ts", "!keep.ts"]);
  assert.equal(m.isIgnored("keep.ts"), false);
  assert.equal(m.isIgnored("x.ts"), true);
});

test("a negation that precedes the exclusion cannot outlive it (git's hard rule)", () => {
  const m = matchSources(["!keep.ts", "*.ts"]);
  assert.equal(m.isIgnored("keep.ts"), true, "the exclusion is last for the file");
  const m2 = matchSources(["!sub/**", "sub/**"]);
  assert.equal(m2.isIgnored("sub/keep.ts"), true, "same, for a whole directory");
});

test("foo/** keeps the directory's CONTENTS out, and a negation re-admits a named file (git)", () => {
  const m = matchSources(["build/**", "!build/keep.ts"]);
  assert.equal(m.isIgnored("build/other.ts"), true);
  assert.equal(m.isIgnored("build/keep.ts"), false, "negation of a file under a /** dir works");
});

test("a trailing-slash directory is excluded wholesale; nothing re-enters it (git)", () => {
  const m = matchSources(["build/", "!build/keep.ts"]);
  // Git: `build/` is ignored and git refuses to look inside, so `!build/keep.ts`
  // (which only matches files) cannot re-admit it.
  assert.equal(m.isIgnored("build"), true);
  assert.equal(m.isIgnored("build/keep.ts"), true);
  assert.equal(m.isIgnored("build/other.ts"), true);
});

test("Windows path separators are normalized before matching", () => {
  const m = match("out\n");
  assert.equal(m.isIgnored("out\\a.js"), true);
  assert.equal(m.isIgnored("src\\out\\a.js"), true);
});

test("resolveIgnoreSources: cursor < graftignore < explicit, missing files skipped", () => {
  const d = mkdtempSync(join(tmpdir(), "graft-ignore-src-"));
  try {
    writeFileSync(join(d, ".graftignore"), "g.log\n");
    writeFileSync(join(d, "extra.ignore"), "e.log\n");
    const cursorStamp = join(d, "graft", ".cache", "wiring-stamp.json");
    writeJsonAtomic(cursorStamp, { version: "x", hosts: ["cursor", "claude"], opts: {}, at: "now" });

    // No cursor stamp → only .graftignore; the explicit file is not read yet.
    writeJsonAtomic(cursorStamp, { version: "x", hosts: ["claude"], opts: {}, at: "now" });
    const noCursor = resolveIgnoreSources(d, ["extra.ignore"]);
    assert.deepEqual(noCursor.map((s) => s.name), [".graftignore", "extra.ignore"]);

    // Cursor wired → .cursorignore joins FIRST.
    writeJsonAtomic(cursorStamp, { version: "x", hosts: ["cursor"], opts: {}, at: "now" });
    writeFileSync(join(d, ".cursorignore"), "c.log\n");
    const withCursor = matcherFor(d, ["extra.ignore"]);
    assert.deepEqual(
      resolveIgnoreSources(d, ["extra.ignore"]).map((s) => s.name),
      [".cursorignore", ".graftignore", "extra.ignore"],
    );
    assert.equal(withCursor.isIgnored("c.log"), true);
    assert.equal(withCursor.isIgnored("g.log"), true);
    assert.equal(withCursor.isIgnored("e.log"), true);

    // The same .cursorignore is inert without the cursor wiring.
    writeJsonAtomic(cursorStamp, { version: "x", hosts: ["claude"], opts: {}, at: "now" });
    assert.equal(matcherFor(d).isIgnored("c.log"), false, "cursor file only with cursor wired");
  } finally {
    rmSync(d, { recursive: true, force: true });
    delete process.env[GRAFT_NO_GRAFTIGNORE];
  }
});

test("GRAFT_NO_GRAFTIGNORE=1 skips .graftignore (but not the cursor file or explicit ones)", () => {
  const d = mkdtempSync(join(tmpdir(), "graft-ignore-env-"));
  try {
    writeFileSync(join(d, ".graftignore"), "g.log\n");
    writeFileSync(join(d, "extra.ignore"), "e.log\n");
    process.env[GRAFT_NO_GRAFTIGNORE] = "1";
    const names = resolveIgnoreSources(d, ["extra.ignore"]).map((s) => s.name);
    assert.deepEqual(names, ["extra.ignore"]);
    assert.equal(matcherFor(d, ["extra.ignore"]).isIgnored("g.log"), false);
    assert.equal(matcherFor(d, ["extra.ignore"]).isIgnored("e.log"), true);
  } finally {
    rmSync(d, { recursive: true, force: true });
    delete process.env[GRAFT_NO_GRAFTIGNORE];
  }
});

test("an explicit --ignore-file path resolves against the repo root and is named by its rel path", () => {
  const d = mkdtempSync(join(tmpdir(), "graft-ignore-exp-"));
  try {
    mkdirSync(join(d, "tools"), { recursive: true });
    writeFileSync(join(d, "tools", "local.ignore"), "t.log\n");
    const names = resolveIgnoreSources(d, ["tools/local.ignore"]).map((s) => s.name);
    assert.deepEqual(names, ["tools/local.ignore"]);
    assert.equal(matcherFor(d, ["tools/local.ignore"]).isIgnored("t.log"), true);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});
