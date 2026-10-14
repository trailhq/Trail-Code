import { execFileSync } from "node:child_process";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep, isAbsolute } from "node:path";
import { shouldSkipDir, walkDir, SKIP_DIRS, NEVER_INCLUDE_DIRS } from "../src/ingest/fs.js";
import { discoverScopes, discoverWorkspaceChildren } from "../src/graph/scopes.js";

function fixture(tag: string): string {
  const dir = mkdtempSync(join(tmpdir(), `graft-walk-${tag}-`));
  execFileSync("git", ["init", "-q"], { cwd: dir });
  return dir;
}

function write(root: string, path: string, content = "export const value = 1;\n"): void {
  mkdirSync(join(root, path, ".."), { recursive: true });
  writeFileSync(join(root, path), content);
}

function runGit(root: string, args: string[]): void {
  execFileSync("git", args, { cwd: root, stdio: "ignore" });
}

function commitAll(root: string, message: string, forcePaths: string[] = []): void {
  runGit(root, ["add", "-A"]);
  if (forcePaths.length > 0) runGit(root, ["add", "-f", "--", ...forcePaths]);
  runGit(root, [
    "-c", "user.name=Graft Tests",
    "-c", "user.email=graft-tests@example.invalid",
    "commit", "-qm", message,
  ]);
}

function addLocalSubmodule(parent: string, source: string, path: string): void {
  runGit(parent, [
    "-c", "protocol.file.allow=always",
    "submodule", "add", "-q", source.replace(/\\/g, "/"), path,
  ]);
}

function walked(
  root: string,
  includes?: ReadonlySet<string>,
  followSubmodules = false,
): string[] {
  return walkDir(root, includes, { followSubmodules })
    .map((path) => relative(root, path).replace(/\\/g, "/"))
    .sort();
}

test("walkDir respects root and nested .gitignore rules, including negation", () => {
  const dir = fixture("ignore");
  try {
    write(dir, ".gitignore", "Scripts/bundles/\ngenerated/*\n!generated/keep.ts\n");
    write(dir, "src/app.ts");
    write(dir, "Scripts/bundles/app.js");
    write(dir, "generated/drop.ts");
    write(dir, "generated/keep.ts");
    write(dir, "packages/tool/.gitignore", "output/\n");
    write(dir, "packages/tool/index.ts");
    write(dir, "packages/tool/output/bundle.js");

    assert.deepEqual(walked(dir), [
      "generated/keep.ts",
      "packages/tool/index.ts",
      "src/app.ts",
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("walkDir keeps tracked files that match an ignore rule and untracked visible files", () => {
  const dir = fixture("tracked");
  try {
    write(dir, ".gitignore", "*.generated.ts\n");
    write(dir, "tracked.generated.ts");
    write(dir, "ignored.generated.ts");
    write(dir, "visible.ts");
    execFileSync("git", ["add", "-f", "tracked.generated.ts"], { cwd: dir });

    assert.deepEqual(walked(dir), ["tracked.generated.ts", "visible.ts"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("walkDir follows initialized submodules only when enabled, with their own Git visibility (#74)", () => {
  const parent = fixture("submodule-parent");
  const child = fixture("submodule-child");
  const nested = fixture("submodule-nested");
  try {
    write(nested, ".gitignore", "*.generated.ts\n");
    write(nested, "src/nested.ts");
    commitAll(nested, "nested fixture");

    write(child, ".gitignore", "*.generated.ts\n");
    write(child, "src/tracked.ts");
    write(child, "src/forced.generated.ts");
    write(child, "build/handwritten.ts");
    commitAll(child, "child fixture", ["src/forced.generated.ts"]);
    addLocalSubmodule(child, nested, "components/nested module");
    commitAll(child, "add nested submodule");

    write(parent, ".gitignore", "deps/child module/src/untracked.ts\n");
    write(parent, "src/root.ts");
    commitAll(parent, "parent fixture");
    addLocalSubmodule(parent, child, "deps/child module");
    addLocalSubmodule(parent, child, "vendor/skipped child");
    commitAll(parent, "add child submodules");
    runGit(parent, [
      "-c", "protocol.file.allow=always",
      "submodule", "update", "--init", "--recursive", "--", "deps/child module",
    ]);

    const childCheckout = join(parent, "deps", "child module");
    const nestedCheckout = join(childCheckout, "components", "nested module");
    write(childCheckout, "src/untracked.ts");
    write(childCheckout, "src/untracked.generated.ts");
    write(nestedCheckout, "src/nested-untracked.ts");
    write(nestedCheckout, "src/nested-untracked.generated.ts");

    assert.deepEqual(
      walked(parent),
      ["src/root.ts"],
      "the backwards-compatible default stops at superproject gitlinks",
    );

    assert.deepEqual(walked(parent, undefined, true), [
      "deps/child module/components/nested module/src/nested-untracked.ts",
      "deps/child module/components/nested module/src/nested.ts",
      "deps/child module/src/forced.generated.ts",
      "deps/child module/src/tracked.ts",
      "deps/child module/src/untracked.ts",
      "src/root.ts",
    ]);

    const withVendor = walked(parent, new Set(["vendor"]), true);
    assert.ok(withVendor.includes("vendor/skipped child/src/tracked.ts"), "an initialized gitlink is included when its mount's built-in skip is lifted");
    assert.ok(!withVendor.includes("vendor/skipped child/build/handwritten.ts"), "the child's own build/ directory remains skipped");
    assert.ok(!withVendor.some((path) => path.endsWith("untracked.generated.ts")), "--include-dir never overrides a child's Git ignore rules");

    const withVendorAndBuild = walked(parent, new Set(["vendor", "build"]), true);
    assert.ok(withVendorAndBuild.includes("vendor/skipped child/build/handwritten.ts"));

    const childGitFile = join(childCheckout, ".git");
    const childGitBackup = join(childCheckout, "git-pointer.backup");
    renameSync(childGitFile, childGitBackup);
    writeFileSync(childGitFile, "gitdir: missing-gitdir\n");
    assert.ok(
      walked(parent, undefined, true).includes("deps/child module/src/tracked.ts"),
      "a child Git failure falls back locally instead of producing a healthy but incomplete graph",
    );
    rmSync(childGitFile, { force: true });
    renameSync(childGitBackup, childGitFile);

    runGit(parent, ["submodule", "deinit", "-f", "--all"]);
    assert.deepEqual(
      walked(parent, undefined, true),
      ["src/root.ts"],
      "deinitialized gitlinks must not resolve upward and duplicate the parent",
    );
  } finally {
    rmSync(parent, { recursive: true, force: true });
    rmSync(child, { recursive: true, force: true });
    rmSync(nested, { recursive: true, force: true });
  }
});

test("walkDir retains fixed skips and filesystem fallback outside Git", () => {
  const dir = mkdtempSync(join(tmpdir(), "graft-walk-nongit-"));
  try {
    write(dir, "src/app.ts");
    write(dir, "node_modules/pkg/index.ts");
    write(dir, ".hidden/secret.ts");

    assert.deepEqual(walked(dir), ["src/app.ts"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * A5 — `shouldSkipDir` and its `--include-dir` override.
 *
 * "Is this name dot-prefixed or in SKIP_DIRS" is re-implemented by hand in
 * three places: `skippedPath`'s per-segment predicate and `walkFilesystem`'s
 * directory check (both src/ingest/fs.ts), and `discoverWorkspaceChildren`'s
 * git-child filter (src/graph/scopes.ts). This introduces `shouldSkipDir` as
 * the single source of truth, with an optional `includes` param: a name in it
 * is removed from the effective skip set for this repo's walks (persisted via
 * `graft build --include-dir`), including a named hidden directory such as
 * `.kb`. Names in NEVER_INCLUDE_DIRS (`.git`) stay skipped even when listed.
 *
 * `--include-dir` lifts only graft's OWN skip list. In a Git repo, Git's
 * ignore rules stay authoritative: an ignored directory remains excluded even
 * when named — un-ignore it (or `git add -f`) to index it, the same contract
 * the walker already applies to tracked-but-ignored files.
 */

test("shouldSkipDir: every SKIP_DIRS name and any dot-prefixed name is skipped; an ordinary name is not", () => {
  for (const name of SKIP_DIRS) assert.equal(shouldSkipDir(name), true, `${name} should be skipped`);
  assert.equal(shouldSkipDir(".git"), true);
  assert.equal(shouldSkipDir(".github"), true);
  assert.equal(shouldSkipDir(".vscode"), true);
  assert.equal(shouldSkipDir(".kb"), true);
  assert.equal(shouldSkipDir("."), true);
  assert.equal(shouldSkipDir("src"), false);
  assert.equal(shouldSkipDir("app"), false);
});

test("A5: shouldSkipDir(name, includes) removes a SKIP_DIRS name from the skip set, and a named hidden dir except .git", () => {
  const includes = new Set(["build", ".kb", ".git"]);
  assert.equal(shouldSkipDir("build", includes), false, "an included SKIP_DIRS name is no longer skipped");
  assert.equal(shouldSkipDir("vendor", includes), true, "a SKIP_DIRS name NOT in includes is still skipped");
  assert.equal(shouldSkipDir(".kb", includes), false, "a named hidden dir is walked once included");
  assert.equal(shouldSkipDir(".github", includes), true, ".github stays skipped unless it is the named include");
  assert.equal(shouldSkipDir(".git", includes), true, ".git is never overridable, even if explicitly included");
  for (const name of NEVER_INCLUDE_DIRS) {
    assert.equal(shouldSkipDir(name, new Set([name])), true, `${name} is never overridable`);
  }
  assert.equal(shouldSkipDir("src", includes), false);
});

test("A5: walkDir(dir, includes) descends into an included SKIP_DIRS-named directory (filesystem fallback)", () => {
  const dir = mkdtempSync(join(tmpdir(), "graft-walkdir-include-"));
  try {
    mkdirSync(join(dir, "build"), { recursive: true });
    writeFileSync(join(dir, "build", "real.ts"), "export const X = 1;\n");
    mkdirSync(join(dir, "vendor"), { recursive: true });
    writeFileSync(join(dir, "vendor", "other.ts"), "export const Y = 1;\n");

    const withoutIncludes = walkDir(dir).map((f) => f.slice(dir.length + 1));
    assert.ok(!withoutIncludes.some((f) => f.startsWith("build")), "default: build/ is skipped");

    const withIncludes = walkDir(dir, new Set(["build"])).map((f) => f.slice(dir.length + 1));
    assert.ok(withIncludes.some((f) => f.startsWith("build")), "build/ is walked once included");
    assert.ok(!withIncludes.some((f) => f.startsWith("vendor")), "vendor/ stays skipped — only the named dir is included");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("A5: walkDir(dir, includes) descends into a named hidden directory; .git stays skipped (filesystem fallback)", () => {
  const dir = mkdtempSync(join(tmpdir(), "graft-walkdir-hidden-"));
  try {
    mkdirSync(join(dir, ".kb"), { recursive: true });
    writeFileSync(join(dir, ".kb", "engine.ts"), "export const X = 1;\n");
    mkdirSync(join(dir, ".github"), { recursive: true });
    writeFileSync(join(dir, ".github", "ci.ts"), "export const Y = 1;\n");
    mkdirSync(join(dir, ".git"), { recursive: true });
    writeFileSync(join(dir, ".git", "HEAD"), "ref: refs/heads/main\n");
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "src", "app.ts"), "export const Z = 1;\n");

    const withoutIncludes = walkDir(dir).map((f) => f.slice(dir.length + 1));
    assert.ok(withoutIncludes.some((f) => f.endsWith("app.ts")), "src/ is walked");
    assert.ok(!withoutIncludes.some((f) => f.startsWith(".kb")), "default: .kb/ is skipped");
    assert.ok(!withoutIncludes.some((f) => f.startsWith(".github")), "default: .github/ is skipped");
    assert.ok(!withoutIncludes.some((f) => f.startsWith(".git")), "default: .git/ is skipped");

    const withIncludes = walkDir(dir, new Set([".kb", ".git"])).map((f) => f.slice(dir.length + 1));
    assert.ok(withIncludes.some((f) => f.startsWith(".kb")), ".kb/ is walked once included");
    assert.ok(!withIncludes.some((f) => f.startsWith(".github")), ".github/ stays skipped — only the named dir is included");
    assert.ok(!withIncludes.some((f) => f.startsWith(".git")), ".git stays skipped even when named in includes");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("A5: in a Git repo, --include-dir lifts the built-in skip for git-visible files", () => {
  const dir = fixture("include-git");
  try {
    write(dir, "src/app.ts");
    write(dir, "vendor/lib.ts"); // vendored dep committed to the repo — visible to git, skipped by the built-in list

    assert.ok(!walked(dir).includes("vendor/lib.ts"), "default: vendor/ is skipped by the built-in list");
    assert.deepEqual(walked(dir, new Set(["vendor"])), ["src/app.ts", "vendor/lib.ts"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("A5: --include-dir does not override gitignore — an ignored directory stays excluded even when named", () => {
  const dir = fixture("include-ignored");
  try {
    write(dir, ".gitignore", "build/\n");
    write(dir, "src/app.ts");
    write(dir, "build/gen.ts");

    assert.deepEqual(walked(dir, new Set(["build"])), ["src/app.ts"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("A5: in a Git repo, --include-dir .kb lifts the built-in skip for git-visible files", () => {
  const dir = fixture("include-hidden-git");
  try {
    write(dir, "src/app.ts");
    write(dir, ".kb/engine.ts");

    assert.ok(!walked(dir).includes(".kb/engine.ts"), "default: .kb/ is skipped by the built-in list");
    assert.deepEqual(walked(dir, new Set([".kb"])), [".kb/engine.ts", "src/app.ts"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("A5: --include-dir .kb does not override gitignore — an ignored hidden directory stays excluded even when named", () => {
  const dir = fixture("include-hidden-ignored");
  try {
    write(dir, ".gitignore", ".kb/\n");
    write(dir, "src/app.ts");
    write(dir, ".kb/engine.ts");

    assert.deepEqual(walked(dir, new Set([".kb"])), ["src/app.ts"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** One subdirectory per SKIP_DIRS name, plus a dot-directory and a normal
 * directory — each holding a package.json marker, a source file, and a
 * nested .git, so every check under test (file walk, marker-scope discovery,
 * workspace-glob resolution, git-child discovery) has something to find IF
 * it fails to skip. Deliberately not a git repo, so walkDir exercises the
 * filesystem fallback where the built-in skip list is the only guard. */
function buildSkipFixture(): string {
  const dir = mkdtempSync(join(tmpdir(), "graft-skipdirs-"));
  const seed = (relDir: string, sourceName: string) => {
    const sub = join(dir, relDir);
    mkdirSync(sub, { recursive: true });
    writeFileSync(join(sub, "package.json"), "{}");
    writeFileSync(join(sub, sourceName), "export const X = 1;\n");
    mkdirSync(join(sub, ".git"));
  };
  for (const name of SKIP_DIRS) seed(name, "junk.ts");
  seed(".hidden", "junk.ts");
  seed("app", "real.ts");
  return dir;
}

test("walkDir and every scopes.ts consumer agree on the skip set: SKIP_DIRS + a dot-dir are all skipped, a normal dir survives", () => {
  const dir = buildSkipFixture();
  try {
    // walkDir (fs.ts)
    const files = walkDir(dir);
    const rels = files.map((f) => f.slice(dir.length + 1));
    assert.ok(rels.includes(join("app", "real.ts")), "walkDir must still find the normal dir's file");
    for (const name of SKIP_DIRS) {
      assert.ok(!rels.some((r) => r.startsWith(`${name}${"/"}`) || r.startsWith(join(name, ""))), `walkDir must skip ${name}/`);
    }
    assert.ok(!rels.some((r) => r.startsWith(".hidden")), "walkDir must skip the dot-dir");

    // discoverScopes (scopes.ts) — its candidate dirs derive from the walked
    // file set, so a skipped dir's package.json must never surface as a scope.
    const scopes = discoverScopes(dir);
    const prefixes = scopes.map((s) => s.prefix);
    assert.ok(prefixes.includes("app"), "discoverScopes must still find the normal dir's marker");
    for (const name of SKIP_DIRS) assert.ok(!prefixes.includes(name), `discoverScopes must not surface ${name} as a scope`);
    assert.ok(!prefixes.includes(".hidden"), "discoverScopes must not surface the dot-dir as a scope");

    // discoverWorkspaceChildren (scopes.ts)
    const children = discoverWorkspaceChildren(dir);
    assert.ok(children.includes("app"), "discoverWorkspaceChildren must still find the normal git child");
    for (const name of SKIP_DIRS) assert.ok(!children.includes(name), `discoverWorkspaceChildren must skip ${name}`);
    assert.ok(!children.includes(".hidden"), "discoverWorkspaceChildren must skip the dot-dir");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("workspace-glob resolution (scopes.ts's resolveGlob over visible-file dirs) also honors the skip set", () => {
  const dir = buildSkipFixture();
  try {
    // A `packages: ['*']` intent resolves every immediate subdir as a workspace
    // match UNLESS it's absent from the visible-file dir set — if that set
    // stopped agreeing with shouldSkipDir, a SKIP_DIRS name or the dot-dir
    // would show up here as its own scope (workspace matches become candidates
    // even without a marker).
    writeFileSync(join(dir, "pnpm-workspace.yaml"), "packages:\n  - '*'\n");
    const scopes = discoverScopes(dir);
    const prefixes = scopes.map((s) => s.prefix);
    assert.ok(prefixes.includes("app"), "the normal dir must still resolve as a workspace match");
    for (const name of SKIP_DIRS) assert.ok(!prefixes.includes(name), `the glob must not resolve into ${name}`);
    assert.ok(!prefixes.includes(".hidden"), "the glob must not resolve into the dot-dir");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * #143 — the *input root* may be a directory symlink (nix-store -devel paths).
 * Follow that root once. Do not follow symlinks *inside* the tree: that is how
 * loops and outside-root escapes are prevented, and it keeps git-tracked
 * symlink files skipped via `lstat`.
 *
 * Windows: directory links are junctions so CI does not need Developer Mode.
 */
function symlinkDirectory(target: string, path: string): void {
  symlinkSync(target, path, process.platform === "win32" ? "junction" : "dir");
}

function underRoot(root: string, abs: string): boolean {
  const rel = relative(root, abs);
  return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

test("walkDir indexes a directory when the input root itself is a symlink (#143)", () => {
  const real = mkdtempSync(join(tmpdir(), "graft-walk-symlink-real-"));
  const wrap = mkdtempSync(join(tmpdir(), "graft-walk-symlink-wrap-"));
  const link = join(wrap, "root");
  try {
    write(real, "src/app.ts");
    write(real, "src/util.ts", "export const util = 2;\n");
    symlinkDirectory(real, link);

    const rels = walked(link);
    assert.deepEqual(rels, ["src/app.ts", "src/util.ts"]);
    assert.ok(rels.every((r) => !r.startsWith("..")), "relative paths must stay inside the requested root");
    for (const abs of walkDir(link)) {
      assert.ok(underRoot(resolve(link), abs), "emitted paths stay on the caller-facing root, not a leaked realpath");
    }
  } finally {
    rmSync(wrap, { recursive: true, force: true });
    rmSync(real, { recursive: true, force: true });
  }
});

test("walkDir indexes a Git repo when the input root is a symlink to that repo (#143)", () => {
  const real = fixture("symlink-git-real");
  const wrap = mkdtempSync(join(tmpdir(), "graft-walk-symlink-gitwrap-"));
  const link = join(wrap, "root");
  try {
    write(real, "src/app.ts");
    symlinkDirectory(real, link);
    assert.deepEqual(walked(link), ["src/app.ts"]);
  } finally {
    rmSync(wrap, { recursive: true, force: true });
    rmSync(real, { recursive: true, force: true });
  }
});

test("walkDir reports a broken symlink root instead of a generic scandir ENOENT (#143)", (t) => {
  const wrap = mkdtempSync(join(tmpdir(), "graft-walk-broken-link-"));
  const link = join(wrap, "root");
  try {
    try {
      symlinkSync(join(wrap, "missing-target"), link, process.platform === "win32" ? "junction" : "dir");
    } catch (err) {
      t.skip(`cannot create a dangling directory link (${err instanceof Error ? err.message : err})`);
      return;
    }
    assert.throws(() => walkDir(link), (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /broken symbolic link/i);
      assert.doesNotMatch(err.message, /scandir/i);
      return true;
    });
  } finally {
    rmSync(wrap, { recursive: true, force: true });
  }
});

test("walkDir does not follow an internal file or directory symlink (#143)", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "graft-walk-internal-link-"));
  const outside = mkdtempSync(join(tmpdir(), "graft-walk-outside-"));
  try {
    write(dir, "src/app.ts");
    write(dir, "src/real.ts", "export const real = 1;\n");
    write(outside, "leaked.ts", "export const leaked = 1;\n");
    let fileLink = false;
    try {
      symlinkSync(join(dir, "src", "real.ts"), join(dir, "src", "alias.ts"));
      fileLink = true;
    } catch (err) {
      t.diagnostic(`skipping internal file-symlink assertion: ${err instanceof Error ? err.message : err}`);
    }
    symlinkDirectory(outside, join(dir, "escape"));

    const rels = walked(dir);
    assert.deepEqual(rels, ["src/app.ts", "src/real.ts"]);
    if (fileLink) assert.ok(!rels.includes("src/alias.ts"), "an internal file symlink is not a source file");
    assert.ok(!rels.some((r) => r.includes("leaked.ts")), "a directory symlink must not escape the root");
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("walkDir does not recurse forever through an internal symlink to the root (#143)", { timeout: 5_000 }, () => {
  const dir = mkdtempSync(join(tmpdir(), "graft-walk-loop-"));
  try {
    write(dir, "src/app.ts");
    symlinkDirectory(dir, join(dir, "src", "loop"));
    assert.deepEqual(walked(dir), ["src/app.ts"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("walkDir on an ordinary directory is unchanged when siblings are symlink fixtures (#143)", () => {
  const dir = mkdtempSync(join(tmpdir(), "graft-walk-ordinary-"));
  try {
    write(dir, "src/app.ts");
    write(dir, "node_modules/pkg/index.ts");
    assert.deepEqual(walked(dir), ["src/app.ts"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
