/**
 * `trail init --claude-memory`: a memory export pasted from Claude.ai, split
 * into facts, of which init offers only the ones about code, never the
 * person's private life or a secret, just for them, each once.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exportCandidates, exportFacts } from "../src/notes/claude-export.js";
import { finishMemoryRead, offeredBefore } from "../src/notes/memory-notes.js";
import { claudeAiLine } from "../src/init/run.js";
import { tmpRepo } from "./helpers.js";

const EXPORT = `Here are my memories of you, written out verbatim:

**Work context**

The user builds the shop API in TypeScript and deploys it with npm run release. They keep PRs small, e.g. under 300 lines.

**Personal context**

The user lives in Pune and trains for a half marathon on weekends.

**Top of mind**

- [2026-10-02] Their partner's birthday is on Friday, and the test for it is a cake.
- [2026-10-12] Retries in src/retry.ts stay at 4 because the
  gateway times out after 30 seconds.
- The staging deploy reads AWS_SECRET_ACCESS_KEY=AKIAABCDEFGHIJKLMNOP from the env file.
- They enjoy hiking.
`;

function gitRepo(tag: string): string {
  const repo = tmpRepo(tag);
  spawnSync("git", ["init", "-q"], { cwd: repo });
  spawnSync("git", ["remote", "add", "origin", "git@github.com:acme/shop.git"], { cwd: repo });
  return repo;
}

async function withTrailHome(run: (trail: string) => Promise<void> | void): Promise<void> {
  const env = { TRAIL_HOME: process.env.TRAIL_HOME, DO_NOT_TRACK: process.env.DO_NOT_TRACK };
  const trail = join(mkdtempSync(join(tmpdir(), "claude-ai-trail-")), ".trail");
  process.env.TRAIL_HOME = trail;
  process.env.DO_NOT_TRACK = "1";
  try {
    await run(trail);
  } finally {
    for (const [k, v] of Object.entries(env)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test("an export reads as facts: a paragraph a sentence at a time, a list item whole with its date, each under its heading", () => {
  const facts = exportFacts(EXPORT);
  assert.deepEqual(facts.slice(0, 2), [
    { text: "The user builds the shop API in TypeScript and deploys it with npm run release.", section: "Work context", date: null },
    { text: "They keep PRs small, e.g. under 300 lines.", section: "Work context", date: null },
  ]);
  assert.deepEqual(facts.find((f) => f.text.startsWith("Retries")), {
    text: "Retries in src/retry.ts stay at 4 because the gateway times out after 30 seconds.",
    section: "Top of mind",
    date: "2026-10-12",
  });
  assert.equal(facts.find((f) => f.text.startsWith("The user lives"))?.section, "Personal context");
});

test("init offers only the facts about code, never the private ones or a secret, just for the person", () => {
  const repo = gitRepo("claude-ai-offer");
  const { total, candidates } = exportCandidates(repo, EXPORT, { today: "2026-10-29" });
  assert.equal(total, 7, "the intro line is a heading, not a fact");
  assert.deepEqual(candidates.map((c) => [c.title, c.forTeam, c.updated]), [
    ["The user builds the shop API in TypeScript and deploys it with npm run release", false, "2026-10-29"],
    ["They keep PRs small, e.g. under 300 lines", false, "2026-10-29"],
    ["Retries in src/retry.ts stay at 4 because the gateway times out after 30 seconds", false, "2026-10-12"],
  ]);
  assert.ok(candidates.every((c) => c.from === "claude.ai" && c.path.startsWith("claude.ai:")));
  assert.equal(claudeAiLine(total, candidates.length), "· init offers 3 of the 7 things Claude.ai remembers about you, the ones about code, just for you");
  assert.match(claudeAiLine(0, 0), /found no memories in that file/);
});

test("a fact the repo's CLAUDE.md already says isn't offered, and one naming the repo's code comes first", () => {
  const repo = gitRepo("claude-ai-known");
  writeFileSync(join(repo, "CLAUDE.md"), "# Shop\n\n- The shop API is TypeScript and deploys with npm run release.\n");
  writeFileSync(join(repo, "retry.ts"), "export const MAX = 4;\n");
  const text = "- They keep PRs small, e.g. under 300 lines.\n- The user builds the shop API in TypeScript and deploys it with npm run release.\n- Retries in retry.ts stay at 4 because the gateway times out.\n";
  const { candidates } = exportCandidates(repo, text);
  assert.deepEqual(candidates.map((c) => [c.title, c.touches]), [
    ["Retries in retry.ts stay at 4 because the gateway times out", ["retry.ts"]],
    ["They keep PRs small, e.g. under 300 lines", []],
  ]);
});

test("with no screen the facts are kept just for the person, never in the repo, and each is offered once", () =>
  withTrailHome(async (trail) => {
    const repo = gitRepo("claude-ai-save");
    const { candidates } = exportCandidates(repo, EXPORT);
    const { saved } = await finishMemoryRead(repo, candidates, undefined, "claude_ai");
    assert.deepEqual(saved.map((n) => n.scope), ["personal", "personal", "personal"]);
    assert.equal(existsSync(join(repo, ".trail", "learnings")) && readdirSync(join(repo, ".trail", "learnings")).some((f) => f.endsWith(".md")), false);
    assert.match(readFileSync(saved[2]!.path, "utf8"), /_From your Claude\.ai memory, as of Oct 12\._/);
    assert.ok(saved[0]!.path.startsWith(trail));
    assert.deepEqual(exportCandidates(repo, EXPORT, { offered: offeredBefore(repo) }).candidates, [], "a re-export offers nothing new");
  }));
