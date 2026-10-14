/**
 * Container tier — files that are not a language but a wrapper around one.
 *
 * A Vue SFC is the motivating case: `.vue` is HTML-shaped, and everything worth
 * indexing lives inside its `<script>` block. Registering `tree-sitter-vue` as a
 * breadth-tier language (generic.ts) would not help — that grammar parses the
 * shell (`<template>` / `<script>` / `<style>`) and hands back the script body as
 * one opaque `raw_text` node, so the cards would come out empty. Svelte is the
 * same shape, and Astro adds a second block: the `---` frontmatter fence, where a
 * component's imports and logic actually live.
 *
 * So the container grammar is used only to answer "where does the embedded
 * language start and end", and the block itself goes to the DEPTH-tier extractor
 * (extract.ts). A `.vue` file therefore gets the same quality of extraction as a
 * `.ts` file — bindings, imports, resolved calls — not the signature-only output
 * the breadth tier would give.
 *
 * **The span shift is the whole risk here.** `extractFile` numbers its spans from
 * the start of the string it was handed, so every node comes back pointing at a
 * line in the script, not in the `.vue`. A span that is off by even one line is
 * worse than not indexing the file at all: graft's promise is that its
 * `file:line` is exact, and a plausible-but-wrong line silently sends the reader
 * to the wrong place. `test/container-extract.test.ts` pins this against
 * fixtures whose true line numbers are known.
 */
import { extractFile, mintId, type ExtractResult, type Language, type RawEdge } from "./extract.js";
import { loadWasmLanguage, parseWasm, type TsNode } from "./generic.js";
import { contentHash } from "../util/id.js";
import type { NodeV1 } from "./types.js";

/** A container language: the wrapper grammar, the node that holds the embedded
 * source, and which depth-tier extractor to hand that source to. */
export interface ContainerLang {
  name: string;
  exts: string[];
  /** wasm basename in tree-sitter-wasms/out/tree-sitter-<wasm>.wasm */
  wasm: string;
  /** Every kind of node that carries embedded source, in the wrapper grammar's
   * own terms. Vue and Svelte have one; Astro has two (frontmatter + script). */
  blocks: readonly EmbeddedBlock[];
  /** Look for blocks anywhere in the tree, not only among the document's direct
   * children. Astro hoists a `<script>` from wherever it sits in the markup —
   * a quarter of the ones carrying imports in Astro's own repo are inside a
   * `<Layout>` — whereas Vue and Svelte only treat a top-level one as the
   * component's script, and a nested one is markup. */
  deep?: boolean;
  /** Depth-tier grammar for the embedded language. TypeScript is a superset of
   * JavaScript, so it parses both `<script>` and `<script lang="ts">`. */
  inner: Language;
}

/** One place a wrapper grammar keeps embedded source. */
export interface EmbeddedBlock {
  /** Wrapper node that represents one embedded block (e.g. Vue's script_element). */
  block: string;
  /** Child of `block` holding the raw embedded source (e.g. Vue's raw_text). */
  body: string;
}

/** `<script>…</script>` as the HTML-derived grammars (Vue, Svelte, Astro) all
 * expose it. Where the `raw_text` *starts* differs — Vue and Astro begin it
 * right after the tag's `>`, Svelte at the first non-blank character of the
 * next line — but `extractContainer` reads the offset off the node itself, so
 * the difference never reaches a span. */
const SCRIPT_TAG: EmbeddedBlock = { block: "script_element", body: "raw_text" };

/** The container registry. Each row was verified against a real repo before it
 * landed — a wrong `body` node type would produce silently misplaced spans,
 * which is worse than no support — so a new row should come with the same
 * check (see `test/container-extract.test.ts`, "spans point at the … line"). */
export const CONTAINER_LANGS: readonly ContainerLang[] = [
  { name: "vue", exts: [".vue"], wasm: "vue", blocks: [SCRIPT_TAG], inner: "typescript" },
  { name: "svelte", exts: [".svelte"], wasm: "svelte", blocks: [SCRIPT_TAG], inner: "typescript" },
  // The frontmatter is where an Astro component imports and computes; `<script>`
  // is the client-side island. Both are TypeScript by Astro's own default.
  {
    name: "astro",
    exts: [".astro"],
    wasm: "astro",
    blocks: [{ block: "frontmatter", body: "frontmatter_js_block" }, SCRIPT_TAG],
    deep: true,
    inner: "typescript",
  },
];

const byExt = new Map<string, ContainerLang>();
for (const l of CONTAINER_LANGS) for (const e of l.exts) byExt.set(e, l);

/** The container language for a path, or null if none claims it. */
export function containerLangOf(path: string): ContainerLang | null {
  const lower = path.toLowerCase();
  for (const [ext, l] of byExt) if (lower.endsWith(ext)) return l;
  return null;
}

/** Every file extension the container tier claims. */
export function containerExtensions(): string[] {
  return CONTAINER_LANGS.flatMap((l) => l.exts);
}

const loaded = new Map<string, unknown>();

/** Warm the container grammars this repo needs. Same contract as
 * `warmGenericGrammars`: await once before the synchronous parse loop, and an
 * unavailable grammar is skipped rather than fatal (its files then extract to a
 * file node only, exactly as they do today). */
export async function warmContainerGrammars(langNames: Iterable<string>): Promise<void> {
  for (const name of new Set(langNames)) {
    if (loaded.has(name)) continue;
    const row = CONTAINER_LANGS.find((l) => l.name === name);
    if (!row) continue;
    const language = await loadWasmLanguage(row.wasm);
    if (language) loaded.set(name, language);
  }
}

/** True if a container grammar has been warmed (else extraction is file-only). */
export function isContainerWarm(langName: string): boolean {
  return loaded.has(langName);
}

/** `L12-L20` shifted by n lines. The span format is produced in exactly two
 * places (extract.ts and generic.ts) and is always this shape; anything else is
 * returned untouched rather than guessed at. */
function shiftSpan(span: string, lines: number): string {
  const m = /^L(\d+)-L(\d+)$/.exec(span);
  if (!m) return span;
  return `L${Number(m[1]) + lines}-L${Number(m[2]) + lines}`;
}

/** The container file's own node. Deliberately describes the whole file — line
 * count, hash and size of the SFC, not of the script block — because that is
 * what a reader opening this path will see. */
function containerFileNode(rel: string, source: string, residual: string): NodeV1 {
  return {
    id: rel,
    name: rel.split("/").pop() ?? rel,
    kind: "file",
    path: rel,
    span: `L1-L${Math.max(1, source.split("\n").length)}`,
    signature: null,
    exported: true,
    // "ast", not "generic": the symbols under this file come from the depth-tier
    // extractor with real bindings and specifiers. resolve.ts gates a
    // guess-by-name fallback on `origin === "generic"`, and these nodes must not
    // take it — they carry the information to resolve properly.
    origin: "ast",
    body_hash: contentHash(source),
    chars: source.length,
    body_text: residual,
    summary_state: "pending",
    summary: null,
    crux: null,
  };
}

/** Every embedded block in document order, as [bodyNode] — an SFC may legally
 * carry two (`<script>` for options/exports plus `<script setup>`; Svelte's
 * `<script module>` plus instance script; Astro's frontmatter plus `<script>`),
 * and each needs its own offset. */
function blocks(root: TsNode, lang: ContainerLang): TsNode[] {
  const out: TsNode[] = [];
  const visit = (parent: TsNode): void => {
    const n = parent.namedChildCount ?? 0;
    for (let i = 0; i < n; i++) {
      const child = parent.namedChild?.(i);
      if (!child) continue;
      const kind = lang.blocks.find((b) => b.block === child.type);
      if (!kind) {
        // A block cannot nest inside another block, so the descent stops at one.
        if (lang.deep) visit(child);
        continue;
      }
      const kids = child.namedChildCount ?? 0;
      for (let j = 0; j < kids; j++) {
        const body = child.namedChild?.(j);
        // An empty `<script></script>` has no body child at all — skipped here, so
        // the file still gets its file node and nothing else, which is the same
        // shape as a file whose grammar is missing.
        if (body && body.type === kind.body) out.push(body);
      }
    }
  };
  visit(root);
  return out;
}

/**
 * Extract one container file. Synchronous; needs the grammar pre-warmed.
 *
 * Never throws: a missing grammar, an unparseable SFC or a script block the
 * inner extractor chokes on all degrade to "fewer nodes", because a build must
 * not fail over one component.
 */
export function extractContainer(rel: string, source: string, lang: ContainerLang): ExtractResult {
  const nodes: NodeV1[] = [];
  const rawEdges: RawEdge[] = [];
  const residuals: string[] = [];

  const language = loaded.get(lang.name);
  const root = language ? parseWasm(language, source) : null;

  if (root) {
    // Ids are minted per file by the inner extractor, so two script blocks that
    // both define `setup` would collide. Threading one set across the blocks
    // makes the second one `path#setup~2`, and the rename is applied to that
    // block's edges too so nothing points at an id that no longer exists.
    const minted = new Set<string>([rel]);

    for (const body of blocks(root, lang)) {
      const script = source.slice(body.startIndex, body.endIndex);

      let inner: ExtractResult;
      try {
        inner = extractFile(rel, script, lang.inner);
      } catch {
        continue; // one bad block, not a bad build
      }

      // Script line N lands on file line (row + N), where `row` is the 0-based
      // row of the body node's first character — regardless of where on that
      // row it sits. Vue's `raw_text` starts right after the tag's `>` (row =
      // tag row, slice begins with that line's newline, so script line 1 is
      // the tail of the tag line); Svelte's starts at the first non-blank
      // character of the next line (row = tag row + 1, script line 1 is that
      // line); Astro's frontmatter block starts right after the opening `---`.
      // All three reduce to "add the start row to a 1-based span". Taking the
      // row from the wrapper node instead would look equivalent and be right
      // only when the tag has no attributes and no blank line follows it.
      const shift = body.startPosition.row;

      // nodes[0] is the script's own file node: it describes the block, not the
      // file, so it is dropped and its residual folded into the .vue file node.
      const [scriptFile, ...symbols] = inner.nodes;
      if (scriptFile?.body_text) residuals.push(scriptFile.body_text);

      const renamed = new Map<string, string>();
      for (const node of symbols) {
        const id = mintId(node.id, minted);
        if (id !== node.id) renamed.set(node.id, id);
        nodes.push({ ...node, id, span: shiftSpan(node.span, shift) });
      }

      for (const edge of inner.rawEdges) {
        const source_ = renamed.get(edge.source) ?? edge.source;
        const targetId = edge.targetId === undefined ? undefined : (renamed.get(edge.targetId) ?? edge.targetId);
        rawEdges.push({ ...edge, source: source_, ...(targetId === undefined ? {} : { targetId }) });
      }
    }
  }

  // Built last so it can carry the residual, but unshifted first so the file node
  // stays at index 0 like every other tier's output.
  nodes.unshift(containerFileNode(rel, source, residuals.join("\n")));
  return { nodes, rawEdges };
}
