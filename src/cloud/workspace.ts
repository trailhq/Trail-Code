/**
 * The Trail workspace this machine is connected to, and the calls that talk
 * to it (trail-cloud's `/api/cli/…`).
 *
 * One connection per workspace, and a laptop can hold several: a person signs
 * in through the link their agent offers and picks the workspace a repo goes
 * to, so a client's repo and the company's can go to different teams. Each
 * repo goes to one workspace on this machine, the newest link that has it.
 * The connections live in `~/.trail/cloud.json` next to their notes, never in
 * a repo. Learnings themselves travel through git (`.trail/` is committed);
 * the workspace adds what one clone can't see: who is learning what across
 * the team's repos, how often a learning is reused, and the team page.
 *
 * Every call is bounded and never throws: a failure comes back as
 * `{ error }`, so a command still answers when Trail is unreachable.
 */
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { trailHome } from "../notes/home.js";
import { telemetryOn } from "../telemetry/gate.js";
import { ensurePrivateDir, PRIVATE_FILE_MODE } from "../util/private-file.js";
import { readJson, writeJsonAtomic } from "../util/state.js";

/** Trail's own front end and API: Trail cloud, which serves the CLI routes at team.trailhq.com. */
export const DEFAULT_TRAIL_URL = "https://team.trailhq.com";

/**
 * TEST ONLY. Points sign-in at a stand-in Trail, for tests and local demos.
 * Taken only for a host on this machine (localhost, 127.0.0.1, [::1]) or a
 * `.test` one, which nothing on the internet answers, so an export left in a
 * shell can't send a sign-in, and the learnings uploaded after it, anywhere
 * else. Never documented for users: a self-hosted Trail is `trail login
 * --server <url>`, which the link itself carries.
 */
export const TEST_SERVER_ENV = "TRAIL_TEST_SERVER";

/** `url` as a server address (http or https, no trailing slash), or null when it isn't one. */
export function serverUrl(url: string | undefined): string | null {
  const t = url?.trim().replace(/\/+$/, "");
  if (!t || !/^https?:\/\//i.test(t)) return null;
  try {
    new URL(t);
    return t;
  } catch {
    return null;
  }
}

/** Whether `url` is on this machine (localhost, 127.0.0.1, [::1], *.localhost) or a `.test` host nothing on the internet answers. */
export function isLocalServer(url: string): boolean {
  const host = new URL(url).hostname.toLowerCase();
  return host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host.endsWith(".localhost") || host.endsWith(".test");
}

function testServer(env: NodeJS.ProcessEnv): string | null {
  const url = serverUrl(env[TEST_SERVER_ENV]);
  return url && isLocalServer(url) ? url : null;
}

/** The Trail `init --connect` or `--pair` was told with `--server`, for the rest of this process. */
let runServer: string | null = null;

/**
 * Where a sign-in goes when nothing chose otherwise: Trail cloud. The
 * connection then keeps the address it signed in at in cloud.json, and every
 * later call goes there. No variable a shell might still export moves it
 * (TRAIL_URL, or GRAFT_BRAIN_URL for the old brain API): a self-hosted Trail
 * comes from `trail login --server`, saved on the link, or from `--server`
 * on `init --connect` and `--pair` for that run (`useServer`); tests use
 * TEST_SERVER_ENV.
 */
export function trailUrl(env: NodeJS.ProcessEnv = process.env): string {
  return runServer ?? testServer(env) ?? DEFAULT_TRAIL_URL;
}

/**
 * `--server <url>` on `init --connect` and `--pair` (and the `_trail-pair`
 * child they start): the Trail that gave the code, for every call this
 * process makes. Set by the command line, never read from the environment;
 * null puts it back to Trail cloud.
 */
export function useServer(url: string | null): void {
  runServer = url;
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
  /**
   * `connect`: connected by `trail init --connect <code>` from the onboarding
   * on the web. Such a machine sends a repo summary (titles, counts, names)
   * and never the full learnings sync, so it's never asked to add repos.
   */
  via?: "connect";
}

function cloudPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(trailHome(env), "cloud.json");
}

/**
 * What `cloud.json` holds: the newest connection at the top level, so an older
 * trail still reads it as the machine's one connection (and keeps `others` when
 * it writes that one back), and the rest under `others`.
 */
type StoredClouds = Cloud & { others?: unknown[] };

/** A file edited by hand, or cut short, is no connection: every caller reads the address and the token. */
function validCloud(c: unknown): c is Cloud {
  const x = c as Cloud | null;
  return !!x && typeof x === "object" && typeof x.token === "string" && !!x.token && typeof x.url === "string" && !!serverUrl(x.url) && !!x.workspace?.slug && Array.isArray(x.repos);
}

/** Every workspace this machine is connected to, the newest link first. */
export function readClouds(env: NodeJS.ProcessEnv = process.env): Cloud[] {
  const raw = readJson<StoredClouds>(cloudPath(env));
  if (!raw || typeof raw !== "object") return [];
  const { others, ...first } = raw;
  const all = [first, ...(Array.isArray(others) ? others : [])].filter(validCloud);
  return all.sort((a, b) => (b.linkedAt || 0) - (a.linkedAt || 0));
}

/** The newest connection, or null when this machine hasn't connected a workspace. For what isn't about one repo. */
export function readCloud(env: NodeJS.ProcessEnv = process.env): Cloud | null {
  return readClouds(env)[0] ?? null;
}

/** The connection among `clouds` that a repo's learnings and uses go to: the newest whose workspace has it. */
export function cloudIn(clouds: Cloud[], repoKey: string): Cloud | null {
  return clouds.find((c) => c.repos.includes(repoKey)) ?? null;
}

/** The connection a repo's learnings and uses go to, or null when no workspace on this machine has it. */
export function cloudForRepo(repoKey: string, env: NodeJS.ProcessEnv = process.env): Cloud | null {
  return cloudIn(readClouds(env), repoKey);
}

/** Whether two connections are to the same workspace: by its id, which a new address for the same Trail keeps. */
export function sameWorkspace(a: Cloud, b: Cloud): boolean {
  if (a.workspace.id && b.workspace.id) return a.workspace.id === b.workspace.id;
  return a.url === b.url && a.workspace.slug === b.workspace.slug;
}

/**
 * Whether the workspace side of trail is on: the sign-in link at the end of a
 * reply, and `logout` and `workspace`. On by default, so people find
 * team.trailhq.com from the session they're in. Off wherever telemetry is off
 * (DO_NOT_TRACK, CI, `trail telemetry disable`, a build with no key): the
 * link's background wait tells team.trailhq.com this repo's name before anyone
 * clicks. TRAIL_CLOUD=0 turns it off, TRAIL_CLOUD=1 on; a machine already
 * connected keeps it.
 */
export function cloudEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.TRAIL_CLOUD === "1" || readCloud(env) !== null) return true;
  return env.TRAIL_CLOUD !== "0" && telemetryOn(undefined, env);
}

/** Owner-only: the file holds the workspace token. */
export const SECRET_FILE_MODE = PRIVATE_FILE_MODE;

/**
 * Save one connection, in place of the one to the same workspace. Owner-only,
 * in an owner-only folder: the file holds the workspace tokens.
 */
export function writeCloud(c: Cloud, env: NodeJS.ProcessEnv = process.env): void {
  storeClouds([c, ...readClouds(env).filter((x) => !sameWorkspace(x, c))], env);
}

function storeClouds(list: Cloud[], env: NodeJS.ProcessEnv): void {
  const [first, ...others] = [...list].sort((a, b) => (b.linkedAt || 0) - (a.linkedAt || 0));
  ensurePrivateDir(trailHome(env));
  writeJsonAtomic(cloudPath(env), others.length ? { ...first, others } : first, false, SECRET_FILE_MODE);
}

/** Forget every connection, or only the one to `workspace` (its slug). False when there was nothing to forget. */
export function clearCloud(env: NodeJS.ProcessEnv = process.env, workspace?: string): boolean {
  const p = cloudPath(env);
  if (!existsSync(p)) return false;
  const all = readClouds(env);
  const keep = workspace === undefined ? [] : all.filter((c) => c.workspace.slug !== workspace);
  if (workspace !== undefined && keep.length === all.length) return false;
  if (keep.length) storeClouds(keep, env);
  else rmSync(p, { force: true });
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
 * Tell Trail about a sign-in link before anyone opens it: the repo the agent
 * was in, which is what the workspace's repo picker lists. Its name and
 * learning count only; no learning, no other repo and no person's name travels.
 */
export async function registerHandoff(
  base: string,
  req: { state: string; repo: { key: string; name: string } | null; repos: HandoffRepo[]; author: string; pair?: string },
  fetchImpl?: Fetch,
): Promise<{ url: string; features?: string[] } | ApiError> {
  const r = await call<{ url: string; features?: string[] }>(base, "POST", "/api/cli/handoffs", req, { fetchImpl });
  return isError(r) ? r : r.body;
}

/**
 * Report how a `trail init --pair` run is going, for the onboarding page that
 * shows it live. "reviewed" once the person has kept or dropped what it found
 * (Trail takes no more), "gone" when the link expired or Trail doesn't know it.
 */
export async function postHandoffProgress(base: string, body: { state: string } & Record<string, unknown>, fetchImpl?: Fetch): Promise<"ok" | "reviewed" | "gone" | "error"> {
  const r = await call(base, "POST", "/api/cli/handoffs/progress", body, { fetchImpl, timeoutMs: 15_000 });
  if (!isError(r)) return "ok";
  if (r.status === 409) return "reviewed";
  if (r.status === 404 || r.status === 410) return "gone";
  return "error";
}

/** Why a setup stopped, as Trail's page explains it. */
export type SetupFailure = "home_folder" | "not_git" | "bad_agents" | "crashed";

/**
 * Tell the page waiting on pair code `code` why init stopped before it
 * registered a run. Best effort: init is stopping either way.
 */
export async function failPair(base: string, code: string, reason: SetupFailure, fetchImpl?: Fetch): Promise<void> {
  await call(base, "POST", "/api/cli/pairs/fail", { pair: code.trim().toUpperCase(), reason }, { fetchImpl, timeoutMs: 5_000 });
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

/**
 * Trade a one-time sign-in code, made for this person on Trail's web app, for
 * this laptop's token. No browser step: the code already says who and which
 * workspace. A code that's used or past its minutes is refused for good.
 */
export async function claimLoginCode(base: string, code: string, fetchImpl?: Fetch): Promise<Exclude<ClaimResult, { pending: true }> | { error: string; reason: "offline" | "invalid" }> {
  const r = await call<{ token?: string; user?: Cloud["user"]; workspace?: WorkspaceInfo; repos?: string[] }>(
    base,
    "POST",
    "/api/cli/login-codes/claim",
    { code },
    { fetchImpl, timeoutMs: 15_000 },
  );
  if (isError(r)) {
    if (r.status === 410) return { error: "that sign-in code was already used or has expired · copy a new one from the Trail page", reason: "expired" };
    if (r.status === 400) return { error: "that isn't a Trail sign-in code · they look like TRL-ABCD-EFGH-IJKL-MNOP", reason: "invalid" };
    if (r.status === 404 || r.status === 405) return { error: "this Trail doesn't take sign-in codes yet", reason: "unsupported" };
    return { error: `couldn't reach Trail (${r.error})`, reason: "offline" };
  }
  const b = r.body;
  if (b?.token && b.workspace?.slug) return { cloud: { token: b.token, user: b.user ?? { name: "", email: "" }, workspace: b.workspace, repos: b.repos ?? [] } };
  return { error: "Trail sent an answer trail couldn't read", reason: "offline" };
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

/** The laptop's other repos, by name only, for the onboarding page to offer. */
export function sendMachineRepos(c: Cloud, state: string, repos: { key: string; name: string; last_used?: string; sessions: number }[], fetchImpl?: Fetch): Promise<object | ApiError> {
  return authed<object>(c, "POST", "/api/cli/handoffs/repos", { state, repos }, { fetchImpl });
}

/** Which of them the person picked: null until they choose. */
export function fetchMachinePicks(c: Cloud, state: string, fetchImpl?: Fetch): Promise<{ picks: string[] | null } | ApiError> {
  return authed<{ picks: string[] | null }>(c, "POST", "/api/cli/handoffs/picks", { state }, { fetchImpl });
}

/** How setting up one picked repo is going, for the page. */
export function postRepoSetup(c: Cloud, state: string, key: string, status: "setting_up" | "done" | "failed", learnings = 0, fetchImpl?: Fetch): Promise<object | ApiError> {
  return authed<object>(c, "POST", "/api/cli/handoffs/repos/status", { state, key, status, learnings }, { fetchImpl });
}

export interface UploadedLearning {
  /** `.trail/learnings/<name>`, or `.claude/skills/<name>/SKILL.md` for a skill. */
  path: string;
  /** "skill" for a skill of the repo; a plain learning leaves it out. */
  kind?: "skill";
  /** "" when committed at HEAD, or the pushed branch it was found on (`origin/kumar/x`). */
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
  /** A skill's description: what it does and when to use it. */
  why?: string;
  /** A skill's other files: everything git tracks in its folder besides SKILL.md. */
  files?: SkillFileUpload[];
}

export interface SkillFileUpload {
  /** Relative to the skill's folder: `references/forms.md`, `scripts/fill.py`. */
  path: string;
  /** The file as text, or base64 when `encoding` says so. */
  content: string;
  encoding?: "base64";
  executable?: boolean;
}

/** Most of one upload request: skills bring their folders, so a big set goes up in parts. */
export const UPLOAD_PART_BYTES = 12 * 1024 * 1024;

export async function uploadLearnings(
  c: Cloud,
  // removed: HEAD paths gone since the last sync on the same branch. held: how many were left out for a secret.
  req: { repo: { key: string; name: string }; learnings: UploadedLearning[]; removed?: string[]; held?: number },
  fetchImpl?: Fetch,
): Promise<{ repo: string; learnings: number; added: number } | ApiError> {
  const parts: UploadedLearning[][] = [[]];
  let bytes = 0;
  for (const l of req.learnings) {
    const size = JSON.stringify(l).length;
    if (bytes + size > UPLOAD_PART_BYTES && parts.at(-1)!.length) {
      parts.push([]);
      bytes = 0;
    }
    parts.at(-1)!.push(l);
    bytes += size;
  }
  let added = 0;
  let last: { repo: string; learnings: number; added: number } | ApiError | null = null;
  for (const learnings of parts) {
    last = await authed<{ repo: string; learnings: number; added: number }>(c, "PUT", "/api/cli/learnings", { ...req, learnings }, { timeoutMs: 60_000, fetchImpl });
    if (isError(last)) return last;
    added += last.added;
  }
  return { ...last!, added };
}

/**
 * One use of the learnings: a search that showed some, a check against them,
 * or a coding agent using one of the repo's skills. Counts and which
 * learnings, never content: no query (for the prompt hook that is the
 * person's prompt), no file paths and no task.
 */
export interface ActivityEvent {
  repo: string;
  kind: "search" | "check" | "skill";
  /** For a skill use: the skill's folder name under `.claude/skills/`. */
  skill?: string;
  asker: string;
  session: string;
  /** How many files the answer pointed into, or the check covered. */
  file_count: number;
  /** File names of the learnings it showed: the name is what the workspace knows a learning by. */
  shown_paths: string[];
  shown_authors: string[];
  /** Tokens the map saved on this lookup (what `ask` prints as "tokens saved"); absent when unknown. */
  saved_tokens?: number;
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

/* shared sessions: the Trail team's own -------------------------------------- */

/**
 * Whether this workspace may send Trail a whole Claude Code session: only the
 * Trail team's own, which trail-cloud decides. An error when Trail couldn't
 * answer, or doesn't take sessions yet.
 */
export async function shareAllowed(c: Cloud, fetchImpl?: Fetch): Promise<boolean | ApiError> {
  const r = await authed<{ ok?: boolean }>(c, "GET", "/api/cli/shared-sessions/allowed", undefined, { fetchImpl, timeoutMs: 10_000 });
  if (!isError(r)) return r?.ok === true;
  if (r.status === 403) return false;
  if (r.status === 401) return { error: `this laptop's sign-in to ${c.workspace.name} has ended · run trail login`, status: 401 };
  if (r.status === 404 || r.status === 405) return { error: "this Trail doesn't take shared sessions yet", status: r.status };
  return r;
}

export interface SharedSession {
  session_id: string;
  /** `github.com/owner/name`, or "" outside a repo with a remote. */
  repo: string;
  trail_version: string;
  title: string;
  messages: number;
  subagents: number;
  /** The redacted JSONL's size before zipping. */
  bytes: number;
  /** How many secrets were taken out on this laptop. */
  redacted: number;
  /** The redacted JSONL, gzipped, in base64. */
  transcript_gz: string;
}

export function shareSession(c: Cloud, body: SharedSession, fetchImpl?: Fetch): Promise<{ id: string; gz_bytes: number } | ApiError> {
  return authed(c, "POST", "/api/cli/shared-sessions", body, { fetchImpl, timeoutMs: 120_000 });
}

export function fetchTeam(c: Cloud, opts: { repo?: string; days?: number } = {}, fetchImpl?: Fetch): Promise<TeamView | ApiError> {
  const q = new URLSearchParams({ days: String(opts.days ?? 7) });
  if (opts.repo) q.set("repo", opts.repo);
  return authed<TeamView>(c, "GET", `/api/cli/team?${q.toString()}`, undefined, { fetchImpl });
}
