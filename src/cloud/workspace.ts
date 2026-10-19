/**
 * The Trail workspace this machine is connected to, and the calls that talk
 * to it (trail-cloud's `/api/cli/…`).
 *
 * One connection per machine, not per repo: a person signs in once, through
 * the link their agent offers, and picks which of their repos the workspace
 * gets. It lives in `~/.trail/cloud.json` next to their notes, never in a
 * repo. Learnings themselves travel through git (`.trail/` is committed);
 * the workspace adds what one clone can't see: who is learning what across
 * the team's repos, how often a learning is reused, and the team page.
 *
 * Every call is bounded and never throws: a failure comes back as
 * `{ error }`, so a command still answers when Trail is unreachable.
 */
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { trailHome } from "../notes/home.js";
import { readJson, writeJsonAtomic } from "../util/state.js";

/** Trail's own front end and API. TRAIL_URL (or the older GRAFT_BRAIN_URL) moves it, for a local or self-hosted Trail. */
const DEFAULT_TRAIL_URL = "https://app.trailhq.com";

export function trailUrl(env: NodeJS.ProcessEnv = process.env): string {
  return (env.TRAIL_URL || env.GRAFT_BRAIN_URL || DEFAULT_TRAIL_URL).replace(/\/+$/, "");
}

export interface WorkspaceInfo {
  id: string;
  name: string;
  slug: string;
  url: string;
  invite_url: string;
}

export interface Cloud {
  /** The Trail it's connected to. */
  url: string;
  /** `trl_…`: this machine's token for the workspace. */
  token: string;
  user: { name: string; email: string };
  workspace: WorkspaceInfo;
  /** Repo keys in the workspace (`github.com/owner/name`), as of the last look. */
  repos: string[];
  linkedAt: number;
}

function cloudPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(trailHome(env), "cloud.json");
}

/** The connection, or null when this machine hasn't connected a workspace. */
export function readCloud(env: NodeJS.ProcessEnv = process.env): Cloud | null {
  const c = readJson<Cloud>(cloudPath(env));
  return c?.token && c.workspace?.slug ? c : null;
}

/**
 * Whether the workspace side of trail is on: the sign-in link at the end of a
 * reply, and `login`, `logout` and `workspace`. Committing `.trail/` already
 * shares learnings with a team, so it stays off until signing in gives more
 * than that. TRAIL_CLOUD=1 turns it on; a machine already connected keeps it.
 */
export function cloudEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.TRAIL_CLOUD === "1" || readCloud(env) !== null;
}

/** Owner-only: the file holds the workspace token. */
export const SECRET_FILE_MODE = 0o600;

export function writeCloud(c: Cloud, env: NodeJS.ProcessEnv = process.env): void {
  writeJsonAtomic(cloudPath(env), c, false, SECRET_FILE_MODE);
}

export function clearCloud(env: NodeJS.ProcessEnv = process.env): boolean {
  const p = cloudPath(env);
  if (!existsSync(p)) return false;
  rmSync(p, { force: true });
  return true;
}

/* -------------------------------------------------------------------------- */
/* calls                                                                      */
/* -------------------------------------------------------------------------- */

type Fetch = typeof fetch;

export interface ApiError {
  error: string;
  /** HTTP status, when Trail answered at all. */
  status?: number;
}

export function isError(x: unknown): x is ApiError {
  return typeof x === "object" && x !== null && typeof (x as ApiError).error === "string";
}

async function call<T>(
  base: string,
  method: "GET" | "POST" | "PUT",
  path: string,
  body: unknown,
  opts: { token?: string; timeoutMs?: number; fetchImpl?: Fetch } = {},
): Promise<{ status: number; body: T } | ApiError> {
  const f = opts.fetchImpl ?? fetch;
  try {
    const headers: Record<string, string> = { "content-type": "application/json", accept: "application/json" };
    if (opts.token) headers.authorization = `Bearer ${opts.token}`;
    const res = await f(`${base}${path}`, {
      method,
      headers,
      body: method === "GET" ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000),
    });
    const text = await res.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      /* not JSON */
    }
    if (!res.ok) {
      const msg = (json as { error?: unknown } | null)?.error;
      return { error: typeof msg === "string" ? msg : `Trail answered ${res.status}`, status: res.status };
    }
    return { status: res.status, body: json as T };
  } catch (err) {
    const timedOut = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
    return { error: timedOut ? "Trail didn't answer in time" : "couldn't reach Trail" };
  }
}

async function authed<T>(c: Cloud, method: "GET" | "POST" | "PUT", path: string, body: unknown, opts: { timeoutMs?: number; fetchImpl?: Fetch } = {}): Promise<T | ApiError> {
  const r = await call<T>(c.url, method, path, body, { ...opts, token: c.token });
  return isError(r) ? r : r.body;
}

/* sign-in handoff ----------------------------------------------------------- */

export interface HandoffRepo {
  key: string;
  name: string;
  learnings: number;
}

/**
 * Tell Trail about a sign-in link before anyone opens it: which repo the
 * agent was in, and every repo Trail knows on this machine, which is what the
 * workspace's repo picker lists. Names and counts only; no learning travels.
 */
export async function registerHandoff(
  base: string,
  req: { state: string; repo: { key: string; name: string } | null; repos: HandoffRepo[]; author: string },
  fetchImpl?: Fetch,
): Promise<{ url: string } | ApiError> {
  const r = await call<{ url: string }>(base, "POST", "/api/cli/handoffs", req, { fetchImpl });
  return isError(r) ? r : r.body;
}

export type ClaimResult =
  | { cloud: Omit<Cloud, "url" | "linkedAt"> }
  | { pending: true }
  | { error: string; reason: "expired" | "unsupported" };

/** Ask once whether the person finished in the browser. A network or server error counts as "not yet". */
export async function claimHandoff(base: string, state: string, fetchImpl?: Fetch): Promise<ClaimResult> {
  const r = await call<{ token?: string; user?: Cloud["user"]; workspace?: WorkspaceInfo; repos?: string[]; pending?: boolean }>(
    base,
    "POST",
    "/api/cli/handoffs/claim",
    { state },
    { fetchImpl, timeoutMs: 10_000 },
  );
  if (isError(r)) {
    if (r.status === 410) return { error: "that sign-in link was already used or has expired", reason: "expired" };
    if (r.status === 404 || r.status === 405) return { error: "this Trail doesn't take sign-ins from the CLI yet", reason: "unsupported" };
    return { pending: true };
  }
  const b = r.body;
  if (r.status === 200 && b?.token && b.workspace?.slug) {
    return { cloud: { token: b.token, user: b.user ?? { name: "", email: "" }, workspace: b.workspace, repos: b.repos ?? [] } };
  }
  return { pending: true };
}

/* the workspace ------------------------------------------------------------- */

export interface WorkspaceRepo {
  key: string;
  name: string;
  learnings: number;
  added_by: string;
}

export interface Me {
  user: Cloud["user"];
  workspace: WorkspaceInfo;
  repos: WorkspaceRepo[];
}

export function fetchMe(c: Cloud, fetchImpl?: Fetch): Promise<Me | ApiError> {
  return authed<Me>(c, "GET", "/api/cli/me", undefined, { fetchImpl });
}

export function addRepo(c: Cloud, repo: { key: string; name: string }, fetchImpl?: Fetch): Promise<{ repos: WorkspaceRepo[] } | ApiError> {
  return authed<{ repos: WorkspaceRepo[] }>(c, "POST", "/api/cli/repos", repo, { fetchImpl });
}

export interface UploadedLearning {
  /** `.trail/learnings/<name>`. */
  path: string;
  /** "" for the working tree, or the pushed branch it was found on (`origin/kumar/x`). */
  ref: string;
  branch?: string;
  title: string;
  author: string;
  date: string;
  minutes?: number;
  tokens?: number;
  touches: string[];
  body: string;
  hash: string;
}

export function uploadLearnings(
  c: Cloud,
  req: { repo: { key: string; name: string }; learnings: UploadedLearning[] },
  fetchImpl?: Fetch,
): Promise<{ repo: string; learnings: number; added: number } | ApiError> {
  return authed(c, "PUT", "/api/cli/learnings", req, { timeoutMs: 60_000, fetchImpl });
}

/** One use of the learnings: a search that showed some, or a check against them. */
export interface ActivityEvent {
  repo: string;
  kind: "search" | "check";
  asker: string;
  session: string;
  query: string;
  files: string[];
  /** File names of the learnings it showed. */
  shown_paths: string[];
  shown_authors: string[];
  at: string;
}

export function postActivity(c: Cloud, events: ActivityEvent[], fetchImpl?: Fetch): Promise<{ stored: number } | ApiError> {
  return authed(c, "POST", "/api/cli/activity", { events }, { fetchImpl });
}

export interface TeamView {
  workspace: string;
  repo: string;
  days: number;
  people: number;
  sessions: number;
  new_learnings: number;
  reused: number;
  members: Array<{ name: string; topics: string[]; learnings: number; reused: number }>;
  overlaps: Array<{ kind: string; text: string }>;
  url?: string;
}

export function fetchTeam(c: Cloud, opts: { repo?: string; days?: number } = {}, fetchImpl?: Fetch): Promise<TeamView | ApiError> {
  const q = new URLSearchParams({ days: String(opts.days ?? 7) });
  if (opts.repo) q.set("repo", opts.repo);
  return authed<TeamView>(c, "GET", `/api/cli/team?${q.toString()}`, undefined, { fetchImpl });
}
