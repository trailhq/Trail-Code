/**
 * Which repo a folder belongs to, for notes kept in ~/.trail/repos/<key>/:
 * one key per repo however it's checked out (clones, worktrees, subfolders),
 * its own key for a repo inside another (submodules, nested repos), a key
 * that survives a renamed remote, and a folder of repos that reads them all.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  childCheckouts,
  ensureRepoHome,
  findRepoPlace,
  keepsNotes,
  keyFromRemote,
  noteCount,
  notePlaces,
  remoteUrl,
  repoPlace,
  shownPath,
} from "../src/notes/home.js";
import { listNotes, noteTargets, writeNote } from "../src/notes/notes.js";
import { tmpRepo } from "./helpers.js";

/** A fresh ~/.trail per test, so keys and aliases never leak between them. */
function home(): NodeJS.ProcessEnv {
  const env = { ...process.env, TRAIL_HOME: mkdtempSync(join(tmpdir(), "trail-home-")) };
  process.env.TRAIL_HOME = env.TRAIL_HOME;
  return env;
}

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync("git", ["-c", "commit.gpgsign=false", "-c", "init.defaultBranch=main", ...args], { cwd, encoding: "utf8" });
  assert.equal(r.status, 0, `git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

/** A repo with one commit, and `origin` when given. */
function repo(tag: string, origin?: string, files: Record<string, string> = { "main.go": "package main\n" }): string {
  const d = tmpRepo(tag);
  for (const [f, text] of Object.entries(files)) {
    mkdirSync(join(d, f, ".."), { recursive: true });
    writeFileSync(join(d, f), text);
  }
  git(d, "init", "-q");
  git(d, "config", "user.name", "Priya Raman");
  git(d, "config", "user.email", "p@example.com");
  git(d, "add", "-A");
  git(d, "commit", "-qm", "init");
  if (origin) git(d, "remote", "add", "origin", origin);
  return d;
}

const BODY = "## Decided\nRotate each box by its page's /Rotate.";

// --- a remote, as a key ---

test("a remote becomes host/owner/name, however it's spelled", () => {
  for (const url of [
    "git@github.com:NanoNets/Graft.git",
    "https://github.com/NanoNets/Graft",
    "https://github.com/nanonets/graft.git/",
    "https://x-access-token:ghs_abc@github.com/NanoNets/Graft.git",
    "ssh://git@github.com:22/NanoNets/Graft.git",
  ])
    assert.equal(keyFromRemote(url), "github.com/nanonets/graft", url);
  assert.equal(keyFromRemote("git@gitlab.com:acme/platform/extract.git"), "gitlab.com/acme/platform/extract", "subgroups stay");
  assert.equal(keyFromRemote("https://github.com/acme/../../etc"), "github.com/acme/etc", "never climbs out of ~/.trail");
});

test("a remote that's a path on this machine isn't a key: those repos go by path", () => {
  for (const url of ["/srv/git/extract.git", "../extract", "file:///srv/git/extract.git", "C:\\repos\\extract"]) assert.equal(keyFromRemote(url), null, url);
});

test("origin wins; a repo with other remotes uses the first; none, none", () => {
  const cfg = '[core]\n\tbare = false\n[remote "upstream"]\n\turl = git@github.com:acme/up.git\n[remote "origin"]\n\turl = git@github.com:priya/fork.git\n';
  assert.equal(remoteUrl(cfg), "git@github.com:priya/fork.git");
  assert.equal(remoteUrl('[remote "upstream"]\n  url = git@github.com:acme/up.git\n'), "git@github.com:acme/up.git");
  assert.equal(remoteUrl("[core]\n\tbare = false\n"), null);
});

// --- one repo, however it's checked out ---

test("two clones, a subfolder and a worktree of one repo share one folder", () => {
  const env = home();
  const a = repo("clone-a", "git@github.com:acme/extract.git", { "internal/ocr/bbox.go": "package ocr\n" });
  const b = repo("clone-b", "https://github.com/acme/extract.git");
  const wt = join(tmpRepo("wt-parent"), "extract-wt");
  git(a, "worktree", "add", "-q", "-b", "fix/bbox", wt);

  const want = join(env.TRAIL_HOME!, "repos", "github.com", "acme", "extract");
  for (const dir of [a, b, join(a, "internal", "ocr"), wt]) assert.equal(repoPlace(dir).dir, want, dir);
  assert.equal(repoPlace(join(a, "internal")).checkout, a, "the checkout is the top of the repo");
  assert.equal(repoPlace(wt).checkout, wt, "a worktree reads touches against its own top");
});

test("a worktree of a repo with no remote shares its main checkout's folder", () => {
  home();
  const main = repo("local-main");
  const wt = join(tmpRepo("wt-local"), "wt");
  git(main, "worktree", "add", "-q", "-b", "side", wt);
  assert.match(repoPlace(main).key, /^local\//);
  assert.equal(repoPlace(wt).key, repoPlace(main).key);
});

test("a repo inside another is its own repo: a nested clone, and a submodule's .git file", () => {
  home();
  const outer = repo("outer", "git@github.com:acme/app.git");
  // A clone sitting inside another repo's tree.
  const nested = join(outer, "vendor", "ocr-lib");
  mkdirSync(nested, { recursive: true });
  git(nested, "init", "-q");
  git(nested, "remote", "add", "origin", "git@github.com:acme/ocr-lib.git");
  assert.equal(repoPlace(join(nested)).key, "github.com/acme/ocr-lib");
  // A submodule: `.git` is a file pointing into the superproject's .git/modules.
  const mod = join(outer, "libs", "pdf");
  mkdirSync(mod, { recursive: true });
  const modGit = join(outer, ".git", "modules", "libs", "pdf");
  mkdirSync(modGit, { recursive: true });
  writeFileSync(join(modGit, "config"), '[remote "origin"]\n\turl = https://github.com/acme/pdf.git\n');
  writeFileSync(join(mod, ".git"), "gitdir: ../../.git/modules/libs/pdf\n");
  assert.equal(repoPlace(mod).key, "github.com/acme/pdf");
  assert.equal(repoPlace(join(outer, "libs")).key, "github.com/acme/app", "the folder around it is still the outer repo");
});

test("a folder outside git is keyed by its path", () => {
  home();
  const d = tmpRepo("plain");
  const p = repoPlace(d);
  assert.equal(p.git, false);
  assert.match(p.key, /^local\/[a-z0-9._-]+$/);
  assert.equal(p.checkout, d);
});

// --- a key that changes ---

test("a renamed remote finds its notes again, through the repo's first commit", () => {
  home();
  const d = repo("renamed", "git@github.com:nanonets/graft.git");
  writeNote(d, { title: "Bbox rotation", body: BODY, author: "Priya", date: "2026-10-07" }, "personal");
  git(d, "remote", "set-url", "origin", "git@github.com:trailhq/trail.git");
  assert.equal(repoPlace(d).key, "github.com/trailhq/trail", "reads alone don't run git");
  assert.equal(findRepoPlace(d).key, "github.com/nanonets/graft", "ask's lookup follows the first commit");
  assert.equal(repoPlace(d).key, "github.com/nanonets/graft", "and remembers it for everything after");
  assert.equal(listNotes(d).length, 1);

  // A fresh clone under the new name, somewhere else, lands on the same notes.
  const clone = tmpRepo("renamed-clone");
  git(clone, "clone", "-q", d, "trail");
  git(join(clone, "trail"), "remote", "set-url", "origin", "https://github.com/trailhq/trail");
  assert.equal(listNotes(join(clone, "trail")).length, 1);
});

test("notes from before a repo had a remote carry over once it gets one", () => {
  home();
  const d = repo("no-remote-yet");
  writeNote(d, { title: "First note", body: BODY, author: "Priya", date: "2026-10-07" }, "personal");
  git(d, "remote", "add", "origin", "git@github.com:acme/extract.git");
  assert.equal(ensureRepoHome(d).place.key, repoPlace(d).key);
  assert.match(repoPlace(d).key, /^local\//, "the new key points at the old folder");
  assert.equal(listNotes(d).length, 1);
});

test("a different repo never inherits notes: no shared first commit, no alias", () => {
  const env = home();
  const a = repo("first-a", "git@github.com:acme/a.git", { "a.go": "package a\n" });
  writeNote(a, { title: "A's note", body: BODY, author: "Priya", date: "2026-10-07" }, "personal");
  const b = repo("first-b", "git@github.com:acme/b.git", { "b.go": "package b\n" });
  assert.equal(findRepoPlace(b).key, "github.com/acme/b");
  assert.equal(listNotes(b).length, 0);
  assert.equal(keepsNotes(b), false);
  assert.ok(!repoPlace(b).dir.startsWith(join(env.TRAIL_HOME!, "repos", "github.com", "acme", "a")));
});

test("a machine with no notes anywhere never runs git to look for moved ones", () => {
  home();
  const d = repo("no-notes", "git@github.com:acme/none.git");
  // No index.json: findRepoPlace returns the plain place without spawning.
  assert.equal(findRepoPlace(d).key, "github.com/acme/none");
});

// --- a folder of repos ---

test("a folder holding several repos reads each one's notes, with touches under the repo's folder", () => {
  home();
  const ws = tmpRepo("workspace");
  for (const [name, remote] of [["api", "git@github.com:acme/api.git"], ["web", "git@github.com:acme/web.git"]]) {
    const d = join(ws, name!);
    mkdirSync(d);
    git(d, "init", "-q");
    git(d, "remote", "add", "origin", remote!);
  }
  mkdirSync(join(ws, "notes-scratch"));
  assert.deepEqual(childCheckouts(ws).map((c) => c.slice(ws.length + 1)), ["api", "web"]);
  writeNote(join(ws, "api"), { title: "Retry budget", body: BODY, author: "Priya", date: "2026-10-06", touches: ["internal/retry.go"] });
  writeNote(join(ws, "web"), { title: "Bbox overlay", body: BODY, author: "Sam", date: "2026-10-07", touches: ["src/Overlay.tsx#Overlay"] });

  assert.equal(noteCount(ws), 2);
  assert.equal(keepsNotes(ws), true);
  const notes = listNotes(ws);
  assert.deepEqual(
    notes.map((n) => n.touches),
    [["web/src/Overlay.tsx#Overlay"], ["api/internal/retry.go"]],
  );
  assert.equal(notePlaces(ws).length, 3, "the folder itself, then each repo");
  // From inside one repo, only that repo's notes.
  assert.deepEqual(listNotes(join(ws, "api")).map((n) => n.title), ["Retry budget"]);
});

test("touches read relative to the folder asked about, so they line up with a code map built in a subfolder", () => {
  home();
  const d = repo("mono", "git@github.com:acme/mono.git", { "backend/ocr/bbox.go": "package ocr\n", "web/a.ts": "" });
  writeNote(d, { title: "Bbox", body: BODY, author: "Priya", date: "2026-10-07", touches: ["backend/ocr/bbox.go#NormalizeBox", "web/a.ts"] });
  assert.deepEqual(listNotes(join(d, "backend"))[0]?.touches, ["ocr/bbox.go#NormalizeBox", "../web/a.ts"]);
  assert.deepEqual(listNotes(d)[0]?.touches, ["backend/ocr/bbox.go#NormalizeBox", "web/a.ts"]);
});

// --- which repos a note goes to ---

test("a session that edited two repos leaves its note in both, each with its own files", () => {
  home();
  const api = repo("edit-api", "git@github.com:acme/api.git", { "internal/retry.go": "package internal\n" });
  const lib = repo("edit-lib", "git@github.com:acme/lib.git", { "retry/backoff.go": "package retry\n" });
  writeFileSync(join(api, "internal", "retry.go"), "package internal\n// changed\n");
  const targets = noteTargets(api, [join(lib, "retry", "backoff.go"), join(api, "internal", "retry.go"), join(homedir(), ".claude", "plans", "x.md")]);
  assert.deepEqual(targets, [
    { dir: api, touches: ["internal/retry.go"] },
    { dir: lib, touches: ["retry/backoff.go"] },
  ]);
});

test("saved from a folder of repos, a note goes to the repos the session changed, or to the folder", () => {
  home();
  const ws = tmpRepo("ws-note");
  const api = join(ws, "api");
  const web = join(ws, "web");
  for (const d of [api, web]) {
    mkdirSync(d);
    git(d, "init", "-q");
  }
  writeFileSync(join(web, "app.ts"), "x\n");
  assert.deepEqual(noteTargets(ws, [join(web, "app.ts")]), [{ dir: web, touches: ["app.ts"] }]);
  // No transcript: each repo's own uncommitted changes say what was touched.
  assert.deepEqual(noteTargets(ws), [{ dir: web, touches: ["app.ts"] }]);
  // Nothing changed anywhere: the note stays with the folder.
  const quiet = tmpRepo("ws-quiet");
  assert.deepEqual(noteTargets(quiet), [{ dir: quiet, touches: [] }]);
});

test("a session that edited a repo through both its checkout and a worktree leaves one note", () => {
  home();
  const main = repo("both-main", "git@github.com:acme/both.git", { "a.go": "package a\n", "b.go": "package b\n" });
  const wt = join(tmpRepo("both-wt"), "wt");
  git(main, "worktree", "add", "-q", "-b", "side", wt);
  const targets = noteTargets(main, [join(main, "a.go"), join(wt, "b.go")]);
  assert.equal(targets.length, 1);
  assert.deepEqual(targets[0]!.touches.sort(), ["a.go", "b.go"]);
});

test("paths under the home folder read as ~/", () => {
  assert.equal(shownPath(join(homedir(), ".trail", "repos", "x")), "~/.trail/repos/x");
  assert.equal(shownPath("/srv/elsewhere"), "/srv/elsewhere");
  assert.equal(shownPath("notes/a.md"), "notes/a.md");
});
