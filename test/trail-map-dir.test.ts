/**
 * Where the code map lives: `graft/` as before, `.trail/cache/` in a repo on
 * trail, kept out of git by `.trail/.gitignore` so the repo's own ignore files
 * are never touched. A map already in `graft/` moves the first time it's asked for.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { tmpRepo } from "./helpers.js";
import { mapDirFor } from "../src/context/map-dir.js";
import { contextDirFor, ensureGitignored, ensureSearchable } from "../src/context/node-file.js";
import { underGraft } from "../src/claude/hooks.js";

const git = (cwd: string, ...args: string[]) =>
  spawnSync("git", ["-c", "commit.gpgsign=false", "-c", "user.name=T", "-c", "user.email=t@t.test", ...args], { cwd, encoding: "utf8" });

/** A git repo, wired for trail when `trail` is set (its committed hook is what says so). */
function repo(tag: string, trail: boolean): string {
  const d = tmpRepo(tag);
  git(d, "init", "-q");
  if (trail) {
    mkdirSync(join(d, ".trail"), { recursive: true });
    writeFileSync(join(d, ".trail", "hook.cjs"), "// hook\n");
  }
  return d;
}

/** An old map in `graft/`: an index, a card and the cache beside them. */
function oldMap(d: string): void {
  mkdirSync(join(d, "graft", ".cache"), { recursive: true });
  writeFileSync(join(d, "graft", "INDEX.md"), "# map\n");
  writeFileSync(join(d, "graft", "node.md"), "card\n");
  writeFileSync(join(d, "graft", ".cache", "wiring-stamp.json"), "{}");
}

test("the map is in graft/ for a repo not on trail, and in .trail/cache/ for one that is", () => {
  const plain = repo("map-plain", false);
  assert.equal(mapDirFor(plain), join(plain, "graft"));
  assert.equal(contextDirFor(plain), join(plain, "graft"));
  assert.equal(contextDirFor(plain, "/elsewhere"), "/elsewhere", "an explicit --dir wins");

  const onTrail = repo("map-trail", true);
  assert.equal(mapDirFor(onTrail), join(onTrail, ".trail", "cache"));
});

test("a map already in graft/ moves into .trail/cache/ once the repo is on trail, cache and all", () => {
  const d = repo("map-move", true);
  oldMap(d);
  const dir = mapDirFor(d);
  assert.equal(dir, join(d, ".trail", "cache"));
  assert.equal(existsSync(join(d, "graft")), false);
  assert.equal(readFileSync(join(dir, "node.md"), "utf8"), "card\n");
  assert.ok(existsSync(join(dir, ".cache", "wiring-stamp.json")), "the stamp and caches come along, so nothing is redone");
  assert.match(readFileSync(join(d, ".trail", ".gitignore"), "utf8"), /^cache\/$/m);
  assert.equal(git(d, "status", "--porcelain", "--untracked-files=all", "--", ".trail/cache").stdout, "", "git doesn't see it");
  assert.equal(mapDirFor(d), dir, "asked again: same place, nothing to move");
});

test("a graft/ map that git tracks stays where it is", () => {
  const d = repo("map-tracked", true);
  oldMap(d);
  git(d, "add", "graft/INDEX.md");
  git(d, "commit", "-qm", "map committed back when it was shared");
  mapDirFor(d);
  assert.ok(existsSync(join(d, "graft", "INDEX.md")), "committed files aren't deleted by a move");
});

test("building the trail map writes .trail/.gitignore, never the repo's .gitignore or a root .ignore", () => {
  const d = repo("map-ignore", true);
  writeFileSync(join(d, ".gitignore"), "node_modules/\n");
  const dir = mapDirFor(d);
  ensureGitignored(d, dir);
  ensureSearchable(d, dir);
  assert.equal(readFileSync(join(d, ".gitignore"), "utf8"), "node_modules/\n");
  assert.equal(existsSync(join(d, ".ignore")), false);
  assert.match(readFileSync(join(d, ".trail", ".gitignore"), "utf8"), /^cache\/$/m);

  const plain = repo("map-ignore-plain", false);
  ensureGitignored(plain, mapDirFor(plain));
  assert.match(readFileSync(join(plain, ".gitignore"), "utf8"), /^\/graft\/$/m, "graft's map is ignored as before");
});

test("an edit inside the map is the map's own, not the code's", () => {
  assert.equal(underGraft("/r", "/r/.trail/cache/node.md"), true);
  assert.equal(underGraft("/r", "/r/graft/node.md"), true);
  assert.equal(underGraft("/r", "/r/.trail/learnings/x.md"), false);
});

test("a repo with .trail/learnings/ is on trail for the map, even before its hook is written", () => {
  const d = repo("map-learnings", false);
  mkdirSync(join(d, ".trail", "learnings"), { recursive: true });
  assert.equal(mapDirFor(d), join(d, ".trail", "cache"));
});
