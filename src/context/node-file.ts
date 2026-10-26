/**
 * The on-disk format of the context graph: a folder of plain markdown files
 * under `.context/`, one per node. The files ARE the graph — the frontmatter
 * carries the machine-readable node (identity, source provenance, edges) and
 * the body is human/agent-readable prose. There is no database.
 *
 * Layout of a node file:
 *
 *   ---                         ← YAML frontmatter (canonical, machine-owned)
 *   name / slug / type
 *   sources: [{path, hash}]     ← provenance + the staleness key
 *   sources_digest
 *   links: [{to, relation}]     ← edges (canonical form)
 *   ---
 *   <!-- context:generated:start -->
 *   ## Summary … ## Related …   ← regenerated on every `init`
 *   <!-- context:generated:end -->
 *   ## Notes …                  ← anything a human writes is preserved verbatim
 *
 * `.context/manifest.json` is a generated index over all nodes plus the full
 * file→hash map `init` saw, so `check` can detect drift in O(files) without an
 * LLM and without re-reading every node body.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { matter } from "../util/front-matter.js";
import { contentHash, normalizeName } from "../util/id.js";
import { relPosix, stripTrailingSlashes } from "../util/paths.js";
// Value-only import of a constant; `write.ts` pulls in nothing from here, so no cycle.
import { GRAPH_DIR } from "../graph/write.js";
import { mapDirFor, isTrailMapDir } from "./map-dir.js";
import { ignoreInTrailDir } from "../notes/repo-trail.js";

/** A source file a node was derived from, with its content hash at generation time. */
export interface SourceRef {
  path: string;
  hash: string;
}

/** A directed edge to another node (by slug). */
export interface NodeLink {
  to: string;
  relation: string;
  description?: string;
}

/** A single node in the graph — one markdown file. */
export interface ContextNode {
  name: string;
  slug: string;
  /** Coarse category from extraction: system | service | api | concept | … */
  type: string;
  /** Prose description that becomes the node body. */
  summary: string;
  /** Source files that produced this node (empty only for hand-authored nodes). */
  sources: SourceRef[];
  /** sha256 over the sorted `path:hash` lines of {@link sources}. */
  sourcesDigest: string;
  /** Outbound edges. */
  links: NodeLink[];
  /** Free-form region below the generated block, preserved across re-runs. */
  human: string;
}

/** The generated index written alongside the node files. */
export interface Manifest {
  version: number;
  /** Human label for the model that built the graph, e.g. "openrouter:openai/gpt-4o-mini". */
  model: string;
  /** sha256 over every source file's `path:hash` — the whole-graph fingerprint. */
  repoDigest: string;
  /** Every source file `init` processed, with its hash. The staleness ground-truth. */
  files: SourceRef[];
  /** Node roster (a subset of each node's frontmatter, for fast reads). */
  nodes: Array<{ slug: string; name: string; type: string; sources: string[]; sourcesDigest: string }>;
}

export const MANIFEST_VERSION = 1;
const GEN_START = "<!-- context:generated:start -->";
const GEN_END = "<!-- context:generated:end -->";
const MANIFEST_FILE = "manifest.json";
/** Gitignored cache dir (per-file summaries + extractions), never committed. */
export const CACHE_DIR = ".cache";

/** Env kill switch — same truthy parsing as `GRAFT_NO_REFRESH` in ../graph/refresh.ts. */
function envTruthy(name: string): boolean {
  const v = process.env[name];
  return v !== undefined && v !== "" && v !== "0" && v !== "false";
}

/** Turn a display name into a stable, filesystem- and link-safe slug. */
export function slugify(name: string): string {
  const base = normalizeName(name)
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return base || "node";
}

/** sha256 over the sorted `path:hash` lines of a set of sources. */
export function digestSources(sources: SourceRef[]): string {
  const lines = sources
    .map((s) => `${s.path}:${s.hash}`)
    .sort()
    .join("\n");
  return contentHash(lines);
}

/** Absolute path of a repo's code map: `graft/`, or `.trail/cache/` in a repo
 * on trail (see context/map-dir.ts). An explicit `--dir` wins. `graft/` is
 * visible (not dot-prefixed) on purpose: default ripgrep skips hidden dirs, so
 * a grep can land on its cards; under trail the hooks name the path instead. */
export function contextDirFor(root: string, override?: string): string {
  if (override) return override;
  return mapDirFor(root);
}

/**
 * Make sure the repo's root `.gitignore` ignores the graft output dir. The
 * graph is a local, regenerable cache (like `node_modules`), not a committed
 * artifact, so every `graft build` adds the entry itself the first time — the
 * user never has to think about it. No-ops when the entry is already present
 * (anchored `/graft/` or a bare user-owned `graft`), when git already ignores
 * the dir by other means (`.git/info/exclude`, a parent `.gitignore`,
 * `core.excludesFile`), or when the dir lives outside `root`; migrates a
 * legacy unanchored trailing-slash entry (`graft/`) to the anchored form in
 * place (see below). Best-effort: an unwritable `.gitignore` must never abort
 * a build, so write failures are swallowed.
 */
const GRAPH_CACHE_NOTE = "graft's local graph cache — regenerable, not committed (run `graft build`).";

/** Why `.graft/` is ignored, which is a different reason: not that it is cheap
 *  to regenerate, but that it holds a token. */
export const LINK_NOTE = "graft's brain link — holds a read token, never commit it.";

export function ensureGitignored(root: string, contextDir: string, note = GRAPH_CACHE_NOTE): void {
  if (envTruthy("GRAFT_NO_GITIGNORE")) return;
  // trail's map: `.trail/.gitignore` keeps it out, and the repo's own file is never touched.
  if (isTrailMapDir(root, contextDir)) {
    try { ignoreInTrailDir(root, "cache/"); } catch { /* best-effort */ }
    return;
  }
  const rel = relPosix(root, contextDir);
  if (rel === "" || rel.startsWith("..")) return; // dir is at/above the repo root — nothing sane to ignore
  const bare = stripTrailingSlashes(rel); // "graft" (or a `--dir` subpath like "tools/ctx")
  // Root-ANCHORED, so it ignores exactly this repo's `graft/` and not a directory named
  // `graft` at any depth. An unanchored `graft/` also matched `.claude/skills/graft/`, so
  // committing the skill graft just wrote was silently dropped (#79). `rel` is always
  // repo-relative here, so a leading `/` is always safe (incl. a `--dir` subpath).
  const entry = `/${bare}/`;
  const path = join(root, ".gitignore");
  let current = "";
  try { current = readFileSync(path, "utf8"); } catch { /* no .gitignore yet — we create one */ }
  const lines = current.split("\n");
  // Only the trailing-slash unanchored form is legacy trap bait (what graft wrote
  // pre-#79). A bare `graft` / bare `<dir>` is a user rule — leave it alone (it may
  // cover e.g. a built `graft` binary that `/graft/` would stop matching).
  const isLegacy = (l: string) => l.trim() === `${bare}/`;
  // A legacy unanchored entry (written pre-#79) is not merely tolerated — it IS the line
  // that ignores `.claude/skills/graft/`, so every repo that adopted graft before the
  // fix keeps the silent-skill-drop trap if "already present" means no-op. Rewrite the
  // first legacy line in place (same position, under whatever comment sits above it),
  // drop duplicates, and never add a second entry when an anchored one already exists
  // alongside the stale one (pre-#79, a hand-anchored line didn't stop the hook-triggered
  // build from re-appending the unanchored form, so both could sit in the same file).
  if (lines.some(isLegacy)) {
    const hasAnchored = lines.some((l) => l.trim() === entry);
    const out: string[] = [];
    let placed = hasAnchored;
    for (const line of lines) {
      if (isLegacy(line)) {
        if (!placed) { out.push(entry); placed = true; }
        continue; // drop the unanchored spelling
      }
      out.push(line);
    }
    try { writeFileSync(path, out.join("\n")); } catch { /* best-effort — build already succeeded */ }
    return;
  }
  if (lines.some((l) => { const t = l.trim(); return t === entry || t === bare; })) return;
  // Not in `.gitignore` itself, but git may already ignore the dir through `.git/info/exclude`,
  // a parent `.gitignore` or `core.excludesFile`. Then there is nothing to add, and appending
  // would dirty the checkout again on every build for a user who keeps tooling noise out of
  // the tracked `.gitignore` on purpose.
  if (gitAlreadyIgnores(root, bare)) return;
  const gap = current === "" ? "" : current.endsWith("\n") ? "\n" : "\n\n";
  const block = `${gap}# ${note}\n${entry}\n`;
  try { writeFileSync(path, current + block); } catch { /* best-effort — build already succeeded */ }
}

/** Variables that point git at a different repo than the one in `cwd` (a git hook exports
 *  `GIT_DIR` and `GIT_INDEX_FILE`, a wrapper may export the rest). Left in the child's
 *  environment they make `check-ignore` answer for that other repo. */
const GIT_REPO_ENV = [
  "GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR", "GIT_OBJECT_DIRECTORY", "GIT_NAMESPACE",
];

/** True when `root` is a git work tree whose ignore rules (every source git reads: `.gitignore`
 *  files, `.git/info/exclude`, `core.excludesFile`) already cover the directory `rel/`. Any
 *  failure (git missing, not a repo, timeout) answers false, so the caller falls back to
 *  writing the entry. The trailing slash makes git treat the path as a directory, so dir-only
 *  patterns like `graft/` match. A negation rule (an allowlist `.gitignore` that re-includes
 *  directories) can judge a not-yet-created path differently from an existing one, so callers
 *  create the dir first. `core.fsmonitor` is off because it would run a command named by the
 *  repo's own config. */
function gitAlreadyIgnores(root: string, rel: string): boolean {
  try {
    const env = { ...process.env };
    for (const k of GIT_REPO_ENV) delete env[k];
    const r = spawnSync("git", ["-c", "core.fsmonitor=false", "check-ignore", "-q", "--", `${rel}/`], {
      cwd: root, env, stdio: "ignore", timeout: 5000, windowsHide: true,
    });
    return r.status === 0;
  } catch { return false; }
}

/**
 * Keep the card tree greppable even though it's gitignored, by writing a root
 * `.ignore` that re-admits it.
 *
 * The cards exist so that a `grep <symbol>` lands on a ~150-token card instead of
 * a whole source file. Making the graph a local cache (and so gitignored) silently
 * broke that: **ripgrep honours `.gitignore`**, and every ripgrep-backed search
 * tool inherits the blind spot — verified by a card that names a symbol which
 * default `rg` will not return and `rg -uu` finds instantly. `.ignore` is read at
 * higher precedence than `.gitignore`, so re-admitting the tree there restores
 * search without git ever tracking a byte of it.
 *
 * The two negative entries matter as much as the positive one: `.cache/` holds a
 * multi-MB parse memo and `.graph/` holds `wiring.json`, and dropping either into
 * every repo-wide search would be worse than the problem being fixed.
 *
 * Same contract as {@link ensureGitignored}: idempotent, skips a context dir
 * outside `root`, and swallows write failures — a build that already succeeded
 * must not fail over a convenience file.
 */
export function ensureSearchable(root: string, contextDir: string): void {
  if (envTruthy("GRAFT_NO_IGNORE")) return;
  // trail's map is reached by the path the hooks name, not by a grep from the root: no `.ignore`.
  if (isTrailMapDir(root, contextDir)) return;
  const rel = relPosix(root, contextDir);
  if (rel === "" || rel.startsWith("..")) return; // outside the repo — nothing to re-admit
  const dir = stripTrailingSlashes(rel);
  const entry = `!${dir}/`;
  const path = join(root, ".ignore");
  let current = "";
  try { current = readFileSync(path, "utf8"); } catch { /* no .ignore yet — we create one */ }
  // Any mention of the negation means a human (or a previous build) has already
  // had an opinion here; leave it alone rather than append a second copy.
  if (current.split("\n").some((l) => l.trim() === entry)) return;
  const gap = current === "" ? "" : current.endsWith("\n") ? "\n" : "\n\n";
  const block =
    `${gap}# graft's cards are gitignored but should stay greppable: ripgrep reads\n` +
    `# .ignore before .gitignore, so this re-admits the tree to search only.\n` +
    `${entry}\n${dir}/${CACHE_DIR}/\n${dir}/${GRAPH_DIR}/\n`;
  try { writeFileSync(path, current + block); } catch { /* best-effort */ }
}

/** Render the generated body (Summary + Related) for a node. */
function renderGenerated(node: ContextNode): string {
  const lines = [`## Summary`, ``, node.summary.trim() || "_(no summary)_", ``];
  if (node.links.length > 0) {
    lines.push(`## Related`, ``);
    for (const link of [...node.links].sort((a, b) => a.to.localeCompare(b.to))) {
      const rel = link.relation.replace(/_/g, " ");
      const tail = link.description ? ` — ${link.description}` : "";
      lines.push(`- ${rel} [[${link.to}]]${tail}`);
    }
    lines.push(``);
  }
  return lines.join("\n");
}

/** Default human region for a brand-new node (preserved verbatim afterwards). */
function defaultHuman(): string {
  return `\n## Notes\n\n_Anything written below the generated block is preserved when the graph is regenerated._\n`;
}

/** Serialize a node to its full markdown file contents. */
export function renderNodeFile(node: ContextNode): string {
  const data = {
    name: node.name,
    slug: node.slug,
    type: node.type,
    sources: node.sources.map((s) => ({ path: s.path, hash: s.hash })),
    sources_digest: node.sourcesDigest,
    links: node.links.map((l) =>
      l.description ? { to: l.to, relation: l.relation, description: l.description } : { to: l.to, relation: l.relation },
    ),
    generator: { version: MANIFEST_VERSION },
  };
  const body = `${GEN_START}\n${renderGenerated(node)}${GEN_END}\n${node.human}`;
  // gray-matter appends a trailing newline; keep output stable across runs.
  return matter.stringify(body, data);
}

/**
 * Extract the human region (everything after the generated-end marker) from an
 * existing node file so it survives regeneration. If the markers are missing
 * (a hand-deleted or foreign file), returns a fresh default region.
 */
function preserveHuman(existingContent: string): string {
  const idx = existingContent.indexOf(GEN_END);
  if (idx === -1) return defaultHuman();
  return existingContent.slice(idx + GEN_END.length).replace(/^\n/, "");
}

/**
 * Write a node file, preserving any existing human region. Returns the file
 * path written.
 */
export function writeNode(dir: string, node: ContextNode): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${node.slug}.md`);
  if (existsSync(path)) {
    const parsed = matter(readFileSync(path, "utf8"));
    node = { ...node, human: preserveHuman(parsed.content) };
  } else {
    node = { ...node, human: node.human || defaultHuman() };
  }
  writeFileSync(path, renderNodeFile(node));
  return path;
}

/** A node file parsed back off disk (frontmatter only; body is not needed for `check`). */
export interface ParsedNode {
  slug: string;
  name: string;
  type: string;
  sources: SourceRef[];
  sourcesDigest: string;
  links: NodeLink[];
}

/**
 * Stems of per-file wiring cards that sit at the graft/ top level — i.e. cards
 * for source files in the repo root. Those cards share a directory with concept
 * nodes (`graft/<stem>.md`) but are recorded in `manifest.files`, not
 * `manifest.nodes`. Nested file cards live in subdirs and are never scanned here.
 *
 * Incomplete on its own (#261): the graph can write a root card for a source
 * that the concept pipeline never recorded (different extension lists), so the
 * stem is absent from `manifest.files`. Combined with isRootFileCard().
 */
function rootFileCardStems(dir: string): Set<string> {
  const manifest = readManifest(dir);
  if (!manifest) return new Set();
  const stems = new Set<string>();
  for (const f of manifest.files) {
    if (f.path.includes("/")) continue;
    stems.add(f.path.replace(/\.[^./]+$/, ""));
  }
  return stems;
}

function hasConceptSlug(fm: Record<string, unknown>): boolean {
  return fm.slug != null && String(fm.slug).length > 0;
}

/** `writeCovers` used to stamp `covers: []` onto slug-less root file cards. */
function isCoversOnlyFileCard(fm: Record<string, unknown>): boolean {
  if (hasConceptSlug(fm) || !("covers" in fm)) return false;
  return fm.name == null && fm.type == null && fm.sources == null;
}

/** Wiring cards start with `# <source path with extension>`, optionally followed
 * by ` · [[slug]]` up-links. A hand-dropped `notes.md` does not. */
function isWiringCardHeading(content: string): boolean {
  const line = content.trimStart().split(/\r?\n/, 1)[0] ?? "";
  return /^# [^\s#]+\.[A-Za-z0-9]{1,12}(?:\s|$)/.test(line);
}

/**
 * A top-level `.md` that is a per-file wiring card, not a concept node.
 * Real concepts always carry `slug` in frontmatter and are never skipped.
 * A hand-dropped `notes.md` has no slug, no `covers`, and no file-path heading,
 * so it still surfaces as indexDrift (#215 / #261).
 */
function isRootFileCard(
  stem: string,
  fm: Record<string, unknown>,
  content: string,
  fileCardStems: Set<string>,
): boolean {
  if (hasConceptSlug(fm)) return false;
  if (fileCardStems.has(stem)) return true;
  if (isCoversOnlyFileCard(fm)) return true;
  return isWiringCardHeading(content);
}

/** Read and parse every concept-node `.md` in a context dir (skips INDEX.md
 * and root-level per-file cards). */
export function readNodes(dir: string): ParsedNode[] {
  if (!existsSync(dir)) return [];
  const fileCardStems = rootFileCardStems(dir);
  const out: ParsedNode[] = [];
  for (const entry of readdirSync(dir)) {
    if (!entry.endsWith(".md") || entry === "INDEX.md") continue;
    const parsed = matter(readFileSync(join(dir, entry), "utf8"));
    const fm = parsed.data as Record<string, unknown>;
    const fallbackSlug = entry.replace(/\.md$/, "");
    if (isRootFileCard(fallbackSlug, fm, parsed.content, fileCardStems)) continue;
    out.push({
      slug: String(fm.slug ?? fallbackSlug),
      name: String(fm.name ?? ""),
      type: String(fm.type ?? ""),
      sources: Array.isArray(fm.sources) ? (fm.sources as SourceRef[]) : [],
      sourcesDigest: String(fm.sources_digest ?? ""),
      links: Array.isArray(fm.links) ? (fm.links as NodeLink[]) : [],
    });
  }
  return out;
}

/** List the node files present (slug → filename), for pruning deleted nodes. */
export function existingNodeSlugs(dir: string): Set<string> {
  if (!existsSync(dir)) return new Set();
  return new Set(
    readdirSync(dir)
      .filter((e) => e.endsWith(".md") && e !== "INDEX.md")
      .map((e) => e.replace(/\.md$/, "")),
  );
}

/** Delete a node file by slug. */
export function deleteNode(dir: string, slug: string): void {
  const path = join(dir, `${slug}.md`);
  if (existsSync(path)) rmSync(path);
}

export function writeManifest(dir: string, manifest: Manifest): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, MANIFEST_FILE), JSON.stringify(manifest, null, 2) + "\n");
}

export function readManifest(dir: string): Manifest | undefined {
  const path = join(dir, MANIFEST_FILE);
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Manifest;
  } catch {
    return undefined;
  }
}
