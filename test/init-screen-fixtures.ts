/**
 * Synthetic init items for the b6 tests (screen, relay, keep, naming call):
 * made-up repos, commands and lines. Not a test file itself.
 */
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InitCandidate, InitItem, LookBack } from "../src/init/types.js";
import type { ScreenFacts } from "../src/init/review-screen.js";
import type { CompiledSkill } from "../src/skills/types.js";

export function compiled(name = "release-npm", steps = ["npm version {version}", "npm publish", "git push origin v{version}"]): CompiledSkill {
  return {
    name, title: "Release acme-cli to npm", description: "Publish acme-cli to npm and check it with npm view.",
    meta: { trail: "s-7f3a2c", scope: "personal", applies: "github.com/acme/cli", job: "release", asks: "release, publish", version: "1", check: "npm view acme-cli version", "check-shows": "{version}" },
    steps: steps.map((cmd, i) => ({ n: i + 1, cmd, gated: cmd === "npm publish" ? "publish" : null, bg: false, wait: false })),
    check: "npm view acme-cli version", checkShows: "{version}", checkIsStep: false, ifFails: [], dontUse: "", params: [{ name: "version", shape: "version", seen: ["1.4.2"] }], helpers: [],
    leftOut: { failed: 1, lookOnly: 3, duplicates: 0, plumbing: 0, work: 0 }, source: { runId: "r-1003-aa11", commands: 9, failed: 1, at: "2026-10-03T10:00:00.000Z" },
  } as CompiledSkill;
}

export function skillCandidate(id = "i-1f0e2a9c41", c = compiled()): InitCandidate {
  return {
    id, kind: "skill", key: "github.com/acme/cli|job:release", plainName: c.name, nameWords: [c.name],
    count: { days: 21, from: "2026-07-03", to: "2026-10-14", costly: 14 }, scope: "personal", applies: "github.com/acme/cli", typed: false, ticked: false,
    skill: { compiled: c, src: { t: "/home/dev/.claude/projects/-home-dev-cli/s1.jsonl", size: 10, mtimeMs: 1, run: { from: 0, to: 9 }, prior: null, skillSha: "b".repeat(64) } },
    evidence: [`your Claude Code how-to release.md describes it`], rank: 1,
  };
}



export const REPO_KEY = "github.com/acme/cli";

export function guardrailCandidate(): InitCandidate {
  return {
    id: "i-77b10e3d02", kind: "guardrail", key: "wall:timeout-missing", plainName: "no-timeout", nameWords: ["no-timeout"],
    count: { days: 6, from: "2026-07-09", to: "2026-10-02" }, scope: "personal", applies: "every repo", typed: false, ticked: false,
    guardrail: { cls: "timeout-missing", check: "no-timeout" }, evidence: [], rank: 1,
  };
}

export function prefCandidate(ref: { t: string; o: number; s: string } = { t: "/home/dev/.claude/projects/-home-dev-cli/s1.jsonl", o: 0, s: "c".repeat(64) }): InitCandidate {
  return {
    id: "i-c3d9e0b871", kind: "preference", key: "pref:0123456789abcdef", plainName: "", nameWords: ["explain", "simply", "one", "example"],
    count: { days: 12, from: "2026-07-03", to: "2026-10-14" }, scope: "personal", applies: "every repo", typed: true, ticked: true,
    pref: { refs: [ref] }, evidence: [], rank: 1,
  };
}

/** The three J01 items as the screen shows them. */
export function threeItems(): InitItem[] {
  return [
    { ...skillCandidate(), n: 1, title: "release-npm", description: "publish to npm and check it with npm view" },
    { ...guardrailCandidate(), n: 2, title: "no-timeout", description: "Claude won't use the timeout command, which this Mac doesn't have" },
    { ...prefCandidate(), n: 3, title: "explain it simply, one example first", description: "" },
  ];
}

export function lookBackOf(over: Partial<LookBack> = {}): LookBack {
  return {
    sessions: Array.from({ length: 23 }, (_, i) => ({ sh: i.toString(16).padStart(12, "0"), how: "own" as const, days: 1 })),
    skipped: [], days: 21, from: "2026-07-03", to: "2026-10-14", parent: 15, candidates: [], alreadyKept: { here: 0, elsewhere: [] }, howtos: [], ms: 41000, errors: [], ...over,
  };
}

export function factsOf(over: Partial<ScreenFacts> = {}): ScreenFacts {
  return { lookBack: lookBackOf(), model: "none", why: null, tokens: 0, calls: 0, offers: "on", offersOffAt: null, repoName: "acme-cli", agent: false, skills: true, ...over };
}


/** A scratch HOME with its own ~/.trail; process.env.TRAIL_HOME points there while `fn` runs (phase 0's writeNote reads it). */
export async function withHome<T>(tag: string, fn: (h: { home: string; env: NodeJS.ProcessEnv }) => Promise<T> | T): Promise<T> {
  const home = mkdtempSync(join(tmpdir(), `graft-b6-${tag}-`));
  const saved = { trail: process.env.TRAIL_HOME, dnt: process.env.DO_NOT_TRACK };
  process.env.TRAIL_HOME = join(home, ".trail");
  process.env.DO_NOT_TRACK = "1";
  try {
    return await fn({ home, env: { HOME: home, TRAIL_HOME: join(home, ".trail"), DO_NOT_TRACK: "1" } });
  } finally {
    for (const [k, v] of [["TRAIL_HOME", saved.trail], ["DO_NOT_TRACK", saved.dnt]] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(home, { recursive: true, force: true });
  }
}

/** A transcript in `home`'s Claude Code projects folder; the pointer (offset, sha) of each line. */
export function projectTranscript(home: string, lines: object[], id = "5f0c1a2b-3c4d-4e5f-8a9b-0c1d2e3f4a5b", folder = "-home-dev-cli"): { path: string; refs: Array<{ t: string; o: number; s: string }> } {
  const dir = join(home, ".claude", "projects", folder);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${id}.jsonl`);
  const refs: Array<{ t: string; o: number; s: string }> = [];
  let o = 0;
  let text = "";
  for (const e of lines) {
    const line = JSON.stringify(e);
    refs.push({ t: path, o, s: createHash("sha256").update(line).digest("hex") });
    text += `${line}\n`;
    o += Buffer.byteLength(line) + 1;
  }
  writeFileSync(path, text);
  return { path, refs };
}
