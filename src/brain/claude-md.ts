/**
 * The CLAUDE.md half of `graft trail pull` (and of `graft claude-md pull`, its
 * old name): write the CLAUDE.md changes accepted in Trail into this checkout's
 * instruction file.
 *
 * Trail compares the repository's CLAUDE.md with what its history says and
 * suggests edits and new sections; a person accepts some of them on the brain's
 * CLAUDE.md page. This fetches the accepted ones, applies them to the local
 * file, and tells Trail which it wrote so the page stops listing them.
 *
 * The file is edited line by line, never regenerated, so everything a change
 * does not touch comes back byte for byte. An edit whose text is no longer in
 * its section means the local file has moved on since Trail read it; that
 * change is reported and left, never guessed at. Same rules as Trail's own
 * ComposeClaudeMd, which is what the page's preview shows.
 */
import { baseUrlFor, type BrainLink } from "./link.js";

/** One accepted change, as Trail sends it. */
export interface ClaudeMdChange {
  id: string;
  kind: "edit" | "add";
  /** edit: the section it rewrites. add: the new section's heading. */
  heading: string;
  /** add: the section it goes after; "" = end of file. */
  after_heading?: string;
  /** edit: the text to replace; "" = append to the section. */
  find?: string;
  text: string;
  reason?: string;
}

export interface ClaudeMdPull {
  /** The file Trail read, e.g. "CLAUDE.md"; "" when the repo had none. */
  path: string;
  head_sha: string;
  changes: ClaudeMdChange[];
}

export interface ApplyResult {
  text: string;
  /** Written by this pull. */
  written: ClaudeMdChange[];
  /** Already in the file (committed by someone else): nothing to write. */
  present: ClaudeMdChange[];
  /** Could not be placed; the file was left as it is for these. */
  skipped: Array<{ change: ClaudeMdChange; why: string }>;
}

/** GET /api/public/brains/:id/claude-md — the accepted changes. */
export async function fetchAcceptedChanges(
  link: BrainLink,
  fetchImpl: typeof fetch = fetch,
): Promise<ClaudeMdPull | { error: string; unsupported?: boolean; status?: number }> {
  const url = `${baseUrlFor(link)}/api/public/brains/${encodeURIComponent(link.brainId)}/claude-md`;
  try {
    const res = await fetchImpl(url, {
      headers: { authorization: `Bearer ${link.token}`, accept: "application/json" },
      signal: AbortSignal.timeout(15_000),
    });
    const body = await res.text();
    if (res.status === 404 || res.status === 503) {
      return { error: "this trail has no CLAUDE.md suggestions yet — its Trail may be older than the feature", unsupported: true };
    }
    // The status rides along so a watcher can tell a revoked token, which no
    // amount of waiting fixes, from a server having a bad minute.
    if (!res.ok) return { error: `Trail refused the pull: ${res.status} ${body.slice(0, 200)}`, status: res.status };
    const parsed = JSON.parse(body) as Partial<ClaudeMdPull>;
    return { path: parsed.path ?? "", head_sha: parsed.head_sha ?? "", changes: parsed.changes ?? [] };
  } catch (e) {
    return { error: `could not reach Trail: ${e instanceof Error ? e.message : e}` };
  }
}

/** POST /api/public/brains/:id/claude-md/applied — what this pull wrote. */
export async function markApplied(link: BrainLink, ids: string[], fetchImpl: typeof fetch = fetch): Promise<boolean> {
  if (ids.length === 0) return true;
  const url = `${baseUrlFor(link)}/api/public/brains/${encodeURIComponent(link.brainId)}/claude-md/applied`;
  try {
    // Trail takes at most 100 per request.
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

interface Section {
  title: string;
  level: number;
  /** Line index of the heading. */
  head: number;
  /** One past the last line: the next heading at the same or a higher level. */
  end: number;
}

const HEADING = /^(#{1,6})\s+(.+?)\s*#*\s*$/;

/** Every ATX heading outside code fences, with the lines it owns. */
function sectionsOf(lines: string[]): Section[] {
  const heads: Array<{ line: number; level: number; title: string }> = [];
  let fence = false;
  lines.forEach((ln, i) => {
    const t = ln.trim();
    if (t.startsWith("```") || t.startsWith("~~~")) {
      fence = !fence;
      return;
    }
    if (fence) return;
    const m = HEADING.exec(ln);
    if (m) heads.push({ line: i, level: m[1]!.length, title: m[2]!.trim() });
  });
  return heads.map((h, i) => {
    let end = lines.length;
    for (let j = i + 1; j < heads.length; j++) {
      if (heads[j]!.level <= h.level) {
        end = heads[j]!.line;
        break;
      }
    }
    return { title: h.title, level: h.level, head: h.line, end };
  });
}

const norm = (s: string) => s.trim().toLowerCase();

/** Trim the blank lines a section ends with, so appended text sits under its content. */
function lastContentLine(lines: string[], s: Section): number {
  let i = s.end;
  while (i > s.head + 1 && lines[i - 1]!.trim() === "") i--;
  return i;
}

/**
 * Apply accepted changes to the file's text. Pure: reads nothing, writes
 * nothing, so the command and the tests share it.
 */
export function applyChanges(original: string, changes: ClaudeMdChange[]): ApplyResult {
  const crlf = original.includes("\r\n");
  let lines = original.replace(/\r\n/g, "\n").split("\n");
  const out: ApplyResult = { text: original, written: [], present: [], skipped: [] };

  // Edits first, against headings that exist; then additions, which may go
  // after a section an edit just touched.
  const ordered = [...changes.filter((c) => c.kind === "edit"), ...changes.filter((c) => c.kind === "add")];
  for (const c of ordered) {
    const sections = sectionsOf(lines);
    if (c.kind === "edit") {
      const s = sections.find((x) => norm(x.title) === norm(c.heading));
      if (!s) {
        out.skipped.push({ change: c, why: `no “${c.heading}” section in the file` });
        continue;
      }
      const body = lines.slice(s.head + 1, s.end).join("\n");
      const text = c.text.replace(/\r\n/g, "\n");
      const find = (c.find ?? "").replace(/\r\n/g, "\n");
      if (text.trim() && body.includes(text.trim())) {
        out.present.push(c);
        continue;
      }
      if (!find) {
        const at = lastContentLine(lines, s);
        lines = [...lines.slice(0, at), ...text.trimEnd().split("\n"), ...lines.slice(at)];
        out.written.push(c);
        continue;
      }
      const idx = body.indexOf(find);
      if (idx < 0) {
        out.skipped.push({ change: c, why: `the text it rewrites is no longer in “${c.heading}”` });
        continue;
      }
      const next = body.slice(0, idx) + text + body.slice(idx + find.length);
      lines = [...lines.slice(0, s.head + 1), ...next.split("\n"), ...lines.slice(s.end)];
      out.written.push(c);
      continue;
    }

    // add
    if (sections.some((x) => norm(x.title) === norm(c.heading))) {
      out.present.push(c);
      continue;
    }
    const block = [`## ${c.heading.trim()}`, "", ...c.text.replace(/\r\n/g, "\n").trim().split("\n")];
    const after = c.after_heading ? sections.find((x) => norm(x.title) === norm(c.after_heading!)) : undefined;
    if (after) {
      const at = lastContentLine(lines, after);
      // A blank line either side, whatever the file had there.
      const tail = lines.slice(at);
      lines = [...lines.slice(0, at), "", ...block, ...(tail.length > 0 && tail[0]!.trim() !== "" ? [""] : []), ...tail];
    } else {
      while (lines.length > 0 && lines[lines.length - 1]!.trim() === "") lines.pop();
      lines = lines.length > 0 ? [...lines, "", ...block] : block;
      lines.push("");
    }
    out.written.push(c);
  }

  let text = lines.join("\n");
  if (out.written.length > 0 && !text.endsWith("\n")) text += "\n";
  out.text = out.written.length > 0 ? (crlf ? text.replace(/\n/g, "\r\n") : text) : original;
  return out;
}
