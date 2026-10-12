/**
 * `graft trail pull`, for every context file rather than only the root CLAUDE.md.
 *
 * Trail suggests changes to the files a repository hands its coding agents —
 * AGENTS.md, a folder's own CLAUDE.md, Cursor rules, Claude skills — and a
 * person accepts some of them. This fetches the accepted ones and writes them.
 *
 * Edits and new sections go through the same line-by-line patcher as the root
 * CLAUDE.md (see claude-md.ts), so everything a change does not name comes back
 * byte for byte. A `create` carries a whole file, and it is never allowed to
 * overwrite a file someone wrote here: an existing file with other content is a
 * conflict to report, unless graft itself owns that file. A `replace` (how a
 * Cursor rule is edited) carries the whole new file and the whole file it was
 * computed against, and is written only while the file here is still that one.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import { applyChanges, type ClaudeMdChange } from "./claude-md.js";
import { baseUrlFor, type BrainLink } from "./link.js";

export type ContextFileKind = "agents_md" | "folder_claude_md" | "cursor_rule" | "skill";

/** One accepted change to one context file. */
export interface ContextFileChange {
  id: string;
  kind: "edit" | "add" | "create" | "replace";
  heading?: string;
  after_heading?: string;
  find?: string;
  /** edit/add: as in claude-md.ts. create/replace: the whole file. For
   *  replace, `find` is the whole file the suggestion was computed against. */
  text: string;
  reason?: string;
}

export interface ContextFile {
  kind: ContextFileKind | string;
  path: string;
  exists?: boolean;
  managed_by_graft?: boolean;
  changes: ContextFileChange[];
}

export interface ContextFilesPull {
  head_sha: string;
  files: ContextFile[];
}

/**
 * Which picked agents read a file of this kind. A file whose readers were not
 * picked is neither listed nor written: `graft init` is where someone said which
 * agents this repo is for, and a pull must not quietly add files for others.
 */
const READERS: Record<string, string[]> = {
  claude_md: ["claude"],
  folder_claude_md: ["claude"],
  skill: ["claude"],
  agents_md: ["agents", "hermes", "antigravity"],
  cursor_rule: ["cursor"],
};

/** The kind of a context file, from its path — for the root CLAUDE.md pull,
 * which names a path but no kind. */
export function kindForPath(path: string): string {
  const p = path.replace(/\\/g, "/");
  const name = p.split("/").pop() ?? "";
  if (name === "CLAUDE.md") return p.includes("/") ? "folder_claude_md" : "claude_md";
  if (name === "AGENTS.md") return "agents_md";
  if (p.startsWith(".cursor/rules/")) return "cursor_rule";
  if (p.startsWith(".claude/skills/")) return "skill";
  return "";
}

/**
 * Whether a file of `kind` is for one of the `wired` agents. Everything passes
 * when nothing is wired — there is no choice to respect — and so does a kind
 * graft does not know, rather than dropping what Trail sent.
 */
export function readByWired(kind: string, wired: readonly string[]): boolean {
  if (wired.length === 0) return true;
  const readers = READERS[kind];
  if (!readers) return true;
  return readers.some((r) => wired.includes(r));
}

/** The agents among `wired` that read a file of `kind`. */
export function readersOf(kind: string, wired: readonly string[]): string[] {
  const readers = READERS[kind] ?? [];
  return wired.filter((w) => readers.includes(w));
}

/** GET /api/public/brains/:id/context-files. `unsupported` on a 404: an older Trail. */
export async function fetchContextFiles(
  link: BrainLink,
  fetchImpl: typeof fetch = fetch,
): Promise<ContextFilesPull | { unsupported: true } | { error: string; status?: number }> {
  const url = `${baseUrlFor(link)}/api/public/brains/${encodeURIComponent(link.brainId)}/context-files`;
  try {
    const res = await fetchImpl(url, {
      headers: { authorization: `Bearer ${link.token}`, accept: "application/json" },
      signal: AbortSignal.timeout(15_000),
    });
    const body = await res.text();
    if (res.status === 404) return { unsupported: true };
    if (!res.ok) return { error: `Trail refused the pull: ${res.status} ${body.slice(0, 200)}`, status: res.status };
    const parsed = JSON.parse(body) as Partial<ContextFilesPull>;
    const files = Array.isArray(parsed.files) ? parsed.files : [];
    return {
      head_sha: String(parsed.head_sha ?? ""),
      files: files
        .filter((f) => f && typeof f.path === "string")
        .map((f) => ({ ...f, changes: Array.isArray(f.changes) ? f.changes : [] })),
    };
  } catch (e) {
    return { error: `could not reach Trail: ${e instanceof Error ? e.message : e}` };
  }
}

/** POST /api/public/brains/:id/context-files/applied, 100 ids per request. */
export async function markContextFilesApplied(link: BrainLink, ids: string[], fetchImpl: typeof fetch = fetch): Promise<boolean> {
  if (ids.length === 0) return true;
  const url = `${baseUrlFor(link)}/api/public/brains/${encodeURIComponent(link.brainId)}/context-files/applied`;
  try {
    for (let i = 0; i < ids.length; i += 100) {
      const res = await fetchImpl(url, {
        method: "POST",
        headers: {
          authorization: `Bearer ${link.token}`,
          "content-type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify({ ids: ids.slice(i, i + 100) }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) return false;
    }
    return true;
  } catch {
    return false;
  }
}

/** What a pull will do (or did) to one file. */
export interface FilePlan {
  /** Repo-relative, forward slashes. */
  path: string;
  /** M: an existing file changes. A: a new file. "": nothing to write. */
  status: "M" | "A" | "";
  /** The file's new text, when status is set. */
  text?: string;
  written: ContextFileChange[];
  /** Already there: counts as applied, nothing to write. */
  present: ContextFileChange[];
  skipped: Array<{ change: ContextFileChange; why: string }>;
}

/**
 * The repo-relative form of a path Trail sent, or null when it points
 * anywhere but a file inside this checkout. Trail is trusted to suggest text,
 * not to choose where on this machine it lands.
 */
export function safeRelPath(root: string, path: string): string | null {
  const raw = path.replace(/\\/g, "/").trim();
  if (!raw || isAbsolute(raw) || /^[a-zA-Z]:/.test(raw)) return null;
  const parts = raw.split("/");
  if (parts.some((p) => p === ".." || p === "")) return null;
  if (parts[0] === ".git") return null;
  const abs = resolve(root, normalize(raw));
  const rel = relative(resolve(root), abs);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) return null;
  return rel.split(sep).join("/");
}

/**
 * Work out one file's changes against what is on disk. Pure but for reading
 * the file, so the command, the dry run and the tests share it.
 */
export function planContextFile(root: string, file: ContextFile): FilePlan {
  const rel = safeRelPath(root, file.path);
  const plan: FilePlan = { path: rel ?? file.path, status: "", written: [], present: [], skipped: [] };
  if (!rel) {
    for (const c of file.changes) plan.skipped.push({ change: c, why: "the path points outside this repo" });
    return plan;
  }
  const abs = join(root, rel);
  const existed = existsSync(abs);
  let original = "";
  if (existed) {
    try {
      original = readFileSync(abs, "utf8");
    } catch {
      for (const c of file.changes) plan.skipped.push({ change: c, why: "the file here could not be read" });
      return plan;
    }
  }

  let text = original;
  let changed = false;
  // Whole files first; the edits and sections after them may be relative to one.
  for (const c of file.changes.filter((x) => x.kind === "create")) {
    const want = c.text.replace(/\r\n/g, "\n");
    const have = text.replace(/\r\n/g, "\n");
    if (!existed && !changed) {
      text = c.text.endsWith("\n") ? c.text : `${c.text}\n`;
      changed = true;
      plan.written.push(c);
    } else if (have.trimEnd() === want.trimEnd()) {
      plan.present.push(c);
    } else if (file.managed_by_graft) {
      text = c.text.endsWith("\n") ? c.text : `${c.text}\n`;
      changed = true;
      plan.written.push(c);
    } else {
      plan.skipped.push({ change: c, why: "a file with other content is already there" });
    }
  }

  // Whole-file replacements, guarded by the text they were computed against.
  const same = (a: string, b: string) => a.replace(/\r\n/g, "\n").trimEnd() === b.replace(/\r\n/g, "\n").trimEnd();
  for (const c of file.changes.filter((x) => x.kind === "replace")) {
    if (same(text, c.text)) {
      plan.present.push(c);
    } else if (same(text, c.find ?? "") && (existed || changed || (c.find ?? "").trim() === "")) {
      text = c.text.endsWith("\n") ? c.text : `${c.text}\n`;
      changed = true;
      plan.written.push(c);
    } else {
      plan.skipped.push({ change: c, why: "the file changed here since Trail read it" });
    }
  }

  const patches = file.changes.filter((x) => x.kind === "edit" || x.kind === "add");
  if (patches.length > 0) {
    // A file that is not here yet is an empty one: an edit to a section of it
    // becomes that section, so the change lands rather than being skipped for
    // a heading nobody could have written.
    const fresh = !existed && !changed;
    const r = applyChanges(
      text,
      patches.map(
        (c) =>
          ({
            ...c,
            heading: c.heading ?? "",
            kind: fresh && c.kind === "edit" ? "add" : c.kind,
            ...(fresh && c.kind === "edit" ? { after_heading: "" } : {}),
          }) as ClaudeMdChange,
      ),
    );
    const byId = new Map(patches.map((c) => [c.id, c]));
    for (const w of r.written) plan.written.push(byId.get(w.id)!);
    for (const p of r.present) plan.present.push(byId.get(p.id)!);
    for (const s of r.skipped) plan.skipped.push({ change: byId.get(s.change.id)!, why: s.why });
    if (r.written.length > 0) {
      text = r.text;
      changed = true;
    }
  }

  if (changed && text !== original) {
    plan.status = existed ? "M" : "A";
    plan.text = text;
  }
  return plan;
}

/** Write a planned file, making its folder when it is new. */
export function writePlannedFile(root: string, plan: FilePlan): void {
  if (!plan.status || plan.text === undefined) return;
  const abs = join(root, plan.path);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, plan.text);
}

/** `+ Money · ~ Commands` — a new section is +, an edited one ~, a whole file nothing. */
export function changeSummary(changes: Array<{ kind: string; heading?: string }>): string {
  return changes
    .filter((c) => c.kind === "add" || c.kind === "edit")
    .map((c) => `${c.kind === "add" ? "+" : "~"} ${c.heading ?? ""}`.trim())
    .join(" · ");
}
