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

export interface CruxSummarizer {
  describeFile(input: FileCruxInput): Promise<NodeCrux[]>;
  /** Set by {@link ChatCruxSummarizer} after each call; optional on fakes. */
  lastMiss?: CruxMiss | null;
}

/** Why a crux call produced no usable summaries (#235). */
export type CruxMissKind =
  | "empty-toolCalls"
  | "unparseable"
  | "truncated"
  | "empty-parsed"
  | "id-mismatch";

export interface CruxMiss {
  kind: CruxMissKind;
  finishReason: string | null;
  /** `id-mismatch` only: how many entries came back, and the first one's raw id. */
  returned?: number;
  firstId?: string;
}

function isTruncatedStop(reason: string | null): boolean {
  if (!reason) return false;
  const r = reason.toLowerCase();
  return r === "length" || r === "max_tokens";
}

/**
 * Classify an empty/unusable crux reply. `null` means at least one usable summary.
 * With `requested`, a summary only counts when its id is one we asked for: enrich
 * looks results up by node id, so a summary under any other id is never applied.
 */
export function classifyCruxMiss(
  res: ChatResponse,
  parsed: NodeCrux[],
  requested?: readonly string[],
): CruxMiss | null {
  const finishReason = res.stopReason;
  const wanted = requested ? new Set(requested) : undefined;
  const matched = wanted ? parsed.filter((p) => wanted.has(p.id)) : parsed;
  if (matched.some((p) => p.summary.trim())) return null;
  if (isTruncatedStop(finishReason)) return { kind: "truncated", finishReason };
  if (parsed.length > 0 && matched.length === 0) {
    return { kind: "id-mismatch", finishReason, returned: parsed.length, firstId: parsed[0].id };
  }
  if (parsed.length > 0) return { kind: "empty-parsed", finishReason };
  const emptyTools = res.toolCalls.length === 0;
  const emptyText = !res.text?.trim();
  if (emptyTools && emptyText) return { kind: "empty-toolCalls", finishReason };
  return { kind: "unparseable", finishReason };
}

/** Per-file error text: miss class + the provider's finish_reason (#235). */
export function formatCruxMiss(kind: CruxMissKind, finishReason: string | null): string {
  const fr = finishReason == null || finishReason === "" ? "null" : finishReason;
  if (kind === "id-mismatch") {
    return `model returned summaries but no id matched a requested target [${kind}, finish_reason=${fr}]`;
  }
  return `model returned no usable symbol summaries [${kind}, finish_reason=${fr}]`;
}

/** Longest echoed id shown in an error; a whole echoed row can carry a long signature. */
const MAX_SHOWN_ID_CHARS = 200;

/**
 * The model's text for an `id-mismatch`, kept apart from {@link formatCruxMiss}:
 * the failure gate matches words like "quota" in the error message, and a
 * returned id can carry any source text, so it must never reach the gate.
 */
export function formatCruxMissDetail(miss: CruxMiss | null | undefined): string {
  if (miss?.kind !== "id-mismatch" || miss.firstId === undefined) return "";
  const id =
    miss.firstId.length > MAX_SHOWN_ID_CHARS
      ? `${miss.firstId.slice(0, MAX_SHOWN_ID_CHARS)}…`
      : miss.firstId;
  return `first of ${miss.returned ?? 1} returned id(s): ${JSON.stringify(id)}`;
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

/**
 * `id=` is the LAST field of a target line, so the id ends where the line does.
 * With the id first nothing terminated it, and models asked for the id
 * "verbatim" copied the whole row — `a.cs#Level | variable | lines L58-L58 | sig`
 * — into `id` (#259). {@link resolveTargetId} still repairs echoes of either layout.
 */
function userContent(input: FileCruxInput): string {
  const targets = input.nodes
    .map(
      (n) =>
        `- ${n.kind} | lines L${n.startLine}-L${n.endLine}` +
        (n.signature ? ` | ${n.signature}` : "") +
        ` | id=${n.id}`,
    )
    .join("\n");
  const n = input.nodes.length;
  return `FILE: ${input.path}\n\n${numberLines(input.source)}\n\nTARGETS (${n} — return all ${n}, one entry per id):\n${targets}`;
}

/** The longest requested id `test` accepts, or null. */
function longestMatch(requested: readonly string[], test: (id: string) => boolean): string | null {
  let best: string | null = null;
  for (const id of requested) if (test(id) && (best === null || id.length > best.length)) best = id;
  return best;
}

/**
 * Map an id the model returned onto one of the ids we asked for, or null.
 *
 * Models echo decorated target rows instead of the bare id (#259, #298, #486).
 * Rather than cut the string at a guessed delimiter, every rule compares against
 * the requested ids, so the result is always an id we asked for — never a
 * fragment of a hallucinated one — and no rule assumes which characters an id
 * may contain. In order:
 *   1. exact match;
 *   2. a requested id followed by ` | ` (the row echoed from the id onwards);
 *   3. the same two with a leading `id=` removed;
 *   4. a row ending in ` | id=<requested id>` (the current layout echoed whole).
 * When several requested ids qualify, the longest wins.
 */
export function resolveTargetId(raw: string, requested: readonly string[]): string | null {
  const id = raw.trim();
  if (requested.includes(id)) return id;
  const echoed = longestMatch(requested, (r) => id.startsWith(`${r} | `));
  if (echoed) return echoed;
  if (id.startsWith("id=")) {
    const bare = id.slice(3).trim();
    if (requested.includes(bare)) return bare;
    const bareEchoed = longestMatch(requested, (r) => bare.startsWith(`${r} | `));
    if (bareEchoed) return bareEchoed;
  }
  return longestMatch(requested, (r) => id.endsWith(` | id=${r}`));
}

/**
 * Normalize the tool's parsed argument object into a {@link NodeCrux} list. Ids
 * are resolved against `requested`; one that matches nothing keeps its raw text
 * so {@link classifyCruxMiss} can report what the model actually sent.
 */
function parseResults(obj: { symbols?: unknown } | undefined, requested: readonly string[]): NodeCrux[] {
  if (!obj || !Array.isArray(obj.symbols)) return [];
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? Math.trunc(v) : 0);
  return obj.symbols
    .map((s) => s as Record<string, unknown>)
    .filter((s) => typeof s.id === "string")
    .map((s) => ({
      id: resolveTargetId(s.id as string, requested) ?? (s.id as string),
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
    const requested = input.nodes.map((n) => n.id);
    const parsed = parseResults(argsFromResponse(res), requested);
    this.lastMiss = classifyCruxMiss(res, parsed, requested);
    return parsed;
  }
}
