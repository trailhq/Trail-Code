/**
 * Keeping a trail current without anyone asking: a background `graft trail
 * push`, at most once a day, started by the session-start hook.
 *
 * A trail is read out of a repository's history, and its CLAUDE.md suggestions
 * are only as fresh as the last push. Nobody re-runs a push by hand — it is the
 * command you run once, during onboarding — so a trail attached in March was
 * still suggesting from March's history in September. The session-start hook is
 * the one place graft runs on its own every working day, so it is where the
 * refresh goes.
 *
 * Restraint is most of this file:
 *
 *  - Only for a repo with a trail attached. The push's other path, for a repo
 *    without one, signs up for a trail and opens a browser; a hook must never
 *    get anywhere near that, so no link means nothing happens at all — and the
 *    child is told it was started from here (AUTOPUSH_CHILD_ENV), so a link
 *    that disappears in the moment between this check and the child starting
 *    still cannot send it to sign-up.
 *  - Only when HEAD has moved since the last push graft recorded, because a push
 *    of the same history mines the same rules.
 *  - At most once in 24 hours, stamped BEFORE the child starts, so a push that
 *    fails, or ten sessions opened in one morning, cost one push and not ten.
 *  - Fully detached: `--no-watch`, stdin closed, output to a log under
 *    `.graft/`, unref'd. The session never waits on it.
 *  - Off with GRAFT_TRAIL_AUTOPUSH=0, or `"trailAutoPush": false` in
 *    `.graft/config.json`.
 *
 * The state lives in its own file beside the link rather than inside
 * `.graft/config.json`: the child writes it when its push lands, and a
 * read-modify-write of the file that holds the link, from a detached process,
 * racing whatever the foreground is doing, is how a token gets lost.
 */
import { closeSync, openSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { join } from "node:path";
import { graftCliPath } from "../claude/paths.js";
import { BUILD_CONFIG_DIR, readBuildConfig, readJson, writeJsonAtomic } from "../util/state.js";
import { track } from "../telemetry/track.js";
import type { TRAIL_AUTOPUSH_SKIPS } from "../telemetry/contract.js";
import { readLink } from "./link.js";

/** A day. The history a push reads moves by days, not minutes. */
export const AUTOPUSH_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** Set on the background push's environment, so it can refuse the sign-up
 *  path outright (see the push command in cli.ts). */
export const AUTOPUSH_CHILD_ENV = "GRAFT_TRAIL_AUTOPUSH_CHILD";

/** What graft remembers about this checkout's pushes. */
export interface TrailPushState {
  /** HEAD when a push last reached Trail, from any push — by hand or in the background. */
  pushedHead?: string;
  pushedAt?: number;
  /** When a background push was last STARTED, and at which HEAD. Written before
   *  the child is spawned, so a child that dies still throttles the next one. */
  autoPushAt?: number;
  autoPushHead?: string;
  /** Trail's suggestion count the last time the session-start hook read it —
   *  what "new suggestions since your last session" is counted from (see
   *  trailContextLine). Here rather than in config.json for the same reason as
   *  the rest: the hook writes it on every session. */
  seenSuggested?: number;
}

export function trailPushStatePath(repo: string): string {
  return join(repo, BUILD_CONFIG_DIR, "trail-push.json");
}

/** Where the background push writes its output. Overwritten by each one, so it
 *  never grows past a single push's worth. */
export function trailPushLogPath(repo: string): string {
  return join(repo, BUILD_CONFIG_DIR, "trail-push.log");
}

export function readTrailPushState(repo: string): TrailPushState {
  return readJson<TrailPushState>(trailPushStatePath(repo)) ?? {};
}

function patchTrailPushState(repo: string, patch: TrailPushState): void {
  writeJsonAtomic(trailPushStatePath(repo), { ...readTrailPushState(repo), ...patch });
}

/**
 * Record a push that reached Trail. Called by `graft trail push` itself, by hand
 * or in the background, once the digest is accepted — so "HEAD has moved since
 * the last push" is judged against the last push that actually landed. Never
 * throws: failing to remember a push must not fail the push.
 */
export function recordTrailPush(repo: string, head: string, now = Date.now()): void {
  if (!head || !linkStoredHere(repo)) return;
  try {
    patchTrailPushState(repo, { pushedHead: head, pushedAt: now });
  } catch {
    /* an unwritable .graft/ only means the next session may push once more */
  }
}

/**
 * Remember the suggestion count the session-start hook just read. Only for a
 * link saved here, like everything else in this file — for an env-only link
 * there is no git-ignored `.graft/` to keep it in, and such a checkout simply
 * hears about its suggestions every session. Never throws.
 */
export function recordSeenSuggestions(repo: string, count: number): void {
  if (!linkStoredHere(repo)) return;
  try {
    if (readTrailPushState(repo).seenSuggested !== count) patchTrailPushState(repo, { seenSuggested: count });
  } catch {
    /* at worst the same suggestions are mentioned once more */
  }
}

/**
 * Whether the link is saved in this checkout's `.graft/config.json`, rather than
 * only supplied by GRAFT_BRAIN_TOKEN / GRAFT_BRAIN_ID.
 *
 * The saved link is what made `.graft/` git-ignored (see writeLink), so it is
 * also what makes it safe to leave state and a log beside it. A link from the
 * environment is how CI attaches a trail without writing to the checkout, and
 * a background push is no business of a CI checkout's either.
 */
function linkStoredHere(repo: string): boolean {
  try {
    const b = readBuildConfig(repo)?.brain;
    return Boolean(b?.brainId && b?.token);
  } catch {
    return false;
  }
}

/** Why a background push did not start. `no_trail` is never reported — it is
 *  every repo without a trail, on every session — so it is not an event. */
export type AutopushSkip = "no_trail" | (typeof TRAIL_AUTOPUSH_SKIPS)[number];

export type AutopushDecision = { start: true; head: string } | { start: false; reason: AutopushSkip };

/** False when GRAFT_TRAIL_AUTOPUSH is `0`/`false`/`off`/`no`, or the repo's config says so. */
export function autopushEnabled(repo: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const v = (env.GRAFT_TRAIL_AUTOPUSH ?? "").trim().toLowerCase();
  if (["0", "false", "off", "no"].includes(v)) return false;
  try {
    return readBuildConfig(repo)?.trailAutoPush !== false;
  } catch {
    return true;
  }
}

/** HEAD's sha, or null when there is none (no git, no commits, a slow disk). */
export function gitHead(repo: string): string | null {
  try {
    const r = spawnSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 1500 });
    const out = typeof r.stdout === "string" ? r.stdout.trim() : "";
    return r.status === 0 && /^[0-9a-f]{7,64}$/.test(out) ? out : null;
  } catch {
    return null;
  }
}

/**
 * Whether to start a background push now. Pure but for what it is handed, so the
 * tests can walk every branch without git or a clock.
 *
 * A checkout with no push recorded at all counts as moved. Every trail attached
 * before this existed is in that state, and its last push is exactly as old as
 * the refresh exists to fix; the 24-hour stamp still holds it to one push.
 */
export function decideAutopush(input: {
  linked: boolean;
  enabled: boolean;
  head: string | null;
  state: TrailPushState;
  now: number;
}): AutopushDecision {
  if (!input.linked) return { start: false, reason: "no_trail" };
  if (!input.enabled) return { start: false, reason: "disabled" };
  if (!input.head) return { start: false, reason: "no_head" };
  const { state } = input;
  // Either push covers this HEAD: one that landed, or a background one already
  // started for it (which may still be running, or may have failed — in which
  // case the same history would fail the same way).
  if (input.head === state.pushedHead || input.head === state.autoPushHead) return { start: false, reason: "head_unchanged" };
  if (typeof state.autoPushAt === "number" && input.now - state.autoPushAt < AUTOPUSH_INTERVAL_MS) {
    return { start: false, reason: "throttled" };
  }
  return { start: true, head: input.head };
}

export interface AutopushDeps {
  env?: NodeJS.ProcessEnv;
  now?: number;
  head?: (repo: string) => string | null;
  /** Start the detached child; false when it could not be started. */
  start?: (repo: string) => boolean;
}

/**
 * The background push itself: `graft trail push <repo> --no-watch`, detached.
 *
 * `--no-watch` returns as soon as the digest is sent. The environment makes
 * sure nothing it runs can wait on a person: stdin is closed, stderr is a file
 * (so the push takes its no-terminal paths — no init picker, no spinner), git
 * and gh are told never to prompt, and AUTOPUSH_CHILD_ENV turns the sign-up
 * path, the only one that opens a browser, into a quiet exit.
 */
export function startBackgroundPush(repo: string): boolean {
  let fd: number | null = null;
  try {
    fd = openSync(trailPushLogPath(repo), "w");
    const child = spawn(process.execPath, [graftCliPath(), "trail", "push", repo, "--no-watch"], {
      cwd: repo,
      detached: true,
      stdio: ["ignore", fd, fd],
      windowsHide: true,
      env: { ...process.env, [AUTOPUSH_CHILD_ENV]: "1", GIT_TERMINAL_PROMPT: "0", GH_PROMPT_DISABLED: "1" },
    });
    child.on("error", () => undefined);
    child.unref();
    return true;
  } catch {
    return false;
  } finally {
    // The child holds its own copy of the descriptor.
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        /* already closed */
      }
    }
  }
}

/**
 * Decide, stamp, start, and record the event. Returns the decision; never
 * throws, because it runs inside a hook.
 */
export function maybeAutopush(repo: string, deps: AutopushDeps = {}): AutopushDecision {
  try {
    const env = deps.env ?? process.env;
    const now = deps.now ?? Date.now();
    const linked = readLink(repo) !== null && linkStoredHere(repo);
    // Nothing else is read — not even HEAD — for a repo without a trail.
    if (!linked) return { start: false, reason: "no_trail" };
    const enabled = autopushEnabled(repo, env);
    const head = enabled ? (deps.head ?? gitHead)(repo) : null;
    const state = readTrailPushState(repo);
    const decision = decideAutopush({ linked, enabled, head, state, now });
    if (!decision.start) {
      trackAutopush(repo, decision);
      return decision;
    }
    // Stamped first: a child that dies, or a second session opening in the same
    // second, must still count as this day's push.
    patchTrailPushState(repo, { autoPushAt: now, autoPushHead: decision.head });
    const started = (deps.start ?? startBackgroundPush)(repo);
    const out: AutopushDecision = started ? decision : { start: false, reason: "spawn_failed" };
    trackAutopush(repo, out);
    return out;
  } catch {
    return { start: false, reason: "spawn_failed" };
  }
}

/** The `trail_autopush` event: started, or skipped and why. */
function trackAutopush(repo: string, d: AutopushDecision): void {
  if (!d.start && d.reason === "no_trail") return;
  track("trail_autopush", d.start ? { outcome: "started" } : { outcome: "skipped", reason: d.reason }, { repo });
}
