/**
 * One learning per session, or one per PR when a session goes on to another.
 *
 * A long session saves more than once: the Stop hook asks after a fix, again
 * after a choice, and the agent saves on its own too. Each save used to be a
 * new file, so one task left three. Now a later save in the same session adds
 * to the file its first save wrote, section by section. A new PR needs a new
 * branch, so a save on another branch starts a new file.
 *
 * Which file a session wrote is kept on this machine, in the repo's
 * `~/.trail/repos/<repo>/session-learnings.json`, by Claude Code's session id
 * (`sessionKey`). Nothing about the session goes in the learning itself.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readJson, writeJsonAtomic } from "../util/state.js";
import { ensureRepoHome } from "./home.js";
import { parseNote, renderNote, type LearningScope, type Note, type NoteCost } from "./notes.js";
import { TOUCH_LIMIT } from "./targets.js";
import { isAlwaysFollow } from "./units.js";

/** A session left alone this long starts a new learning when it saves again. */
const KEEP_MS = 7 * 24 * 60 * 60 * 1000;

interface SessionFile {
  path: string;
  branch?: string;
  at: number;
}

/** Session id → the learning it saved last, for each scope. */
type Store = Record<string, Partial<Record<LearningScope, SessionFile>>>;

function storePath(dir: string): string {
  return join(ensureRepoHome(dir).place.dir, "session-learnings.json");
}

/**
 * The learning this session already saved in `dir`'s repo, to add to, or null
 * when the next save should be a new file: none yet, another branch, the file
 * is gone, or it's always followed (plain findings never join one of those).
 */
export function sessionLearning(dir: string, session: string, scope: LearningScope, branch: string | undefined): Note | null {
  const saved = readJson<Store>(storePath(dir))?.[session]?.[scope];
  if (!saved || saved.branch !== branch) return null;
  try {
    const n = parseNote(readFileSync(saved.path, "utf8"), saved.path);
    return n && !n.standing && !isAlwaysFollow(n) ? n : null;
  } catch {
    return null;
  }
}

/** Remember `n` as the learning this session saved in `dir`'s repo, dropping sessions idle past a week. */
export function rememberSessionLearning(dir: string, session: string, scope: LearningScope, n: Note, branch: string | undefined, now = Date.now()): void {
  const path = storePath(dir);
  const store = readJson<Store>(path) ?? {};
  for (const [id, files] of Object.entries(store)) {
    if (Object.values(files).every((f) => !f || now - f.at > KEEP_MS)) delete store[id];
  }
  store[session] = { ...store[session], [scope]: { path: n.path, branch, at: now } };
  writeJsonAtomic(path, store);
}

/**
 * `n` with a later save of the same session added, written back: its title,
 * id and file stay, the costs add up, and the touches join.
 */
export function addToLearning(n: Note, add: { body: string; cost?: NoteCost; touches: string[] }): Note {
  const sum = (a?: number, b?: number) => (a === undefined && b === undefined ? undefined : (a ?? 0) + (b ?? 0));
  const cost = n.cost || add.cost ? { minutes: sum(n.cost?.minutes, add.cost?.minutes), tokens: sum(n.cost?.tokens, add.cost?.tokens) } : undefined;
  const next: Note = { ...n, body: mergeBodies(n.body, add.body), cost, touches: [...new Set([...n.touches, ...add.touches])].slice(0, TOUCH_LIMIT) };
  writeFileSync(n.path, renderNote(next));
  return next;
}

/**
 * `add` folded into `body`: what's under each `## ` heading goes under the
 * same heading, a heading `body` lacks goes at the end, and a line already
 * there isn't written twice.
 */
export function mergeBodies(body: string, add: string): string {
  const out = sections(body);
  for (const part of sections(add)) {
    let into = out.find((p) => headingKey(p.heading) === headingKey(part.heading));
    if (!into) out.push((into = { heading: part.heading, lines: [] }));
    const have = new Set(into.lines.map((l) => l.trim()).filter(Boolean));
    into.lines = [...trimBlank(into.lines), ...trimBlank(part.lines.filter((l) => !l.trim() || !have.has(l.trim())))];
  }
  return out
    .filter((p) => p.heading || p.lines.some((l) => l.trim()))
    .map((p) => [...(p.heading ? [p.heading] : []), ...trimBlank(p.lines)].join("\n"))
    .join("\n\n");
}

interface Section {
  heading: string | null;
  lines: string[];
}

/** The text before the first `## ` heading, then each heading with its lines. */
function sections(text: string): Section[] {
  const out: Section[] = [{ heading: null, lines: [] }];
  for (const line of text.trim().split(/\r?\n/)) {
    if (/^##\s/.test(line)) out.push({ heading: line.trim(), lines: [] });
    else out[out.length - 1]!.lines.push(line);
  }
  return out;
}

function headingKey(h: string | null): string {
  return h ? h.replace(/^##\s+/, "").trim().toLowerCase() : "";
}

function trimBlank(lines: string[]): string[] {
  let a = 0;
  let b = lines.length;
  while (a < b && !lines[a]!.trim()) a++;
  while (b > a && !lines[b - 1]!.trim()) b--;
  return lines.slice(a, b);
}
