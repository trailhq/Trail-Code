/**
 * Configurable file filters: `GRAFT_MAX_FILE_BYTES`, `.graftignore` (plus the
 * user-wide `~/.graft/ignore` and the clone-local `info/graftignore`), and the
 * opt-in `GRAFT_SKIP_MINIFIED` bundle skip.
 *
 * Each is read at walk time, so the build, the fingerprint probe and the
 * hooks/MCP refresh path — none of which see a CLI flag — must agree on the
 * resulting file set. The end-to-end tests below check exactly that: a build
 * followed by a probe reports clean, never a perpetual drift loop.
 */
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { walkDir } from "../src/ingest/fs.js";
import {
  DEFAULT_MAX_FILE_BYTES,
  MINIFIED_MIN_BYTES,
  MINIFIED_MIN_LINE_CHARS,
  IgnoreMatcher,
  findGitDirs,
  isMinifiedJs,
  longestLine,
  maxFileBytes,
  parseIgnore,
} from "../src/ingest/filters.js";
import { readGraph, wiringPath } from "../src/graph/write.js";
import { probeDrift, isClean } from "../src/graph/fingerprint.js";

function gitRepo(tag: string): string {
  const dir = mkdtempSync(join(tmpdir(), `graft-filters-${tag}-`));
  execFileSync("git", ["init", "-q"], { cwd: dir });
  return dir;
}

function plainDir(tag: string): string {
  return mkdtempSync(join(tmpdir(), `graft-filters-${tag}-`));
}

function write(root: string, path: string, content = "export const value = 1;\n"): void {
  mkdirSync(join(root, path, ".."), { recursive: true });
  writeFileSync(join(root, path), content);
}

function git(root: string, args: string[]): void {
  execFileSync("git", args, { cwd: root, stdio: "ignore" });
}

function commitAll(root: string): void {
  git(root, ["add", "-A"]);
  git(root, [
    "-c", "user.name=Graft Tests",
    "-c", "user.email=graft-tests@example.invalid",
    "commit", "-qm", "fixture",
  ]);
}

function walked(root: string): string[] {
  return walkDir(root).map((p) => relative(root, p).replace(/\\/g, "/")).sort();
}

/** Run `fn` with `vars` applied to process.env, restoring the old values after. */
function withEnv<T>(vars: Record<string, string | undefined>, fn: () => T): T {
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

/** An isolated HOME, so a developer's real `~/.graft/ignore` never leaks in. */
function withHome<T>(home: string, fn: () => T): T {
  return withEnv({ HOME: home, USERPROFILE: home }, fn);
}

function runCli(args: string[], env: Record<string, string> = {}): void {
  execFileSync(process.execPath, ["--import", "tsx", "src/cli.ts", ...args], {
    stdio: "pipe",
    env: { ...process.env, ...env },
  });
}

const bigLine = (n: number): string => `var a=${"1+".repeat(Math.ceil(n / 2))}1;\n`;

// ---------------------------------------------------------------------------
// GRAFT_MAX_FILE_BYTES
// ---------------------------------------------------------------------------

test("maxFileBytes: default, a valid override, and invalid values falling back to the default", () => {
  assert.equal(DEFAULT_MAX_FILE_BYTES, 1_000_000);
  assert.equal(maxFileBytes({}), DEFAULT_MAX_FILE_BYTES);
  assert.equal(maxFileBytes({ GRAFT_MAX_FILE_BYTES: "" }), DEFAULT_MAX_FILE_BYTES);
  assert.equal(maxFileBytes({ GRAFT_MAX_FILE_BYTES: "2000000" }), 2_000_000);
  assert.equal(maxFileBytes({ GRAFT_MAX_FILE_BYTES: " 1500 " }), 1500);
  for (const bad of ["0", "-5", "1.5", "abc", "2e6", "1_000", "99999999999999999999"]) {
    assert.equal(maxFileBytes({ GRAFT_MAX_FILE_BYTES: bad }), DEFAULT_MAX_FILE_BYTES, bad);
  }
});

test("GRAFT_MAX_FILE_BYTES raises (and lowers) the cap for Git and non-Git walks", () => {
  const home = plainDir("home");
  for (const make of [gitRepo, plainDir]) {
    const dir = make("maxbytes");
    try {
      write(dir, "small.php", "<?php function a() {}\n");
      write(dir, "large.php", `<?php\n${"// padding line\n".repeat(80_000)}`); // ~1.28 MB
      withHome(home, () => {
        withEnv({ GRAFT_MAX_FILE_BYTES: undefined }, () =>
          assert.deepEqual(walked(dir), ["small.php"], "a file over 1 MB is skipped by default"),
        );
        withEnv({ GRAFT_MAX_FILE_BYTES: "2000000" }, () =>
          assert.deepEqual(walked(dir), ["large.php", "small.php"]),
        );
        withEnv({ GRAFT_MAX_FILE_BYTES: "10" }, () => assert.deepEqual(walked(dir), []));
        withEnv({ GRAFT_MAX_FILE_BYTES: "not-a-number" }, () =>
          assert.deepEqual(walked(dir), ["small.php"], "an invalid value keeps the default"),
        );
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  rmSync(home, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// .graftignore pattern semantics
// ---------------------------------------------------------------------------

function matcher(text: string): IgnoreMatcher {
  return new IgnoreMatcher("/repo", parseIgnore(text));
}

test("ignore patterns: unanchored, anchored, **, dir-only, negation, comments, classes", () => {
  const m = matcher(
    [
      "# a comment",
      "",
      "*.min.js",
      "/root-only.ts",
      "docs/*.md",
      "**/webdriver/extensions/**",
      "cache/",
      "generated/**",
      "!generated/keep.ts",
      "file[0-9].ts",
      "\\#literal.ts",
    ].join("\n"),
  );
  const yes = [
    "a.min.js",
    "deep/nested/b.min.js",
    "root-only.ts",
    "docs/readme.md",
    "app/webdriver/extensions/cap/bundle.js",
    "webdriver/extensions/x.js",
    "src/cache/blob.ts",
    "generated/drop.ts",
    "file7.ts",
    "#literal.ts",
  ];
  const no = [
    "a.js",
    "sub/root-only.ts",
    "docs/deep/readme.md",
    "app/webdriver/other.js",
    "cache.ts",
    "fileA.ts",
  ];
  for (const p of yes) assert.equal(m.ignoresRel(p), true, `expected ${p} ignored`);
  for (const p of no) assert.equal(m.ignoresRel(p), false, `expected ${p} kept`);
  // `generated/**` matches the files, not the directory, so a later `!` can
  // re-include one of them — exactly as in Git.
  assert.equal(m.ignoresRel("generated/keep.ts"), false);
});

test("ignore patterns: pathological globs finish in bounded time (no ReDoS)", () => {
  const patterns = [
    "**/**/**/**/a*a*a*a*b",
    "a*a*a*a*a*a*a*a*a*a*a*a*b",
    "**/a/**/a/**/a/**/a/**/b",
    "*?*?*?*?*?*?*?*?*?*?*b",
    `${"*".repeat(500)}b`,
    `x${" ".repeat(20_000)}y`,
  ];
  const m = matcher(patterns.join("\n"));
  const longSegment = "a".repeat(10_000);
  // Far deeper than any real checkout. (A regex translation of these patterns
  // does not finish on these inputs at all; the bound is generous so a loaded
  // CI machine running the suite in parallel stays well under it.)
  const deepPath = Array.from({ length: 200 }, () => "a").join("/");
  const started = performance.now();
  assert.equal(m.ignoresRel(longSegment), false);
  assert.equal(m.ignoresRel(`dir/${longSegment}`), false);
  assert.equal(m.ignoresRel(deepPath), false);
  const elapsed = performance.now() - started;
  assert.ok(elapsed < 50, `matching took ${elapsed.toFixed(1)}ms`);
  // ...and the patterns still mean what they say.
  assert.equal(m.ignoresRel(`x/y/${"a".repeat(8)}b`), true);
  assert.equal(m.ignoresRel("p/a/q/a/r/a/s/a/t/b"), true);
});

test("ignore patterns: trailing /** matches inside a directory but not the directory itself", () => {
  const m = matcher("assets/**\n");
  assert.equal(m.ignoresRel("assets", true), false);
  assert.equal(m.ignoresRel("assets/a.js"), true);
  assert.equal(m.ignoresRel("assets/deep/a.js"), true);
});

test("ignore patterns: a file cannot be re-included when its parent directory is excluded", () => {
  const m = matcher("build-out/\n!build-out/keep.ts\n");
  assert.equal(m.ignoresRel("build-out/keep.ts"), true);
  assert.equal(m.ignoresRel("build-out/drop.ts"), true);
});

test("ignore patterns: last matching rule wins", () => {
  const m = matcher("*.ts\n!*.ts\n*.gen.ts\n");
  assert.equal(m.ignoresRel("a.ts"), false);
  assert.equal(m.ignoresRel("a.gen.ts"), true);
});

test("IgnoreMatcher.ignores: paths outside the base are never excluded", () => {
  const m = matcher("*\n");
  assert.equal(m.ignores("/elsewhere/a.ts"), false);
  assert.equal(m.ignores("/repo/a.ts"), true);
});

// ---------------------------------------------------------------------------
// .graftignore, info/graftignore and ~/.graft/ignore in real walks
// ---------------------------------------------------------------------------

test(".graftignore excludes TRACKED files (which .gitignore cannot), in a Git repo", () => {
  const dir = gitRepo("tracked");
  const home = plainDir("home");
  try {
    write(dir, "src/app.ts");
    write(dir, "public/js/vendor.min.js", "var x=1;\n");
    write(dir, "public/emissor/app.js");
    write(dir, "public/keep.js");
    commitAll(dir);
    write(dir, "untracked.min.js", "var y=2;\n");
    write(dir, ".graftignore", "*.min.js\npublic/emissor/\n");

    withHome(home, () => assert.deepEqual(walked(dir), ["public/keep.js", "src/app.ts"]));
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test(".graftignore applies to the filesystem walk outside Git, pruning excluded directories", () => {
  const dir = plainDir("nogit");
  const home = plainDir("home");
  try {
    write(dir, "src/app.ts");
    write(dir, "src/lib.min.js", "var x=1;\n");
    write(dir, "assets/extensions/bundle.js");
    write(dir, ".graftignore", "*.min.js\nassets/extensions/\n");
    withHome(home, () => assert.deepEqual(walked(dir), ["src/app.ts"]));
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("info/graftignore lives in the Git common dir and is shared by every linked worktree", () => {
  const dir = gitRepo("info");
  const home = plainDir("home");
  const wt = join(plainDir("wt-parent"), "wt");
  try {
    write(dir, "src/app.ts");
    write(dir, "src/bundle.min.js", "var x=1;\n");
    commitAll(dir);
    git(dir, ["worktree", "add", "-q", wt]);
    write(join(dir, ".git"), "info/graftignore", "*.min.js\n");

    const dirs = findGitDirs(wt);
    assert.ok(dirs, "the linked worktree resolves to a repository");
    assert.equal(realpathSync(dirs!.commonDir), realpathSync(join(dir, ".git")), "commondir points at the main .git");

    withHome(home, () => {
      assert.deepEqual(walked(dir), ["src/app.ts"]);
      assert.deepEqual(walked(wt), ["src/app.ts"]);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(join(wt, ".."), { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("~/.graft/ignore applies to every repo, and the repo's .graftignore overrides it", () => {
  const dir = gitRepo("global");
  const home = plainDir("home");
  try {
    write(dir, "src/app.ts");
    write(dir, "src/a.min.js", "var x=1;\n");
    write(dir, "src/b.min.js", "var x=1;\n");
    write(home, ".graft/ignore", "*.min.js\n");
    withHome(home, () => assert.deepEqual(walked(dir), ["src/app.ts"]));

    write(dir, ".graftignore", "!src/b.min.js\n");
    withHome(home, () => assert.deepEqual(walked(dir), ["src/app.ts", "src/b.min.js"]));
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test(".graftignore applies inside followed submodules, against superproject paths", () => {
  const child = gitRepo("child");
  const parent = gitRepo("parent");
  const home = plainDir("home");
  try {
    write(child, "lib.ts");
    write(child, "dist-bundle.min.js", "var x=1;\n");
    commitAll(child);
    write(parent, "main.ts");
    git(parent, [
      "-c", "protocol.file.allow=always",
      "submodule", "add", "-q", child.replace(/\\/g, "/"), "deps/child",
    ]);
    commitAll(parent);
    write(parent, ".graftignore", "deps/child/*.min.js\n");

    withHome(home, () => {
      const files = walkDir(parent, undefined, { followSubmodules: true })
        .map((p) => relative(parent, p).replace(/\\/g, "/"))
        .sort();
      assert.deepEqual(files, ["deps/child/lib.ts", "main.ts"]);
    });
  } finally {
    rmSync(child, { recursive: true, force: true });
    rmSync(parent, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// GRAFT_SKIP_MINIFIED
// ---------------------------------------------------------------------------

test("longestLine and isMinifiedJs thresholds", () => {
  assert.equal(longestLine(""), 0);
  assert.equal(longestLine("ab\nabcd\nc"), 4);
  assert.equal(longestLine("abc"), 3);
  assert.ok(MINIFIED_MIN_BYTES === 100_000 && MINIFIED_MIN_LINE_CHARS === 20_000);

  const dir = plainDir("minified-unit");
  try {
    write(dir, "one-line.js", bigLine(MINIFIED_MIN_BYTES + 10));
    const st = { size: MINIFIED_MIN_BYTES + 20, mtimeMs: 1 };
    assert.equal(isMinifiedJs(join(dir, "one-line.js"), st), true);
    assert.equal(isMinifiedJs(join(dir, "one-line.js"), { size: MINIFIED_MIN_BYTES - 1, mtimeMs: 1 }), false, "below the size floor");
    write(dir, "one-line.ts", bigLine(MINIFIED_MIN_BYTES + 10));
    assert.equal(isMinifiedJs(join(dir, "one-line.ts"), st), false, "only .js/.mjs/.cjs are inspected");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("GRAFT_SKIP_MINIFIED=1 skips large single-line JS bundles and keeps everything else", () => {
  const dir = gitRepo("minified");
  const home = plainDir("home");
  try {
    write(dir, "bundle.js", bigLine(150_000)); // big + one long line → skipped
    write(dir, "bundle.cjs", bigLine(150_000));
    write(dir, "bundle.mjs", bigLine(150_000));
    write(dir, "handwritten.js", "function f() { return 1; }\n".repeat(6_000)); // big, short lines
    write(dir, "tiny.min.js", bigLine(25_000)); // long line but under the size floor
    write(dir, "types.ts", `export const s = "${"x".repeat(150_000)}";\n`); // not JS
    commitAll(dir);

    withHome(home, () => {
      withEnv({ GRAFT_SKIP_MINIFIED: undefined }, () =>
        assert.deepEqual(walked(dir), [
          "bundle.cjs", "bundle.js", "bundle.mjs", "handwritten.js", "tiny.min.js", "types.ts",
        ]),
      );
      withEnv({ GRAFT_SKIP_MINIFIED: "1" }, () =>
        assert.deepEqual(walked(dir), ["handwritten.js", "tiny.min.js", "types.ts"]),
      );
      withEnv({ GRAFT_SKIP_MINIFIED: "0" }, () => assert.equal(walked(dir).length, 6));
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// End to end: build, then the probe the hooks/MCP refresh path uses
// ---------------------------------------------------------------------------

test("a build honors all three filters and the freshness probe agrees (no drift loop)", () => {
  const dir = gitRepo("e2e");
  const home = plainDir("home");
  const env = {
    HOME: home,
    USERPROFILE: home,
    GRAFT_MAX_FILE_BYTES: "2000000",
    GRAFT_SKIP_MINIFIED: "1",
  };
  try {
    write(dir, "main.ts", "export function main(): number {\n  return 1;\n}\n");
    write(dir, "big.ts", `export function big(): number {\n  return 2;\n}\n${"// pad\n".repeat(180_000)}`);
    write(dir, "bundle.js", `function bundled(){return 3}${bigLine(150_000)}`);
    write(dir, "thirdparty/ignored.ts", "export function ignoredFn(): number {\n  return 4;\n}\n");
    write(dir, "lib/skip.ts", "export function skipped(): number {\n  return 5;\n}\n");
    commitAll(dir);
    write(dir, ".graftignore", "thirdparty/\n");

    runCli(["build", dir], env);
    const graph = readGraph(wiringPath(join(dir, "graft")));
    assert.ok(graph, "expected a built graph");
    const paths = new Set(graph!.nodes.map((n) => n.path));
    assert.ok(paths.has("main.ts"));
    assert.ok(paths.has("big.ts"), "GRAFT_MAX_FILE_BYTES lets the 1.26 MB file in");
    assert.ok(paths.has("lib/skip.ts"));
    assert.ok(!paths.has("bundle.js"), "GRAFT_SKIP_MINIFIED drops the bundle");
    assert.ok(![...paths].some((p) => p.startsWith("thirdparty/")), ".graftignore drops the tracked dir");

    withEnv(env, () => {
      const drift = probeDrift(dir, join(dir, "graft"));
      assert.ok(drift && isClean(drift), `probe must be clean, got ${JSON.stringify(drift)}`);
    });

    // Editing the ignore file is picked up by the next probe — which is what
    // makes the pre-query refresh and the MCP server rebuild without a flag.
    write(dir, ".graftignore", "thirdparty/\nlib/\n");
    withEnv(env, () => {
      const drift = probeDrift(dir, join(dir, "graft"));
      assert.deepEqual(drift?.removed, ["lib/skip.ts"]);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});
