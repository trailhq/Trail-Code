/**
 * Tier-2 "meaning" call for the code graph — batched one request per file.
 *
 * Given a source file (with 1-based line numbers) and the list of definitions in
 * it, one call returns, for each definition:
 *   1. `summary` — one plain-English sentence: what the symbol is *for*, at the
 *      business-logic level, not a restatement of its signature.
 *   2. `crux_start`/`crux_end` — the smallest contiguous range of FILE line
 *      numbers (inside that symbol's own span) that a reviewer must read to see
 *      the decision or rule the code encodes. `0/0` means there is no single
 *      crux (a trivial getter, a plain data holder).
 *
 * Batching per file means N definitions cost one request, not N — and the model
 * sees each symbol's neighbours, which sharpens the summaries. Line numbers are
 * consumed once, at write time, to slice the crux text verbatim from source.
 */
import type { ChatModel, ChatResponse } from "./llm/types.js";
import { isTruncatedStop, recoverToolArgsFromContent, warnToolChoiceIgnored } from "./llm/recover-tool.js";
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

const SYSTEM_PROMPT = `You explain code definitions for a code graph that helps engineers navigate a codebase.

You are given ONE source file with 1-based line numbers, and a list of TARGET definitions in it. Describe EVERY target via the record_symbols tool.

Rules:
- Return EXACTLY ONE entry for EVERY target id, using that id verbatim. The number of entries you return MUST equal the number of targets. Never omit a target: a reply missing any id is invalid and will be re-requested. In the target list each id is the text in double quotes after "id=" — copy the id itself, without the quotes and without the "| <kind> | lines …" that follows them.
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

/** Cap the file text sent per request so one huge file can't blow the context. */
const MAX_CODE_CHARS = 18_000;

function numberLines(source: string): string {
  const clipped =
    source.length > MAX_CODE_CHARS ? `${source.slice(0, MAX_CODE_CHARS)}\n… (truncated)` : source;
  return clipped
    .split("\n")
    .map((line, i) => `${i + 1}\t${line}`)
    .join("\n");
}

function userContent(input: FileCruxInput): string {
  const targets = input.nodes
    .map(
      (n) =>
        // Quoted, so the `|` delimiters cannot read as part of an id that a
        // model echoes verbatim (an unquoted `id=src/x.ts | file | …` line got
        // parroted back as the id `"src/x.ts | file"`, discarding good
        // summaries).
        `- id="${n.id}" | ${n.kind} | lines L${n.startLine}-L${n.endLine}` +
        (n.signature ? ` | ${n.signature}` : ""),
    )
    .join("\n");
  const n = input.nodes.length;
  return `FILE: ${input.path}\n\n${numberLines(input.source)}\n\nTARGETS (${n} — return all ${n}, one entry per id):\n${targets}`;
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
function argsFromResponse(res: {
  text: string;
  toolCalls: { name: string; args: unknown }[];
  stopReason?: string | null;
}): {
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
  if (!recovered) warnToolChoiceIgnored("crux", res.text?.trim() ? "unparsed" : "empty", res.stopReason);
  return recovered as { symbols?: unknown } | undefined;
}

/**
 * The `| <kind>` tail of a target line, for reply ids that echoed more of the
 * line than the id itself (`"src/x.ts | file"`). Only a real kind is stripped,
 * so an id that legitimately ends in `| something` is not mangled.
 */
const KIND_SUFFIX = new RegExp(`\\s*\\|\\s*(?:file|class|function|method|interface|type|enum|struct|trait|module|constant|variable)\\s*$`, "i");

/**
 * Canonicalize a reply id against the ids that were asked for: trimmed, any
 * echoing quotes removed, and a trailing ` | <kind>` from the target line
 * stripped — each tried only as a fallback, never overriding an exact match.
 * `undefined` when nothing canonicalizes to a known target; the caller then
 * keeps the raw id so the re-ask loop can see the miss.
 */
function canonicalReplyId(raw: string, targets: ReadonlySet<string>): string | undefined {
  const trimmed = raw.trim().replace(/^["']+|["']+$/g, "").trim();
  if (targets.has(trimmed)) return trimmed;
  const stripped = trimmed.replace(KIND_SUFFIX, "").trim();
  return targets.has(stripped) ? stripped : undefined;
}

/** Crux summarizer backed by any {@link ChatModel} via forced tool calling. */
export class ChatCruxSummarizer implements CruxSummarizer {
  lastMiss: CruxMiss | null = null;

  constructor(private model: ChatModel) {}

  async describeFile(input: FileCruxInput): Promise<NodeCrux[]> {
    this.lastMiss = null;
    if (input.nodes.length === 0) return [];
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
    const parsed = parseResults(argsFromResponse(res));
    // A reply id that echoed the target line's delimiters is still a good
    // summary: canonicalize it to the id that was asked for instead of
    // discarding the entry as missing.
    const targetIds = new Set(input.nodes.map((n) => n.id));
    const repaired = parsed.map((p) => {
      if (targetIds.has(p.id)) return p;
      const canon = canonicalReplyId(p.id, targetIds);
      return canon ? { ...p, id: canon } : p;
    });
    this.lastMiss = classifyCruxMiss(res, repaired);
    return repaired;
  }
}
