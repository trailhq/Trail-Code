/**
 * Tier-2 "meaning" call for the code graph — batched per file, chunked by symbol
 * count so a dense file cannot blow `maxTokens` and drop the whole reply (#260).
 *
 * Given a source file (with 1-based line numbers) and the list of definitions in
 * it, one call (or several chunks of {@link CRUX_CHUNK_SIZE}) returns, for each
 * definition:
 *   1. `summary` — one plain-English sentence: what the symbol is *for*, at the
 *      business-logic level, not a restatement of its signature.
 *   2. `crux_start`/`crux_end` — the smallest contiguous range of FILE line
 *      numbers (inside that symbol's own span) that a reviewer must read to see
 *      the decision or rule the code encodes. `0/0` means there is no single
 *      crux (a trivial getter, a plain data holder).
 *
 * Small files still cost one request. Files denser than {@link CRUX_CHUNK_SIZE}
 * are split, the chunks merged, and a `finish_reason=length` stop is logged
 * instead of silently discarding every target. Line numbers are consumed once,
 * at write time, to slice the crux text verbatim from source.
 */
import type { ChatModel, ChatResponse } from "./llm/types.js";
import { recoverToolArgsFromContent, warnToolChoiceIgnored } from "./llm/recover-tool.js";
import type { Kind } from "../graph/types.js";

/** One definition we want described, located by its line span within the file. */
export interface NodeRef {
  id: string;
  kind: Kind;
  signature: string | null;
  startLine: number; // 1-based file line where the definition starts
  endLine: number;
}

export interface FileCruxInput {
  path: string;
  source: string;
  nodes: NodeRef[];
}

export interface NodeCrux {
  id: string;
  summary: string;
  crux_start: number; // file line, within the symbol's span; 0 = no distinct crux
  crux_end: number;
}

/** A provider failure after earlier chunks returned; preserve both results and the error. */
export class CruxChunkError extends Error {
  readonly partialResults: NodeCrux[];

  constructor(partialResults: readonly NodeCrux[], cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = "CruxChunkError";
    this.partialResults = [...partialResults];
  }
}

export interface CruxSummarizer {
  describeFile(input: FileCruxInput): Promise<NodeCrux[]>;
  /** Set by {@link ChatCruxSummarizer} after each call; optional on fakes. */
  lastMiss?: CruxMiss | null;
}

/** Why a crux call produced no usable summaries (#235). */
export type CruxMissKind = "empty-toolCalls" | "unparseable" | "truncated" | "empty-parsed";

export interface CruxMiss {
  kind: CruxMissKind;
  finishReason: string | null;
}

function isTruncatedStop(reason: string | null): boolean {
  if (!reason) return false;
  const r = reason.toLowerCase();
  return r === "length" || r === "max_tokens";
}

/** Classify an empty/unusable crux reply. `null` means at least one usable summary. */
export function classifyCruxMiss(res: ChatResponse, parsed: NodeCrux[]): CruxMiss | null {
  const finishReason = res.stopReason;
  if (parsed.some((p) => p.summary.trim())) return null;
  if (isTruncatedStop(finishReason)) return { kind: "truncated", finishReason };
  if (parsed.length > 0) return { kind: "empty-parsed", finishReason };
  const emptyTools = res.toolCalls.length === 0;
  const emptyText = !res.text?.trim();
  if (emptyTools && emptyText) return { kind: "empty-toolCalls", finishReason };
  return { kind: "unparseable", finishReason };
}

/** Per-file error text: miss class + the provider's finish_reason (#235). */
export function formatCruxMiss(kind: CruxMissKind, finishReason: string | null): string {
  const fr = finishReason == null || finishReason === "" ? "null" : finishReason;
  return `model returned no usable symbol summaries [${kind}, finish_reason=${fr}]`;
}

/** One stderr line when a crux call stopped because the completion hit maxTokens (#260). */
function warnCruxTruncated(
  path: string,
  requested: number,
  parsed: number,
  finishReason: string | null,
): void {
  const fr = finishReason == null || finishReason === "" ? "null" : finishReason;
  console.error(
    `⚠ crux: ${path}: truncated tool response [finish_reason=${fr}] for ${requested} targets (${parsed} parsed) — keeping any other chunks instead of dropping the file`,
  );
}

const SYSTEM_PROMPT = `You explain code definitions for a code graph that helps engineers navigate a codebase.

You are given ONE source file with 1-based line numbers, and a list of TARGET definitions in it. Describe EVERY target via the record_symbols tool.

Rules:
- Return EXACTLY ONE entry for EVERY target id, using that id verbatim. The number of entries you return MUST equal the number of targets. Never omit a target: a reply missing any id is invalid and will be re-requested.
- A trivial symbol is NOT an exception. You still return it — with a one-sentence summary and crux 0/0 (see below). "Skip" means "give it no crux span", NEVER "leave it out".
- summary: ONE sentence — what the symbol is FOR at the business-logic level (the problem it solves or the rule it enforces), not a restatement of its signature.
- crux_start / crux_end: FILE line numbers (as shown), inside that symbol's own line range. Pick the SINGLE most important contiguous span — the core branch, formula, guard, or state change — at most ~8 lines, and NEVER the whole function. When there is no single focal span (a trivial getter, a plain data holder, a one-line delegation, or logic spread evenly), use crux_start: 0 and crux_end: 0. That 0/0 IS the answer — do not drop the entry.`;

const RECORD_TOOL = "record_symbols";

const SYMBOLS_SCHEMA = {
  type: "object",
  properties: {
    symbols: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          summary: { type: "string" },
          crux_start: { type: "number" },
          crux_end: { type: "number" },
        },
        required: ["id", "summary", "crux_start", "crux_end"],
      },
    },
  },
  required: ["symbols"],
} as const;

/**
 * Max targets packed into one crux LLM call (#260). At ~90 completion tokens per
 * entry, 80 × 90 stays under `maxTokens: 8192`. A file with more symbols is split
 * and the chunks merged; raising maxTokens cannot cover a 698-symbol file.
 * Pinned by `test/crux-chunk.test.ts` — do not raise it silently.
 */
export const CRUX_CHUNK_SIZE = 80;

/** Split `nodes` into batches of at most `size` (default {@link CRUX_CHUNK_SIZE}). */
export function chunkCruxTargets<T>(nodes: readonly T[], size = CRUX_CHUNK_SIZE): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < nodes.length; i += size) out.push(nodes.slice(i, i + size));
  return out;
}

/** Cap the file text sent per request so one huge file can't blow the context. */
const MAX_CODE_CHARS = 18_000;

/**
 * Slice `source` to the contiguous file-absolute span of `nodes`. Later chunks
 * of a dense file must not reuse the file prefix — `numberLines` clips 18k
 * chars from the start of whatever it is given, so sending the whole file made
 * chunk N describe symbols it never saw.
 */
function sourceWindow(
  source: string,
  nodes: readonly Pick<NodeRef, "startLine" | "endLine">[],
): { text: string; from: number } {
  if (nodes.length === 0) return { text: source, from: 1 };
  const lines = source.split("\n");
  const last = Math.max(1, lines.length);
  let from = Math.min(...nodes.map((n) => n.startLine));
  let to = Math.max(...nodes.map((n) => n.endLine));
  from = Math.max(1, Math.min(from, last));
  to = Math.max(from, Math.min(to, last));
  return { text: lines.slice(from - 1, to).join("\n"), from };
}

/**
 * Pack targets until either the response-size limit or the visible source
 * window would be exceeded. Count-only chunks can still span more than 18k
 * characters when symbols are sparse, causing `numberLines` to hide the later
 * targets in an otherwise successful request.
 */
function chunkCruxInput(input: FileCruxInput): NodeRef[][] {
  const chunks: NodeRef[][] = [];
  let chunk: NodeRef[] = [];
  for (const node of input.nodes) {
    const candidate = [...chunk, node];
    if (
      chunk.length > 0 &&
      (candidate.length > CRUX_CHUNK_SIZE ||
        sourceWindow(input.source, candidate).text.length > MAX_CODE_CHARS)
    ) {
      chunks.push(chunk);
      chunk = [];
    }
    chunk.push(node);
  }
  if (chunk.length > 0) chunks.push(chunk);
  return chunks;
}

function numberLines(source: string, fromLine = 1): string {
  const clipped =
    source.length > MAX_CODE_CHARS ? `${source.slice(0, MAX_CODE_CHARS)}\n… (truncated)` : source;
  return clipped
    .split("\n")
    .map((line, i) => `${fromLine + i}\t${line}`)
    .join("\n");
}

function userContent(input: FileCruxInput): string {
  const targets = input.nodes
    .map(
      (n) =>
        `- id=${n.id} | ${n.kind} | lines L${n.startLine}-L${n.endLine}` +
        (n.signature ? ` | ${n.signature}` : ""),
    )
    .join("\n");
  const n = input.nodes.length;
  const { text, from } = sourceWindow(input.source, input.nodes);
  return `FILE: ${input.path}\n\n${numberLines(text, from)}\n\nTARGETS (${n} — return all ${n}, one entry per id):\n${targets}`;
}

/** Normalize the tool's parsed argument object into a {@link NodeCrux} list. */
function parseResults(obj: { symbols?: unknown } | undefined): NodeCrux[] {
  if (!obj || !Array.isArray(obj.symbols)) return [];
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? Math.trunc(v) : 0);
  return obj.symbols
    .map((s) => s as Record<string, unknown>)
    .filter((s) => typeof s.id === "string")
    .map((s) => ({
      id: s.id as string,
      summary: typeof s.summary === "string" ? s.summary.trim() : "",
      crux_start: num(s.crux_start),
      crux_end: num(s.crux_end),
    }));
}

/**
 * Some OpenAI-compatible gateways ignore forced `tool_choice` and put the tool
 * payload in `content` instead (plain `{symbols:…}`, fenced JSON, or an emulated
 * `[{name, parameters}]` array). Without this recovery the meaning pass sees an
 * empty `toolCalls` list, leaves every node `pending`, and `graft check` loops
 * on "run --deep" forever (#172; same trigger as #129 for the crux path).
 */
function argsFromResponse(res: { text: string; toolCalls: { name: string; args: unknown }[] }): {
  symbols?: unknown;
} | undefined {
  const call = res.toolCalls.find((c) => c.name === RECORD_TOOL) ?? res.toolCalls[0];
  if (call?.args && typeof call.args === "object" && !Array.isArray(call.args)) {
    return call.args as { symbols?: unknown };
  }
  const recovered = recoverToolArgsFromContent(res.text, {
    toolNames: [RECORD_TOOL, "emit_json"],
    payloadKey: "symbols",
  });
  if (!recovered) warnToolChoiceIgnored("crux", res.text?.trim() ? "unparsed" : "empty");
  return recovered as { symbols?: unknown } | undefined;
}

/** Crux summarizer backed by any {@link ChatModel} via forced tool calling. */
export class ChatCruxSummarizer implements CruxSummarizer {
  lastMiss: CruxMiss | null = null;

  constructor(private model: ChatModel) {}

  async describeFile(input: FileCruxInput): Promise<NodeCrux[]> {
    this.lastMiss = null;
    if (input.nodes.length === 0) return [];
    const merged: NodeCrux[] = [];
    const seen = new Set<string>();
    let miss: CruxMiss | null = null;

    for (const nodes of chunkCruxInput(input)) {
      const { parsed, res } = await this.describeChunk({ ...input, nodes }).catch((cause: unknown) => {
        if (merged.length > 0) throw new CruxChunkError(merged, cause);
        throw cause;
      });
      if (isTruncatedStop(res.stopReason)) {
        warnCruxTruncated(input.path, nodes.length, parsed.length, res.stopReason);
      }
      const chunkMiss = classifyCruxMiss(res, parsed);
      if (chunkMiss) miss = chunkMiss;
      for (const r of parsed) {
        if (seen.has(r.id)) continue;
        seen.add(r.id);
        merged.push(r);
      }
    }

    this.lastMiss = merged.some((p) => p.summary.trim()) ? null : miss;
    return merged;
  }

  private async describeChunk(input: FileCruxInput): Promise<{ parsed: NodeCrux[]; res: ChatResponse }> {
    const res = await this.model.create({
      temperature: 0,
      maxTokens: 8192,
      tools: [
        {
          name: RECORD_TOOL,
          description: "Record each target definition's purpose and crux line range.",
          parameters: SYMBOLS_SCHEMA as unknown as Record<string, unknown>,
        },
      ],
      responseFormat: { kind: "tool", name: RECORD_TOOL },
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userContent(input) },
      ],
    });
    return { parsed: parseResults(argsFromResponse(res)), res };
  }
}
