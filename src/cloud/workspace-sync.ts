/**
 * Keeps the workspace's copy of a repo's learnings, and its record of how
 * they're used, in step with this machine.
 *
 * What goes up for a repo in the workspace is every learning in its `.trail/`
 * that git has: the ones committed at HEAD and the ones on teammates' pushed
 * branches, after a `git fetch`. Never an uncommitted edit or an untracked
 * file. Not just this person's, so one person is enough to cover a repo.
 * Personal learnings in ~/.trail never go up.
 *
 * Uses (a search that showed learnings, a check against them) are appended to
 * `~/.trail/outbox.jsonl` as they happen, and sent with the next sync. That's
 * how a teammate's reuse of a learning shows on the team page. A use is counts
 * and the names of the learnings shown: never what someone typed, never the
 * files they're in. And only names the workspace already has: a learning's
 * file name carries the first words of its title, so a personal learning, or
 * one git doesn't have yet, is left out. Only while the machine is connected,
 * and only for a repo in the workspace: nobody agreed to send even that for a
 * repo they didn't pick, or from before they signed in.
 *
 * Commands never wait on any of this: when something changed, a detached
 * `_trail-sync` child does it.
 */
import { createHash } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync } from "node:fs";
import { basename, join, relative, sep } from "node:path";
import { isUtf8 } from "node:buffer";
import { graftCliPath } from "../claude/paths.js";
import { readBranchCache, refreshBranches } from "../notes/branches.js";
import { knownRepos, repoName, repoPlace, trailHome } from "../notes/home.js";
import { LEARNINGS_DIR, learningFiles, readLearningFile } from "../notes/repo-trail.js";
import { parseNote, type Note } from "../notes/notes.js";
import { liveLearnings } from "../notes/learning-fields.js";
import { secretReason } from "../notes/secrets.js";
import { OWN_SKILLS, skillDirs } from "../skills/skills.js";
import { matter } from "../util/front-matter.js";
import { appendPrivateFile, ensurePrivateDir, PRIVATE_FILE_MODE, writePrivateFile } from "../util/private-file.js";
import { cacheDir, readJson, writeJsonAtomic } from "../util/state.js";
import { headLearnings } from "./head-learnings.js";
import { isError, postActivity, readCloud, uploadLearnings, type ActivityEvent, type ApiError, type Cloud, type SkillFileUpload, type UploadedLearning } from "./workspace.js";

/** A failed sync is retried after this long, not on every command. */
const RETRY_MS = 5 * 60 * 1000;
/** The outbox is trimmed to its newest lines past this size. */
const OUTBOX_MAX_BYTES = 1024 * 1024;
const OUTBOX_KEEP_LINES = 2000;

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** A learning that stays off the workspace, and why, for `trail workspace` to name. */
export interface LeftOut {
  /** Its file name in `.trail/learnings/`. */
  name: string;
  /** "" when committed at HEAD, else the pushed branch it's on. */
  ref: string;
  /** What `secretReason` saw: "an API key", "a password in a URL". Never the secret. */
  why: string;
}

/** A skill folder name safe to send as a path part. */
const SKILL_FOLDER = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function inside(root: string, p: string): boolean {
  return p === root || p.startsWith(root + sep);
}

/** A SKILL.md bigger than this is not a skill, and is never sent. */
const SKILL_MAX_BYTES = 256 * 1024;
/** What Trail keeps of a skill's folder besides SKILL.md (the server's limits too). */
const SKILL_FILES_MAX = 100;
const SKILL_FILE_MAX_BYTES = 1024 * 1024;
const SKILL_FOLDER_MAX_BYTES = 4 * 1024 * 1024;
/** Never part of a skill, though a folder may hold them. */
const NOT_SKILL_FILE = /(^|\/)(node_modules|__pycache__|\.git|\.venv)(\/|$)|(^|\/)\.DS_Store$|\.(map|pyc)$/;

/**
 * The files git tracks in a skill's folder besides SKILL.md, as they go up:
 * text as is, anything else as base64, the executable bit kept. A file that
 * resolves outside the checkout, or is too big, stays behind; so do the
 * ones past the folder's limits, smallest paths first.
 */
function skillFolderFiles(root: string, folder: string): SkillFileUpload[] {
  let rel: string;
  try {
    rel = relative(root, realpathSync(folder)).split(sep).join("/");
  } catch {
    return [];
  }
  const out: SkillFileUpload[] = [];
  let total = 0;
  for (const path of [...trackedAmong(root, [rel + "/"])].sort()) {
    const inner = path.slice(rel.length + 1);
    if (!inner || inner === "SKILL.md" || NOT_SKILL_FILE.test(inner) || out.length === SKILL_FILES_MAX) continue;
    try {
      const file = join(root, ...path.split("/"));
      const st = statSync(file);
      if (!st.isFile() || st.size > SKILL_FILE_MAX_BYTES || total + st.size > SKILL_FOLDER_MAX_BYTES) continue;
      if (!inside(root, realpathSync(file))) continue;
      const bytes = readFileSync(file);
      const text = !bytes.includes(0) && isUtf8(bytes);
      total += bytes.length;
      out.push({
        path: inner,
        content: text ? bytes.toString("utf8") : bytes.toString("base64"),
        ...(text ? {} : { encoding: "base64" as const }),
        ...(st.mode & 0o111 ? { executable: true } : {}),
      });
    } catch {
      /* gone, or can't be read */
    }
  }
  return out;
}

/** `cut-a-release` → `Cut a release`: a skill's folder name as a title. */
function skillTitle(name: string): string {
  const words = name.replace(/[-_]+/g, " ").trim();
  return words ? words[0]!.toUpperCase() + words.slice(1) : name;
}

/**
 * Which of `paths` (relative to `root`) git tracks, by what `git ls-files` says,
 * so a gitignored or untracked file is not among them. Empty when `root` isn't a
 * git checkout or git fails: no skill goes up then.
 */
function trackedAmong(root: string, paths: string[]): Set<string> {
  if (paths.length === 0) return new Set();
  try {
    const out = execFileSync("git", ["--literal-pathspecs", "ls-files", "-z", "--", ...paths], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 15_000,
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true,
    });
    return new Set(out.split("\0").filter(Boolean));
  } catch {
    return new Set();
  }
}

/**
 * The repo's skills, as the workspace takes them: each `.claude/skills/<name>/SKILL.md`
 * in the working tree that git tracks (an untracked or gitignored one isn't the
 * team's, so it stays here; no git, no skills). Same item as the one init sends
 * for a skill it just found (the server keeps one per repo and path): the body is
 * SKILL.md without its frontmatter, the hash is of the whole file. A symlinked
 * skill is read only when it resolves inside the checkout, and goes up when the
 * file it resolves to is tracked. A SKILL.md that can't be read or parsed, or is
 * over 256 KB, is skipped. Skills kept in ~/.trail are never sent.
 */
function skillItems(checkout: string): UploadedLearning[] {
  const dir = skillDirs(checkout).repo;
  let root: string;
  let names: string[];
  try {
    root = realpathSync(join(dir, "..", ".."));
    names = readdirSync(dir).sort();
  } catch {
    return [];
  }
  // Each candidate that passes the cheap checks, with where its file really is.
  const candidates: Array<{ name: string; file: string; real: string }> = [];
  for (const name of names) {
    if (!SKILL_FOLDER.test(name) || OWN_SKILLS.has(name)) continue;
    try {
      const file = join(dir, name, "SKILL.md");
      if (!statSync(join(dir, name)).isDirectory()) continue;
      const st = statSync(file);
      if (!st.isFile() || st.size > SKILL_MAX_BYTES) continue;
      const real = realpathSync(file);
      if (!inside(root, realpathSync(join(dir, name))) || !inside(root, real)) continue;
      candidates.push({ name, file, real: relative(root, real).split(sep).join("/") });
    } catch {
      /* no SKILL.md here */
    }
  }
  const tracked = trackedAmong(root, [...new Set(candidates.map((c) => c.real))]);
  const out: UploadedLearning[] = [];
  for (const { name, file, real } of candidates) {
    if (!tracked.has(real)) continue;
    try {
      const text = readFileSync(file, "utf8");
      const parsed = matter(text);
      const d = parsed.data as Record<string, unknown>;
      const description = typeof d.description === "string" ? d.description.trim().replace(/\s+/g, " ") : "";
      const files = skillFolderFiles(root, join(dir, name));
      out.push({
        path: `.claude/skills/${name}/SKILL.md`,
        kind: "skill",
        ref: "",
        title: skillTitle(typeof d.name === "string" && d.name.trim() ? d.name.trim() : name),
        why: description,
        author: typeof d.author === "string" ? d.author.trim() : "",
        date: "",
        touches: [],
        body: parsed.content.trim(),
        // The whole folder: any file changing sends the skill again.
        hash: sha256(JSON.stringify(["folder", text, files.map((f) => [f.path, sha256(f.content), !!f.executable])])),
        files,
      });
    } catch {
      /* a SKILL.md that can't be read or parsed */
    }
  }
  return out;
}

/**
 * Every live learning in the repo's `.trail/`, as the workspace takes them:
 * the ones committed at HEAD, then the ones only a pushed branch has (from
 * the branch cache), then the repo's skills that git tracks (`skillItems`).
 * Never the working tree's learnings: an uncommitted or untracked learning
 * stays on this machine. Paths are repo-relative; nothing about this
 * machine is sent. Null when git couldn't read HEAD: then nothing may go up,
 * since a set without HEAD's learnings would tell the workspace they're gone.
 *
 * Live means what recall reads (`liveLearnings`): a retired, held or replaced
 * learning stays behind, so the team page never shows one nobody is meant to
 * follow. A learning on an unmerged branch replaces nothing yet.
 *
 * A learning or skill whose text holds a secret (`secretReason`) stays behind, every
 * copy of it: what a sync sent is what vouches for a learning's name in a
 * use, so its name never goes up either. It is listed in `leftOut`, so
 * `trail workspace` can say so instead of it going missing in silence.
 *
 * `tree`: the working tree's learnings in place of HEAD's, for `init --pair`'s
 * review page only, which shows the person what init just wrote before any of
 * it is committed. A sync never reads them.
 */
export function workspaceLearnings(checkout: string, opts: { tree?: boolean } = {}): { learnings: UploadedLearning[]; leftOut: LeftOut[] } | null {
  const head = opts.tree ? treeLearnings(checkout) : headLearnings(checkout);
  if (!head) return null;
  const read: Array<Note & { text: string }> = [];
  const leftOut: LeftOut[] = [];
  const seen = new Set<string>();
  const add = (name: string, text: string, ref: string) => {
    if (seen.has(name)) return;
    const why = secretReason(text);
    if (why) {
      seen.add(name);
      leftOut.push({ name, ref, why });
      return;
    }
    const n = parseNote(text, name);
    if (!n) return;
    seen.add(name);
    read.push({ ...n, scope: "repo", ...(ref ? { ref } : {}), text });
  };
  for (const l of head) add(l.name, l.text, "");
  for (const b of readBranchCache(checkout)?.branches ?? []) for (const l of b.learnings) add(l.name, l.text, b.ref);
  const learnings: UploadedLearning[] = liveLearnings(read).map((n) => ({
    path: `${LEARNINGS_DIR}/${n.path}`,
    ref: n.ref ?? "",
    branch: n.branch,
    title: n.title,
    author: n.author,
    date: n.date,
    minutes: n.cost?.minutes,
    tokens: n.cost?.tokens,
    touches: n.touches,
    body: n.body,
    hash: sha256(n.text),
  }));
  // A skill whose text holds a secret stays behind too, named like a learning is.
  for (const skill of skillItems(checkout)) {
    const texts = (skill.files ?? []).filter((f) => !f.encoding).map((f) => f.content);
    const why = secretReason([skill.title, skill.why ?? "", skill.body, ...texts].join("\n"));
    if (why) leftOut.push({ name: skill.path, ref: "", why });
    else learnings.push(skill);
  }
  return { learnings, leftOut };
}

/** The working tree's `.trail/learnings/` files, as `headLearnings` gives HEAD's. */
function treeLearnings(checkout: string): Array<{ name: string; text: string }> {
  const out: Array<{ name: string; text: string }> = [];
  for (const name of learningFiles(checkout)) {
    const text = readLearningFile(checkout, name);
    if (text) out.push({ name, text });
  }
  return out;
}

/**
 * What `init --pair` hands its review page: the working tree's live learnings
 * (what the person's agents start from, the ones init just wrote among them),
 * teammates' pushed ones and the repo's tracked skills, secrets left out.
 */
export function reviewPayload(checkout: string): UploadedLearning[] {
  return workspaceLearnings(checkout, { tree: true })?.learnings ?? [];
}

/** The learnings a sync uploads: `workspaceLearnings` without what it left out. Null when git couldn't read HEAD. */
export function learningsPayload(checkout: string): UploadedLearning[] | null {
  return workspaceLearnings(checkout)?.learnings ?? null;
}

function fingerprint(learnings: UploadedLearning[]): string {
  return sha256(JSON.stringify(learnings.map((l) => [l.path, l.hash]).sort()));
}

interface SyncState {
  fingerprint: string;
  at: number;
  failedAt?: number;
  learnings?: number;
  /** HEAD's paths (learnings and skills) the last sync sent, and the branch it was on. */
  paths?: string[];
  branch?: string;
}

/** The checkout's branch, or "" when git can't say (detached HEAD, no git). */
function currentBranch(checkout: string): string {
  try {
    const b = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: checkout, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5000, windowsHide: true }).trim();
    return b === "HEAD" ? "" : b;
  } catch {
    return "";
  }
}

function statePath(repo: string): string {
  return join(cacheDir(repo), "trail-workspace-sync.json");
}

/**
 * Whether the repo at `checkout` is one of the workspace's, so its learnings
 * and uses go up. Never on a machine connected by `trail init --connect`: that
 * one sends a repo summary only (titles and counts, no learning bodies, no
 * searches), whatever repos the workspace lists.
 */
export function inWorkspace(checkout: string, cloud: Cloud | null = readCloud()): boolean {
  return !!cloud && cloud.via !== "connect" && cloud.repos.includes(repoPlace(checkout).key);
}

/**
 * Upload the repo's learnings now, after fetching teammates' branches. Only for
 * a repo in the workspace. Remembers what was sent so an unchanged repo isn't
 * sent again. When git can't read HEAD nothing is sent and the sync counts as
 * failed, so it's tried again later.
 *
 * A learning or skill HEAD had at the last sync on this same branch, and no
 * longer has (deleted, or now left out for a secret), is sent as removed, so
 * it comes down from the web. On another branch a missing file says nothing,
 * so switching branches never takes anything down.
 */
export async function syncRepo(
  checkout: string,
  cloud: Cloud,
  opts: { fetch?: boolean; fetchImpl?: typeof fetch } = {},
): Promise<{ repo: string; learnings: number; added: number } | ApiError> {
  const place = repoPlace(checkout);
  if (!cloud.repos.includes(place.key)) return { error: "this repo isn't in your workspace" };
  if (opts.fetch !== false) refreshBranches(place.checkout);
  const found = workspaceLearnings(place.checkout);
  const learnings = found?.learnings ?? null;
  const prior = readJson<SyncState>(statePath(place.checkout));
  const branch = currentBranch(place.checkout);
  const paths = (learnings ?? []).filter((l) => l.ref === "").map((l) => l.path);
  const here = new Set(paths);
  const removed = branch && prior?.branch === branch ? (prior.paths ?? []).filter((p) => !here.has(p)) : [];
  const held = found?.leftOut.length ?? 0;
  const res: Awaited<ReturnType<typeof uploadLearnings>> = learnings
    ? await uploadLearnings(
        cloud,
        { repo: { key: place.key, name: repoName(place.key, place.checkout) }, learnings, ...(removed.length ? { removed } : {}), ...(held ? { held } : {}) },
        opts.fetchImpl,
      )
    : { error: "git couldn't read this repo's learnings at HEAD" };
  if (isError(res)) writeJsonAtomic(statePath(place.checkout), { ...(prior ?? { fingerprint: "", at: 0 }), failedAt: Date.now() }, true);
  else if (learnings) {
    writeJsonAtomic(statePath(place.checkout), { fingerprint: fingerprint(learnings), at: Date.now(), learnings: res.learnings, paths, branch }, true);
    rememberSent(place.key, learnings);
  }
  return res;
}

/* -------------------------------------------------------------------------- */
/* what the workspace has                                                     */
/* -------------------------------------------------------------------------- */

/** Per repo key: the learnings its last upload from this machine carried, by file name, with their authors, and its skills by folder name. */
type SentLearnings = Record<string, { at: number; learnings: Record<string, string>; skills?: string[] }>;

/** What the workspace got of each repo: learnings by file name to author, and skill folder names. */
interface Sent {
  learnings: Map<string, Map<string, string>>;
  skills: Map<string, Set<string>>;
}

/** `.claude/skills/<name>/SKILL.md` → `<name>`; "" for any other path. */
export function repoSkillName(path: string): string {
  return /^\.claude\/skills\/([^/]+)\/SKILL\.md$/.exec(path)?.[1] ?? "";
}

function sentPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(trailHome(env), "workspace-sent.json");
}

/**
 * Note what the workspace now has of a repo, which is what a use may name.
 * Two syncs of different repos at once can lose one's entry: its uses then
 * name nothing until its next sync, an undercount, never a leak.
 */
function rememberSent(key: string, learnings: UploadedLearning[]): void {
  try {
    const all = readJson<SentLearnings>(sentPath()) ?? {};
    const skills = learnings.filter((l) => l.kind === "skill").map((l) => repoSkillName(l.path)).filter(Boolean);
    all[key] = { at: Date.now(), learnings: Object.fromEntries(learnings.filter((l) => l.kind !== "skill").map((l) => [learningName(l.path), l.author])), skills };
    ensurePrivateDir(trailHome());
    writeJsonAtomic(sentPath(), all, true, PRIVATE_FILE_MODE);
  } catch {
    /* uses name nothing until the next sync */
  }
}

/** What the workspace got of each repo from this machine. Empty when nothing was sent yet. */
function readSent(): Sent {
  const out: Sent = { learnings: new Map(), skills: new Map() };
  const all = readJson<SentLearnings>(sentPath());
  if (typeof all !== "object" || all === null) return out;
  for (const [key, v] of Object.entries(all)) {
    const ls = v?.learnings;
    if (typeof ls === "object" && ls !== null) out.learnings.set(key, new Map(Object.entries(ls).filter((e): e is [string, string] => typeof e[1] === "string")));
    out.skills.set(key, new Set(asStrings(v?.skills)));
  }
  return out;
}

/**
 * The use as it may go up: only the learnings the workspace already got of
 * its repo, each with the author that upload gave it. A personal learning,
 * an uncommitted or untracked one, or one an older trail queued, is dropped
 * from it, name and author both. A skill use goes only for a skill the
 * workspace got of that repo; any other is dropped whole.
 */
function onlySent(e: ActivityEvent, sent: Sent): ActivityEvent | null {
  if (e.kind === "skill") return e.skill && sent.skills.get(e.repo)?.has(e.skill) ? e : null;
  const has = sent.learnings.get(e.repo);
  const names = [...new Set(e.shown_paths)].filter((n) => has?.has(n));
  const authors = names.map((n) => has!.get(n)!);
  return { ...e, shown_paths: names, shown_authors: e.kind === "check" ? [...new Set(authors)] : authors };
}

/** Sync every repo of the workspace that's on this machine. Returns what went up. */
export async function syncWorkspaceRepos(cloud: Cloud, fetchImpl?: typeof fetch): Promise<{ repos: number; learnings: number }> {
  let repos = 0;
  let learnings = 0;
  for (const r of knownRepos()) {
    if (!cloud.repos.includes(r.key) || !existsSync(r.path)) continue;
    const res = await syncRepo(r.path, cloud, { fetchImpl });
    if (isError(res)) continue;
    repos++;
    learnings += res.learnings;
  }
  await flushActivity(cloud, fetchImpl);
  return { repos, learnings };
}

/* -------------------------------------------------------------------------- */
/* the activity outbox                                                        */
/* -------------------------------------------------------------------------- */

function outboxPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(trailHome(env), "outbox.jsonl");
}

/** Whether a use may go to `cloud`: the repo is the workspace's, and it happened since connecting. */
function sendable(e: ActivityEvent, cloud: Cloud): boolean {
  return cloud.repos.includes(e.repo) && Date.parse(e.at) >= (cloud.linkedAt || 0);
}

/** Whether uses of `repo` are recorded at all: connected by `pair`/login (not `connect`) and the repo is the workspace's. */
export function records(cloud: Cloud | null, repo: string): cloud is Cloud {
  return !!cloud && cloud.via !== "connect" && cloud.repos.includes(repo);
}

/** A skill's folder name, as Claude Code names skills. */
const SKILL_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const asStrings = (x: unknown): string[] => (Array.isArray(x) ? x.filter((s): s is string => typeof s === "string") : []);
const asText = (x: unknown): string => (typeof x === "string" ? x : "");

/**
 * A use as it may be queued or sent, built field by field from what was
 * handed in. Anything else is left behind: an older trail queued the query
 * (for the prompt hook, the person's whole prompt) and the file paths, and
 * neither may reach the outbox or Trail. Null when it isn't a use at all.
 */
export function activityEvent(raw: unknown): ActivityEvent | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (r.kind !== "search" && r.kind !== "check" && r.kind !== "skill") return null;
  const skill = r.kind === "skill" ? asText(r.skill) : "";
  if (r.kind === "skill" && !SKILL_NAME.test(skill)) return null;
  const count = typeof r.file_count === "number" && Number.isFinite(r.file_count) ? Math.max(0, Math.floor(r.file_count)) : asStrings(r.files).length;
  return {
    repo: asText(r.repo),
    kind: r.kind,
    ...(skill ? { skill } : {}),
    asker: asText(r.asker),
    session: asText(r.session),
    file_count: count,
    shown_paths: asStrings(r.shown_paths),
    shown_authors: asStrings(r.shown_authors),
    ...(typeof r.saved_tokens === "number" && Number.isFinite(r.saved_tokens) && r.saved_tokens > 0 ? { saved_tokens: Math.floor(r.saved_tokens) } : {}),
    at: asText(r.at),
  };
}

/**
 * Remember one use of the learnings, to send with the next sync: only while
 * this machine is connected, and only for a repo in the workspace. Not
 * connected, or another repo, and nothing is written. Never throws.
 */
export function recordActivity(use: ActivityEvent, cloud: Cloud | null = readCloud()): void {
  const e = activityEvent(use);
  if (!e || !records(cloud, e.repo)) return;
  try {
    const p = outboxPath();
    appendPrivateFile(p, `${JSON.stringify(e)}\n`);
    if (statSync(p).size > OUTBOX_MAX_BYTES) {
      const lines = readFileSync(p, "utf8").split("\n").filter(Boolean).slice(-OUTBOX_KEEP_LINES);
      writePrivateFile(p, `${lines.join("\n")}\n`);
    }
  } catch {
    /* a lost event undercounts reuse by one */
  }
}

/**
 * Forget every use waiting to go, and what an earlier connection was sent.
 * Run when a machine connects, so nothing recorded before that is ever sent,
 * and only what this connection uploads vouches for a learning's name.
 */
export function dropActivity(env: NodeJS.ProcessEnv = process.env): void {
  try {
    rmSync(outboxPath(env), { force: true });
    rmSync(sentPath(env), { force: true });
  } catch {
    /* sent-time filtering in flushActivity drops them anyway */
  }
}

function outboxHasEvents(): boolean {
  try {
    return statSync(outboxPath()).size > 0;
  } catch {
    return false;
  }
}

/**
 * Send the outbox. It's moved aside first, so events recorded while the
 * request is out land in a fresh file; on failure they're put back. A use
 * from before this connection, or for a repo the workspace doesn't have
 * (left by an older trail), is dropped, never sent; so is the name of any
 * learning the workspace didn't get from this machine's last upload of that
 * repo, put back or sent.
 */
export async function flushActivity(cloud: Cloud, fetchImpl?: typeof fetch): Promise<number> {
  const p = outboxPath();
  if (!outboxHasEvents()) return 0;
  const sending = `${p}.${process.pid}.sending`;
  try {
    renameSync(p, sending);
  } catch {
    return 0;
  }
  const has = readSent();
  const events: ActivityEvent[] = [];
  for (const line of readFileSync(sending, "utf8").split("\n")) {
    try {
      if (!line.trim()) continue;
      const e = activityEvent(JSON.parse(line));
      const out = e && sendable(e, cloud) ? onlySent(e, has) : null;
      if (out) events.push(out);
    } catch {
      /* a torn line */
    }
  }
  let sent = 0;
  for (let i = 0; i < events.length; i += 500) {
    const res = await postActivity(cloud, events.slice(i, i + 500), fetchImpl);
    if (isError(res)) {
      // Put back what didn't go, ahead of anything recorded since.
      const rest = events.slice(i).map((e) => JSON.stringify(e)).join("\n");
      appendPrivateFile(p, `${rest}\n`);
      break;
    }
    sent += Math.min(500, events.length - i);
  }
  // Sent, or put back above: either way this copy is done with.
  rmSync(sending, { force: true });
  return sent;
}

/* -------------------------------------------------------------------------- */
/* in the background                                                          */
/* -------------------------------------------------------------------------- */

/** Whether the repo's learnings changed since they last went up, and a retry is due. Never while git can't read HEAD. */
export function syncIsDue(checkout: string, now = Date.now()): boolean {
  const state = readJson<SyncState>(statePath(checkout));
  if (state?.failedAt && now - state.failedAt < RETRY_MS) return false;
  const learnings = learningsPayload(checkout);
  return !!learnings && state?.fingerprint !== fingerprint(learnings);
}

/**
 * Sync in a detached child when this machine is connected and either the
 * repo (one of the workspace's) has learnings the workspace hasn't seen, or
 * there are uses waiting to go. Never waits, never throws.
 */
export function maybeSyncInBackground(dir: string, now = Date.now()): boolean {
  try {
    const cloud = readCloud();
    if (!cloud) {
      // Whatever an older trail queued here can never go: connecting drops it.
      dropActivity();
      return false;
    }
    const checkout = repoPlace(dir).checkout;
    const due = (inWorkspace(checkout, cloud) && syncIsDue(checkout, now)) || outboxHasEvents();
    if (!due) return false;
    // Marked first, so commands run while the child works don't start another.
    const prior = readJson<SyncState>(statePath(checkout));
    writeJsonAtomic(statePath(checkout), { ...(prior ?? { fingerprint: "", at: 0 }), failedAt: now }, true);
    const child = spawn(process.execPath, [graftCliPath(), "_trail-sync", checkout], { detached: true, stdio: "ignore", windowsHide: true });
    child.unref();
    return true;
  } catch {
    return false;
  }
}

/** `_trail-sync`: what the background child does. */
export async function runSyncChild(dir: string): Promise<void> {
  const cloud = readCloud();
  if (!cloud) return;
  const checkout = repoPlace(dir).checkout;
  if (inWorkspace(checkout, cloud)) await syncRepo(checkout, cloud);
  await flushActivity(cloud);
}

/** The name a learning's file goes by, from a path or a `ref:path`. */
export function learningName(path: string): string {
  return basename(path.slice(path.lastIndexOf(":") + 1));
}
