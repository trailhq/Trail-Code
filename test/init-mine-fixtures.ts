/**
 * A synthetic `~/.claude/projects` tree for init's look-back (b5): a made-up
 * checkout of acme/shop with a worktree, a clone elsewhere, a parent folder,
 * and session transcripts shaped like Claude Code's (typed lines, Bash
 * calls and their results, replies, compactions), each line with its cwd
 * and time. Made-up repos, prompts and output only. Not a test file itself.
 */
import { spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpRepo } from "./helpers.js";
import { compactBoundary, jsonl, said, toolResult, toolUse, typed } from "./trace-fixtures.js";

export const SHOP = "github.com/acme/shop";

const git = (dir: string, ...args: string[]) => spawnSync("git", ["-C", dir, ...args], { encoding: "utf8" });

/** A git checkout at `dir` whose origin is `remote`, with one commit. */
export function checkout(dir: string, remote: string): string {
  mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q", "-b", "main");
  git(dir, "remote", "add", "origin", remote);
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "acme-shop", scripts: { build: "tsc", lint: "eslint ." } }));
  writeFileSync(join(dir, "Makefile"), "release:\n\techo release\n");
  git(dir, "add", ".");
  git(dir, "-c", "user.name=T", "-c", "user.email=t@x.test", "commit", "-qm", "one");
  return dir;
}

export interface World {
  root: string; home: string; trail: string; parent: string; repo: string; wt: string; clone: string; other: string;
  env: NodeJS.ProcessEnv;
}

/** acme/shop under <root>/work/shop, a worktree beside it, a clone elsewhere, acme/web beside it; a Trail home. */
export function world(tag = "mine"): World {
  const root = tmpRepo(`b5-${tag}`);
  const home = join(root, "home");
  const trail = join(root, "trail-home");
  const parent = join(root, "work");
  const repo = checkout(join(parent, "shop"), "git@github.com:acme/shop.git");
  const wt = join(parent, "shop-wt");
  git(repo, "worktree", "add", "-q", wt);
  const clone = checkout(join(root, "elsewhere", "shop-copy"), "https://github.com/acme/shop");
  const other = checkout(join(parent, "web"), "git@github.com:acme/web.git");
  mkdirSync(join(home, ".claude", "projects"), { recursive: true });
  mkdirSync(trail, { recursive: true });
  return { root, home, trail, parent, repo, wt, clone, other, env: { HOME: home, TRAIL_HOME: trail, PATH: process.env.PATH ?? "" } };
}

export const folderOf = (p: string) => p.replace(/[^A-Za-z0-9]/g, "-");

/** `2026-09-<d>T<h>:00:00Z` plus `sec` seconds. */
export const day = (d: number, h = 10, sec = 0) => new Date(Date.UTC(2026, 8, d, h, 0, 0) + sec * 1000).toISOString();

let ids = 0;

/** Builds one transcript's lines, in order, in one folder with one branch. */
export class Tx {
  readonly lines: object[] = [];
  constructor(public cwd: string, public branch = "main") {}
  private where(at: string, cwd = this.cwd) {
    return { cwd, gitBranch: this.branch, timestamp: at };
  }
  typed(at: string, text: string, cwd?: string): this {
    this.lines.push(typed(text, this.where(at, cwd)));
    return this;
  }
  /** A Bash call and its result. */
  bash(at: string, command: string, output: string, opts: { isError?: boolean; cwd?: string } = {}): this {
    const id = `toolu_b5${String(++ids).padStart(6, "0")}`;
    this.lines.push(toolUse(id, "Bash", { command, description: "run it" }, this.where(at, opts.cwd)));
    this.lines.push(toolResult(id, output, opts.isError, this.where(at, opts.cwd)));
    return this;
  }
  /** Any other tool call and its result. */
  tool(at: string, name: string, input: object, output = "ok", cwd?: string): this {
    const id = `toolu_b5${String(++ids).padStart(6, "0")}`;
    this.lines.push(toolUse(id, name, input, this.where(at, cwd)));
    this.lines.push(toolResult(id, output, undefined, this.where(at, cwd)));
    return this;
  }
  said(at: string, text: string): this {
    this.lines.push(said(text, this.where(at)));
    return this;
  }
  compact(at: string): this {
    this.lines.push(compactBoundary(this.where(at)));
    return this;
  }
  /** Writes the transcript to `<home>/.claude/projects/<folder>/<id>.jsonl`; returns its path. */
  write(home: string, id: string, folder = folderOf(this.cwd), extra: Record<string, unknown> = {}): string {
    const dir = join(home, ".claude", "projects", folder);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `${id}.jsonl`);
    writeFileSync(path, jsonl(this.lines.map((l) => ({ ...l, sessionId: id, ...extra }))));
    return path;
  }
  append(path: string, id: string): void {
    appendFileSync(path, jsonl(this.lines.map((l) => ({ ...l, sessionId: id }))));
  }
}

/** A release that checked out: build, a publish (failed first when `failedFirst`), and npm view shows it. */
export function releaseJob(tx: Tx, d: number, version: string, opts: { failedFirst?: boolean; ask?: string; h?: number } = {}): Tx {
  const h = opts.h ?? 10;
  tx.typed(day(d, h, 0), opts.ask ?? `publish ${version}`);
  tx.bash(day(d, h, 10), "npm run build", "built in 2.1s");
  if (opts.failedFirst) tx.bash(day(d, h, 15), `npm publish acme-cli-${version}.tgz`, "Exit code 1\nnpm error code E403\nnpm error 403 Forbidden", { isError: true });
  tx.bash(day(d, h, 20), `npm publish acme-cli-${version}.tgz --access public`, `+ acme-cli@${version}`);
  tx.bash(day(d, h, 30), "npm view acme-cli version", version);
  tx.said(day(d, h, 40), `Published ${version}.`);
  return tx;
}

/** A test run that checked out: install, build, the suite (failed first when `failedFirst`) passes. */
export function testsJob(tx: Tx, d: number, opts: { failedFirst?: boolean; h?: number } = {}): Tx {
  const h = opts.h ?? 10;
  tx.typed(day(d, h, 0), "run the test suite");
  tx.bash(day(d, h, 10), "npm ci", "added 212 packages in 3s");
  tx.bash(day(d, h, 15), "npm run build", "built in 2.1s");
  if (opts.failedFirst) tx.bash(day(d, h, 20), "npm test", "Exit code 1\nTests: 1 failed, 11 passed, 12 total", { isError: true });
  tx.bash(day(d, h, 30), "npm test", "Tests: 12 passed, 12 total");
  tx.said(day(d, h, 40), "All 12 tests pass.");
  return tx;
}

export function done(w: World): void {
  rmSync(w.root, { recursive: true, force: true });
}
