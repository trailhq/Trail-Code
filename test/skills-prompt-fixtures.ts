/**
 * A sandbox for the recall hook tests: a Trail home and person home of their
 * own (a test home, so the test clock works), a real git checkout of the
 * made-up acme/webshop, skills saved through the store, and a Claude Code
 * transcript that grows between hook calls. Not a test file itself.
 */
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpRepo } from "./helpers.js";
import { jsonl, said, toolResult, toolUse, typed } from "./trace-fixtures.js";
import type { CompiledSkill } from "../src/skills/types.js";
import type { SkillSessionState } from "../src/trace/types.js";
import { savePersonal } from "../src/skills/store.js";
import { sessionPath } from "../src/trace/gate-file.js";
import { skillsGate } from "../src/trace/skill-session.js";

export const SID = "7a1c2b3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";

export interface Box { home: string; repo: string; env: NodeJS.ProcessEnv; transcript: string }

/** Skills on, a webshop checkout with an origin, an empty transcript; the clock at `now`. */
export function box(tag: string, opts: { now?: string; skills?: boolean; entry?: string } = {}): Box {
  const home = tmpRepo(`recall-${tag}`);
  const repo = join(home, "src", "webshop");
  mkdirSync(repo, { recursive: true });
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, stdio: "ignore" });
  git("init", "-q", "-b", "beta");
  git("remote", "add", "origin", "git@github.com:acme/webshop.git");
  git("-c", "user.email=dev@example.com", "-c", "user.name=dev", "-c", "commit.gpgsign=false", "commit", "-q", "--allow-empty", "-m", "one");
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH, HOME: home, TRAIL_HOME: join(home, "trail-home"), CLAUDE_CODE_ENTRYPOINT: opts.entry ?? "cli",
    TRAIL_TEST_NOW: opts.now ?? "2026-10-20T10:00:00.000Z",
  };
  mkdirSync(env.TRAIL_HOME!, { recursive: true });
  writeFileSync(join(env.TRAIL_HOME!, "settings.json"), JSON.stringify({ v: 1, skills: opts.skills === false ? "off" : "on" }));
  const transcript = join(home, ".claude", "projects", "-src-webshop", `${SID}.jsonl`);
  mkdirSync(join(transcript, ".."), { recursive: true });
  writeFileSync(transcript, "");
  return { home, repo, env, transcript };
}

export function save(b: Box, c: CompiledSkill): void {
  savePersonal(c, { from: "repeated", runId: c.source.runId, consent: "offer-yes", stepsVerified: c.steps.length, env: b.env, now: new Date("2026-10-14T11:00:00.000Z") });
}

/** The made-up checkout the payload names: a temp folder would read as a scratch folder (no folding, no learning). */
export const CWD = "/home/dev/webshop";

export const payload = (b: Box, prompt: string, extra: Record<string, unknown> = {}) => ({
  session_id: SID, transcript_path: b.transcript, cwd: CWD, permission_mode: "default", hook_event_name: "UserPromptSubmit", prompt, ...extra,
});
export const startPayload = (b: Box, source: string, extra: Record<string, unknown> = {}) => ({
  session_id: SID, transcript_path: b.transcript, cwd: CWD, permission_mode: "default", hook_event_name: "SessionStart", source, ...extra,
});

/** The real gate, with the checkout pointed at the box's real repo (as g5's tests do). */
export const gateFor = (b: Box) => (input: unknown, dir: string, env?: NodeJS.ProcessEnv) => {
  const g = skillsGate(input, dir, env);
  return g.ok ? { ok: true as const, ctx: { ...g.ctx, checkout: b.repo, repoKey: "github.com/acme/webshop" } } : g;
};

/** `sec` seconds after the box's clock starts (2026-10-20 10:00 UTC). */
export const at = (sec: number) => new Date(Date.UTC(2026, 9, 20, 10, 0, 0) + sec * 1000).toISOString();

/** The person typed this, `sec` seconds after 10:00, in the checkout. */
export const typedIn = (b: Box, text: string, sec: number) => typed(text, { timestamp: at(sec), cwd: b.repo, gitBranch: "beta" });
let calls = 0;
/** A Bash call in the checkout and its result a second later. */
export function ranIn(b: Box, cmd: string, out: string, sec: number, extra: { isError?: boolean } = {}): object[] {
  const id = `toolu_r${String(++calls).padStart(4, "0")}`;
  const where = { cwd: b.repo, gitBranch: "beta" };
  return [
    toolUse(id, "Bash", { command: cmd, description: "run it" }, { timestamp: at(sec), ...where }),
    toolResult(id, out, extra.isError, { timestamp: at(sec + 1), ...where }),
  ];
}
export const replyAt = (text: string, sec: number) => said(text, { timestamp: at(sec) });

export function grow(b: Box, entries: object[]): void {
  appendFileSync(b.transcript, jsonl(entries));
}

export function stateOf(b: Box): SkillSessionState {
  return JSON.parse(readFileSync(sessionPath(SID, ".json", b.env), "utf8")).skills;
}

export const withNow = (b: Box, iso: string): NodeJS.ProcessEnv => ({ ...b.env, TRAIL_TEST_NOW: iso });

/**
 * The prompt part's 400 ms deadline clock for tests about what a block says, not how fast it comes. A shared
 * Windows runner is slow enough to run out of the 400 ms and keep no block, so there this clock runs 4× slower,
 * the way #700 gave Windows more time. Elsewhere, and under TRAIL_PERF=1, it is the wall clock.
 */
export const deadlineClock = (): number => (process.platform === "win32" && process.env.TRAIL_PERF !== "1" ? Date.now() / 4 : Date.now());
