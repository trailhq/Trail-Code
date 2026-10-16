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
  /** Missing in graphs built before Unicode slug upgrades were recorded. */
  slugPolicy?: string;
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
export const SLUG_POLICY = "unicode-nfc";
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
    .normalize("NFC")
    .replace(/[^\p{L}\p{N}\p{M}]+/gu, "-")
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
 * or the dir lives outside `root` (a custom `--dir` elsewhere, which can't be
 * expressed as a repo-relative ignore). Best-effort: an unwritable `.gitignore`
 * must never abort a build, so write failures are swallowed.
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
  // Accept the anchored form AND the older unanchored `graft/` / `graft`, so existing
  // repos aren't double-appended and a hand-anchored entry survives the next build.
  const present = current.split("\n").some((l) => {
    const t = l.trim();
    return t === entry || t === `${bare}/` || t === bare;
  });
  if (present) return;
  const gap = current === "" ? "" : current.endsWith("\n") ? "\n" : "\n\n";
  const block = `${gap}# ${note}\n${entry}\n`;
  try { writeFileSync(path, current + block); } catch { /* best-effort — build already succeeded */ }
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

/** Carry unambiguous notes across the old ASCII slug policy; retain every
 * changed note file in the cache when an old slug may have merged concepts. */
export function preserveRenamedNodeNotes(dir: string, nodes: ContextNode[]): void {
  const key = (name: string) => normalizeName(name).normalize("NFC");
  const legacy = (name: string) => normalizeName(name).replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "node";
  const previousManifest = readManifest(dir);
  const previousRoster = new Map(previousManifest?.nodes.map(node => [node.slug, node]) ?? []);
  const byName = new Map(nodes.map(node => [key(node.name), node]));
  const byLegacy = new Map<string, ContextNode[]>();
  for (const node of nodes) {
    const slug = legacy(node.name);
    byLegacy.set(slug, [...(byLegacy.get(slug) ?? []), node]);
  }
  for (const previous of readNodes(dir)) {
    if (!/^[a-z0-9-]+$/.test(previous.slug)) continue;
    // NFC and NFD names can have different old ASCII slugs (caf / cafe),
    // while now identifying the same concept.
    const sameName = byName.get(key(previous.name));
    const candidates = [...new Set([...(byLegacy.get(previous.slug) ?? []), ...(sameName ? [sameName] : [])])];
    if (candidates.length === 0) continue;
    const sameSlug = nodes.find(node => node.slug === previous.slug);
    // A legacy merged node may be named after its ASCII primary concept.
    // After the upgrade, notes on that primary concept are its own again.
    const alreadySeparated = candidates.every(node => {
      const recorded = previousRoster.get(node.slug);
      return recorded && key(recorded.name) === key(node.name);
    });
    if (sameSlug && key(sameSlug.name) === key(previous.name) &&
        (candidates.length === 1 || previousManifest?.slugPolicy === SLUG_POLICY || alreadySeparated)) continue;
    const path = join(dir, `${previous.slug}.md`);
    if (!existsSync(path)) continue;
    const content = readFileSync(path, "utf8");
    const human = preserveHuman(matter(content).content);
    if (!human.trim() || human.trim() === defaultHuman().trim()) continue;

    // The full content hash makes backups stable and prevents overwriting a
    // different historical note file on a later upgrade.
    const backupDir = join(dir, CACHE_DIR, "slug-upgrades");
    mkdirSync(backupDir, { recursive: true });
    const backup = join(backupDir, `${previous.slug}-${contentHash(content)}.md`);
    if (!existsSync(backup)) writeFileSync(backup, content, { flag: "wx" });
    else if (readFileSync(backup, "utf8") !== content) throw new Error(`Conflicting legacy notes backup: ${backup}`);

    const matching = candidates.filter(node => key(node.name) === key(previous.name));
    if (candidates.length === 1 && matching.length === 1 && !matching[0].human && !existsSync(join(dir, `${matching[0].slug}.md`))) {
      matching[0].human = human;
    } else {
      console.error(`Legacy notes for ${previous.name} were saved to ${backup}; review them before assigning them to a concept.`);
    }
    // A newly distinct concept may reuse the old ASCII slug. Its notes must
    // not inherit the former merged concept's human region.
    if (sameSlug) rmSync(path);
  }
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
