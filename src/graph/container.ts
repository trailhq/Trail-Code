/**
 * Container tier — files that are not a language but a wrapper around one.
 *
 * A Vue SFC is the motivating case: `.vue` is HTML-shaped, and everything worth
 * indexing lives inside its `<script>` block. Registering `tree-sitter-vue` as a
 * breadth-tier language (generic.ts) would not help — that grammar parses the
 * shell (`<template>` / `<script>` / `<style>`) and hands back the script body as
 * one opaque `raw_text` node, so the cards would come out empty.
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
import { loadWasmLanguage, parseWasm, type TsNode, type WasmTree } from "./generic.js";
import { contentHash } from "../util/id.js";
import type { NodeV1 } from "./types.js";

/** A container language: the wrapper grammar, the node that holds the embedded
 * source, and which depth-tier extractor to hand that source to. */
export interface ContainerLang {
  name: string;
  exts: string[];
  /** wasm basename in tree-sitter-wasms/out/tree-sitter-<wasm>.wasm */
  wasm: string;
  /** Wrapper node that represents one embedded block (e.g. Vue's script_element). */
  block: string;
  /** Child of `block` holding the raw embedded source (e.g. Vue's raw_text). */
  body: string;
  /** Depth-tier grammar for the embedded language. TypeScript is a superset of
   * JavaScript, so it parses both `<script>` and `<script lang="ts">`. */
  inner: Language;
}

/** The container registry. Svelte and Astro are the same shape and would be a
 * row each, but they are left out until someone has a repo to verify them
 * against — a wrong `body` node type would produce silently misplaced spans. */
export const CONTAINER_LANGS: readonly ContainerLang[] = [
  { name: "vue", exts: [".vue"], wasm: "vue", block: "script_element", body: "raw_text", inner: "typescript" },
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

/** Test seam, same shape as generic.ts's `swapGrammarForTest`. */
export function swapContainerGrammarForTest(name: string, language: unknown | null): unknown | null {
  const prev = loaded.get(name) ?? null;
  if (language) loaded.set(name, language);
  else loaded.delete(name);
  return prev;
}

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

/** The `.vue` file's own node. Deliberately describes the whole file — line
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
 * carry two (`<script>` for options/exports plus `<script setup>`), and each
 * needs its own offset. */
function blocks(root: TsNode, lang: ContainerLang): TsNode[] {
  const out: TsNode[] = [];
  const n = root.namedChildCount ?? 0;
  for (let i = 0; i < n; i++) {
    const child = root.namedChild?.(i);
    if (!child || child.type !== lang.block) continue;
    const kids = child.namedChildCount ?? 0;
    for (let j = 0; j < kids; j++) {
      const body = child.namedChild?.(j);
      // An empty `<script></script>` has no body child at all — skipped here, so
      // the file still gets its file node and nothing else, which is the same
      // shape as a file whose grammar is missing.
      if (body && body.type === lang.body) out.push(body);
    }
  }
  return out;
}

/**
 * Extract one container file. Synchronous; needs the grammar pre-warmed.
 *
 * A missing grammar, or a script block the inner extractor rejects, still
 * degrades to "fewer nodes", because a build must not fail over one component.
 * But a wrapper grammar that THROWS (a WASM abort, not a per-file syntax error)
 * propagates as a build error: swallowing it would cache a clean symbol-less
 * file as success, the exact mistake the generic tier used to make.
 */
export function extractContainer(rel: string, source: string, lang: ContainerLang): ExtractResult {
  const nodes: NodeV1[] = [];
  const rawEdges: RawEdge[] = [];
  const residuals: string[] = [];

  const language = loaded.get(lang.name);
  let tree: WasmTree | null = null;
  if (language) {
    try {
      tree = parseWasm(language, source);
    } catch (err) {
      // Same contract as the generic tier: a grammar that throws is a build error
      // for this file, never a clean file node cached as success.
      throw new Error(`${lang.name} grammar threw: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  try {
    if (tree) {
      const root = tree.rootNode;
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

        // `raw_text` starts immediately after the `>` of the opening tag, so its
        // row IS the tag's row and the slice begins with that line's newline.
        // Script line 1 is therefore the tail of the tag line, and script line N
        // lands on `.vue` line row + N — which is exactly "add the start row to a
        // 1-based span". Taking the row from the tag node instead would look
        // equivalent and be right only when the tag has no attributes.
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
  } finally {
    // The wrapper tree is a WASM-heap object; nothing frees it but this.
    tree?.delete();
  }

  // Built last so it can carry the residual, but unshifted first so the file node
  // stays at index 0 like every other tier's output.
  nodes.unshift(containerFileNode(rel, source, residuals.join("\n")));
  return { nodes, rawEdges };
}
