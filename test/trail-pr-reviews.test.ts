/**
 * The first-run read of PR reviews: which comments count as a reviewer's,
 * that a finding survives only when the comments it quotes are on two or more
 * PRs, and that `trail init` reads them with `gh` when it can and stays quiet
 * when it can't.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { finishReviewRead, ghReady, reviewDigest, reviewedPRs, reviewWords, verifyReviews, type ReviewedPR, type ReviewFinding, type ReviewResult } from "../src/notes/pr-reviews.js";
import { ensureRepoHome } from "../src/notes/home.js";
import { parseNote } from "../src/notes/notes.js";
import { claudeProjectDir } from "../src/notes/session-cost.js";
import { tmpRepo } from "./helpers.js";

const human = (login: string) => ({ login, __typename: "User" });
const bot = { login: "coderabbitai", __typename: "Bot" };

/** GitHub's GraphQL answer for four merged PRs, one reviewed only by a bot. */
const GITHUB = {
  data: {
    repository: {
      pullRequests: {
        nodes: [
          {
            number: 38,
            title: "Users endpoint",
            mergedAt: "2026-10-05T09:00:00Z",
            author: { login: "bob" },
            reviews: { nodes: [{ body: "", author: human("alice") }] },
            reviewThreads: {
              nodes: [{ comments: { nodes: [{ body: "Same again: handlers in src/api must return a 500 when db.query fails.", path: "src/api/users.ts", author: human("alice") }] } }],
            },
          },
          {
            number: 41,
            title: "Orders endpoint",
            mergedAt: "2026-10-10T09:00:00Z",
            author: { login: "bob" },
            reviews: { nodes: [{ body: "Looks good once the error handling is in. <!-- review-bot:ignore -->", author: human("alice") }] },
            reviewThreads: {
              nodes: [
                {
                  comments: {
                    nodes: [
                      { body: "This handler swallows the error from db.query, log it and return a 500.", path: "src/api/orders.ts", author: human("alice") },
                      { body: "> This handler swallows the error\n\ndone, thanks", path: "src/api/orders.ts", author: human("bob") },
                    ],
                  },
                },
                { comments: { nodes: [{ body: "Consider adding tests for this endpoint.", path: "src/api/orders.ts", author: bot }] } },
              ],
            },
          },
          {
            number: 35,
            title: "Fixture refresh",
            mergedAt: "2026-09-30T09:00:00Z",
            author: { login: "carol" },
            reviews: { nodes: [{ body: "The fixture has token: ghp_abcdefghijklmnopqrstuvwxyz1234 in it, please add a changelog entry too.", author: human("dan") }] },
            reviewThreads: { nodes: [] },
          },
          {
            number: 30,
            title: "Bump deps",
            mergedAt: "2026-09-20T09:00:00Z",
            author: { login: "dependabot", __typename: "Bot" },
            reviews: { nodes: [{ body: "Auto-approved.", author: { login: "github-actions[bot]" } }] },
            reviewThreads: { nodes: [] },
          },
        ],
      },
    },
  },
};

test("only reviewers' words count: bots, the PR's author and quoted replies are dropped, and secrets scrubbed", () => {
  const { merged, prs } = reviewedPRs(GITHUB);
  assert.equal(merged, 4);
  assert.deepEqual(prs.map((p) => p.number), [41, 38, 35], "newest merged first, the bot-only PR left out");
  const orders = prs[0]!;
  assert.deepEqual(orders.comments, [
    { text: "Looks good once the error handling is in." },
    { path: "src/api/orders.ts", text: "This handler swallows the error from db.query, log it and return a 500." },
  ]);
  assert.ok(!prs[2]!.comments[0]!.text.includes("ghp_"));
  assert.equal(reviewWords("> quoted\n\n![shot](https://x/y.png) see this"), "[image] see this");
  assert.equal(reviewWords("<!-- only a marker -->"), null);
  assert.equal(reviewWords("a <!<!-- x -->-- b --> c"), "a c");
  assert.equal(reviewWords("keep this <!-- never closed"), "keep this");
});

test("the digest heads each PR with its number and stops at its size", () => {
  const prs: ReviewedPR[] = [
    { number: 9, title: "New", at: "2026-10-09T00:00:00Z", comments: [{ path: "a.ts", text: "x".repeat(50) }] },
    { number: 8, title: "Old", at: "2026-09-01T00:00:00Z", comments: [{ text: "y".repeat(50) }] },
  ];
  const all = reviewDigest(prs);
  assert.match(all.text, /^=== PR #9 · 2026-10-09 · New ===\n\[review on a\.ts\] x+\n\n=== PR #8 · 2026-09-01 · Old ===\n\[review\] y+$/);
  const small = reviewDigest(prs, 90);
  assert.deepEqual(small.read.map((p) => p.number), [9]);
});

test("a review finding is kept only when its quotes are on two PRs, and trail counts them", () => {
  const { prs } = reviewedPRs(GITHUB);
  const out = verifyReviews(
    [
      {
        title: "Return a 500 when db.query fails in src/api",
        body: "## Decided\n- Handlers in `src/api/` log the db.query error and return a 500.",
        evidence: [
          { pr: 41, quote: "swallows the error from db.query" },
          // Filed under the wrong PR, and as a string: still counts for the one it's on.
          { pr: "#35", quote: "must return a 500 when db.query fails" },
        ],
      },
      { title: "Made up", body: "## Decided\n- x", evidence: [{ pr: 41, quote: "never said anything like this" }, { pr: 38, quote: "nor this one either" }] },
      { title: "Changelog", body: "## Decided\n- y", evidence: [{ pr: 35, quote: "please add a changelog entry too" }, { pr: 41, quote: "please add a changelog entry too" }] },
    ],
    prs,
  );
  assert.equal(out.length, 1);
  assert.equal(out[0]!.title, "Return a 500 when db.query fails in src/api");
  assert.deepEqual(out[0]!.prs, [41, 38]);
  assert.equal(out[0]!.last, "2026-10-10");
});

/* ---- trail init, end to end, with stand-ins for Claude Code and gh on PATH ---- */

function transcript(entries: object[]): string {
  return entries.map((e) => JSON.stringify(e)).join("\n") + "\n";
}

/** A repo whose origin is a bare repo under a `github.com/` path: GitHub to trail, no network to git. */
function githubRepo(name: string): string {
  const repo = tmpRepo(name);
  const origin = join(mkdtempSync(join(tmpdir(), "gh-origin-")), "github.com", "acme", "shop.git");
  mkdirSync(origin, { recursive: true });
  spawnSync("git", ["init", "-q", "--bare"], { cwd: origin });
  spawnSync("git", ["init", "-q"], { cwd: repo });
  spawnSync("git", ["remote", "add", "origin", origin], { cwd: repo });
  return repo;
}

/** Two past sessions in `repo` that both say the same thing. */
function pastSessions(repo: string, home: string): void {
  const projects = claudeProjectDir(repo, home);
  mkdirSync(projects, { recursive: true });
  for (const id of ["aaaaaaaa-1111", "bbbbbbbb-2222"])
    writeFileSync(
      join(projects, `${id}.jsonl`),
      transcript([{ type: "user", cwd: repo, timestamp: "2026-10-01T10:00:00Z", message: { role: "user", content: "always run go test with -race before pushing" } }]),
    );
}

/**
 * A `claude` that answers the session read with one finding and the review
 * read with two (one only on one PR), keeping what it was sent; and a `gh`
 * that's signed in or not, answering the GraphQL call with GITHUB.
 */
function fakeTools(signedIn: boolean): { bin: string; log: string } {
  const bin = mkdtempSync(join(tmpdir(), "fake-tools-"));
  const log = join(bin, "log");
  mkdirSync(log);
  const sessions = {
    findings: [
      {
        title: "Run go test with -race before pushing",
        for: "team",
        body: "## Decided\n- Run `go test -race ./...` before every push.",
        evidence: [
          { session: "aaaaaaaa", quote: "always run go test with -race before pushing" },
          { session: "bbbbbbbb", quote: "always run go test with -race before pushing" },
        ],
      },
    ],
  };
  const reviews = {
    findings: [
      {
        title: "Return a 500 when db.query fails in src/api",
        body: "## Decided\n- Handlers in `src/api/` log the db.query error and return a 500.",
        evidence: [
          { pr: 41, quote: "swallows the error from db.query" },
          { pr: 38, quote: "must return a 500 when db.query fails" },
        ],
      },
      { title: "Add a changelog entry", body: "## Decided\n- y", evidence: [{ pr: 35, quote: "please add a changelog entry too" }] },
    ],
  };
  writeFileSync(
    join(bin, "claude"),
    `#!/usr/bin/env node
const fs = require("fs");
if (process.argv.includes("--version")) { console.log("9.9.9"); process.exit(0); }
let input = "";
process.stdin.on("data", (b) => (input += b));
process.stdin.on("end", () => {
  const review = input.startsWith("Review comments");
  fs.writeFileSync(${JSON.stringify(log)} + (review ? "/reviews.txt" : "/sessions.txt"), input);
  const out = review ? ${JSON.stringify(reviews)} : ${JSON.stringify(sessions)};
  console.log(JSON.stringify({ is_error: false, total_cost_usd: 0.01, structured_output: out }));
});
`,
  );
  writeFileSync(
    join(bin, "gh"),
    `#!/usr/bin/env node
const fs = require("fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)} + "/gh.txt", args.slice(0, 2).join(" ") + "\\n");
if (args[0] === "auth" && args[1] === "token") process.exit(${signedIn ? 0 : 1});
if (args[0] === "api" && args[1] === "graphql" && args.includes("owner={owner}")) { console.log(${JSON.stringify(JSON.stringify(GITHUB))}); process.exit(0); }
process.exit(1);
`,
  );
  chmodSync(join(bin, "claude"), 0o755);
  chmodSync(join(bin, "gh"), 0o755);
  return { bin, log };
}

function initRun(repo: string, home: string, bin: string) {
  const r = spawnSync(process.execPath, ["--import", "tsx", join(process.cwd(), "src", "bin", "trail.ts"), "init", repo, "--agents", "claude", "--no-build", "--no-global"], {
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      TRAIL_HOME: join(home, ".trail"),
      PATH: `${bin}:${process.env.PATH}`,
      DO_NOT_TRACK: "1",
      GIT_TERMINAL_PROMPT: "0",
      TRAIL_NO_FETCH: undefined,
      CLAUDECODE: undefined,
      TRAIL_INVOKED_AS: undefined,
      GH_TOKEN: undefined,
      GITHUB_TOKEN: undefined,
    },
  });
  return { status: r.status, err: r.stderr };
}

const reviewLearnings = (repo: string) =>
  readdirSync(join(repo, ".trail", "learnings"))
    .filter((f) => f.endsWith(".md"))
    .map((f) => parseNote(readFileSync(join(repo, ".trail", "learnings", f), "utf8"), f)!)
    .filter((n) => /Flagged in review/.test(n.body));

// The stand-ins are shebang scripts, which Windows won't run as `claude` or `gh`.
test("trail init learns what reviewers flagged on two PRs, beside the session learnings, once per repo", { skip: process.platform === "win32" }, () => {
  const home = mkdtempSync(join(tmpdir(), "reviews-init-home-"));
  const repo = githubRepo("reviews-init");
  pastSessions(repo, home);
  const { bin, log } = fakeTools(true);

  const first = initRun(repo, home, bin);
  assert.equal(first.status, 0, first.err);
  assert.match(first.err, /· reading review comments on this repo's merged PRs for what reviewers keep flagging/);
  assert.match(first.err, /✓ learned 1 thing you told Claude more than once, from your last 2 sessions here\n {4}for your team · told Claude in 2 sessions: Run go test with -race before pushing\n/);
  assert.match(first.err, /✓ learned 1 thing reviewers flagged on more than one PR, from the last 4 merged PRs here\n {4}for your team · flagged in review on 2 PRs: Return a 500 when db\.query fails in src\/api\n· Claude follows them from your next session\n🌱 Commit what you learned/);
  assert.equal(first.err.match(/Claude follows them/g)?.length, 1, "one closing line for both");

  const [learning] = reviewLearnings(repo);
  assert.ok(learning);
  assert.equal(learning.standing, true);
  assert.match(learning.body, /_Flagged in review on 2 PRs here \(#41, #38\), most recently on Oct 10\._/);

  // What Claude was sent: reviewers' comments, scrubbed, with no names, bots or author replies.
  const sent = readFileSync(join(log, "reviews.txt"), "utf8");
  assert.match(sent, /=== PR #41 · 2026-10-10 · Orders endpoint ===\n\[review\] Looks good once the error handling is in\.\n\[review on src\/api\/orders\.ts\] This handler swallows/);
  for (const absent of ["ghp_", "alice", "bob", "done, thanks", "Consider adding tests", "PR #30"]) assert.ok(!sent.includes(absent), `sent ${absent}`);

  const again = initRun(repo, home, bin);
  assert.equal(again.status, 0, again.err);
  assert.doesNotMatch(again.err, /reading review comments/, "read once per repo on this machine");

  // A teammate's machine, with the review learning already in the repo: nothing new to learn from the same reviews.
  const teammate = mkdtempSync(join(tmpdir(), "reviews-teammate-home-"));
  const theirs = initRun(repo, teammate, bin);
  assert.equal(theirs.status, 0, theirs.err);
  assert.doesNotMatch(theirs.err, /reading review comments/);
  assert.equal(reviewLearnings(repo).length, 1);
});

test("without a signed-in gh, trail init skips PR reviews quietly and still learns from sessions", { skip: process.platform === "win32" }, () => {
  const home = mkdtempSync(join(tmpdir(), "reviews-nogh-home-"));
  const repo = githubRepo("reviews-nogh");
  pastSessions(repo, home);
  const { bin, log } = fakeTools(false);

  const r = initRun(repo, home, bin);
  assert.equal(r.status, 0, r.err);
  assert.doesNotMatch(r.err, /review/i);
  assert.match(r.err, /✓ learned 1 thing you told Claude more than once/);
  assert.equal(readFileSync(join(log, "gh.txt"), "utf8"), "auth token\n", "asked gh only whether it's signed in");
  assert.ok(!existsSync(join(log, "reviews.txt")));
});

test("gh isn't asked at all without a GitHub remote, and a missing gh means no reviews", () => {
  const plain = tmpRepo("reviews-no-remote");
  spawnSync("git", ["init", "-q"], { cwd: plain });
  const { bin, log } = fakeTools(true);
  assert.equal(ghReady(plain, join(bin, "gh")), false);
  assert.ok(!existsSync(join(log, "gh.txt")));
  assert.equal(ghReady(githubRepo("reviews-missing-gh"), "trail-test-no-such-gh"), false);
});

/* ---- ticking which review learnings to keep ---- */

function flagged(title: string): ReviewFinding {
  return { title, body: "## Decided\n- " + title + ".", prs: [41, 38], last: "2026-10-10", quotes: [] };
}

function reviewReadWith(findings: ReviewFinding[]) {
  const result: ReviewResult = { prs: 50, reviewed: 12, read: 12, findings, model: "claude-sonnet-5-5", durationMs: 10 };
  return { started: Date.now(), done: true, result: Promise.resolve(result) };
}

async function withTrailHome(name: string, run: () => Promise<void>): Promise<void> {
  const env = { TRAIL_HOME: process.env.TRAIL_HOME, DO_NOT_TRACK: process.env.DO_NOT_TRACK };
  process.env.TRAIL_HOME = join(mkdtempSync(join(tmpdir(), name)), ".trail");
  process.env.DO_NOT_TRACK = "1";
  try {
    await run();
  } finally {
    process.env.TRAIL_HOME = env.TRAIL_HOME;
    process.env.DO_NOT_TRACK = env.DO_NOT_TRACK;
  }
}

test("init saves only the review learnings the person kept, and remembers the reviews were read", () =>
  withTrailHome("review-keep-home-", async () => {
    const repo = tmpRepo("review-keep-some");
    spawnSync("git", ["init", "-q"], { cwd: repo });
    const all = [flagged("Return a 500 when db.query fails"), flagged("Add a changelog entry"), flagged("Name migrations by date")];
    const { saved, kept, cancelled } = await finishReviewRead(repo, reviewReadWith(all), async (f) => [f[0]!, f[2]!]);
    assert.equal(cancelled, false);
    assert.deepEqual(kept.map((f) => f.title), ["Return a 500 when db.query fails", "Name migrations by date"]);
    assert.deepEqual(saved.map((n) => [n.title, n.scope]), [["Return a 500 when db.query fails", "repo"], ["Name migrations by date", "repo"]]);
    assert.ok(existsSync(join(ensureRepoHome(repo).place.dir, "pr-reviews.json")), "read once per repo");
  }));

test("cancelling the pick saves no review learning, and the next init asks again", () =>
  withTrailHome("review-keep-none-home-", async () => {
    const repo = tmpRepo("review-keep-cancel");
    spawnSync("git", ["init", "-q"], { cwd: repo });
    const { saved, cancelled } = await finishReviewRead(repo, reviewReadWith([flagged("Add a changelog entry")]), async () => null);
    assert.equal(cancelled, true);
    assert.equal(saved.length, 0);
    assert.equal(existsSync(join(repo, ".trail", "learnings")) && readdirSync(join(repo, ".trail", "learnings")).some((f) => f.endsWith(".md")), false);
    assert.equal(existsSync(join(ensureRepoHome(repo).place.dir, "pr-reviews.json")), false, "not marked read");
  }));
