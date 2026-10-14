/**
 * The per-file half of `buildGraph`'s parse loop: read, hash, pick a tier,
 * extract. Pure apart from the read, and it never touches the cache or the graph:
 * the caller decides what to do with each outcome. Kept separate so the same
 * code runs in-thread for a small refresh and inside a forked parser child for
 * a large cold build (`parse-worker.ts`), and the two cannot drift.
 */
import { extractFile, languageLabelOf, languageOf } from "./extract.js";
import { extractGeneric, genericLangOf } from "./generic.js";
import { containerLangOf, extractContainer } from "./container.js";
import { contentHash } from "../util/id.js";
import { readSourceFile } from "../util/source.js";
import type { ExtractEntry } from "./extract-cache.js";
import type { SourceStat } from "./source-files.js";

export type ExtractOneResult =
  | { kind: "reused"; hash: string }
  | { kind: "skipped"; entry: ExtractEntry }
  | { kind: "parsed"; entry: ExtractEntry; label: string }
  | { kind: "error"; entry: ExtractEntry; message: string };

/** Grammars must already be warmed (`warmGenericGrammars`, `warmContainerGrammars`). */
export function extractOne(f: SourceStat, cachedHash: string | null): ExtractOneResult {
  const rel = f.rel;
  // Depth tier (hand-written, native grammar) if a language claims the file;
  // otherwise the breadth tier (generic tags.scm over a WASM grammar). A container
  // is neither: checked before the breadth tier so a grammar claiming .vue can't
  // shadow it.
  const lang = languageOf(f.abs);
  const container = lang ? null : containerLangOf(f.abs);
  const generic = lang || container ? null : genericLangOf(f.abs);
  const label = languageLabelOf(f.abs) ?? container?.name ?? generic?.name ?? "unknown";

  // Every file is read and hashed, every build; only the parse is memoized.
  // Trusting (size, mtime) here would make a same-length edit inside one mtime
  // tick invisible to `graft build`, which `graft check` (always hashing) would
  // then report as drift the build refuses to repair.
  let source: string | null;
  try {
    source = readSourceFile(f.abs);
  } catch (err) {
    const message = `${rel}: ${err instanceof Error ? err.message : String(err)}`;
    return { kind: "skipped", entry: { size: f.size, mtimeMs: f.mtimeMs, hash: "", nodes: [], rawEdges: [], error: message } };
  }
  if (source === null) {
    // Unsupported encoding (UTF-16BE): a skip, never an error.
    return { kind: "skipped", entry: { size: f.size, mtimeMs: f.mtimeMs, hash: "", nodes: [], rawEdges: [] } };
  }

  const hash = contentHash(source);
  if (cachedHash !== null && hash === cachedHash) return { kind: "reused", hash };

  try {
    const { nodes, rawEdges } = lang
      ? extractFile(rel, source, lang)
      : container
        ? extractContainer(rel, source, container)
        : extractGeneric(rel, source, generic!.name);
    return { kind: "parsed", label, entry: { size: f.size, mtimeMs: f.mtimeMs, hash, nodes, rawEdges } };
  } catch (err) {
    const message = `${rel}: parse failed — ${err instanceof Error ? err.message : String(err)}`;
    return { kind: "error", message, entry: { size: f.size, mtimeMs: f.mtimeMs, hash, nodes: [], rawEdges: [], error: message } };
  }
}
