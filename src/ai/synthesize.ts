/**
 * The synthesis step: turn per-file prose summaries into a CURATED set of graph
 * nodes. This is where granularity is decided — the model groups related files
 * into subsystem nodes, keeps a notable file as its own node when it deserves
 * one, and adds cross-cutting concept nodes, instead of emitting one entity per
 * incidental identifier. Each node is attributed to the source files it is
 * grounded in, so provenance (and staleness) stays exact.
 */
import type { ChatModel } from "./llm/types.js";
import { recoverToolArgsFromContent, warnToolChoiceIgnored } from "./llm/recover-tool.js";

/** A directed edge to another node, by node name (resolved to a slug later). */
export interface SynthLink {
  to: string;
  relation: string;
  description?: string;
}

/** A node as proposed by the synthesizer, before it is written to disk. */
export interface SynthNode {
  name: string;
  /** system | api | file | concept */
  type: string;
  summary: string;
  /** Source file paths (from the provided set) this node is grounded in. */
  sources: string[];
  links: SynthLink[];
}

/** One labeled file summary fed into synthesis. */
export interface FileSummary {
  path: string;
  summary: string;
}

export interface Synthesizer {
  synthesize(files: FileSummary[]): Promise<SynthNode[]>;
}

const SYSTEM_PROMPT = `You build an ARCHITECTURE graph of a codebase from per-file summaries. The reader is an AI agent that will read this graph before working on the code, so it must describe the system at the level a senior engineer would explain it — not file by file.

Produce a CURATED set of nodes of mixed granularity:
- "system" nodes: GROUP files that collaborate as one component (usually a directory or a cohesive set) into a SINGLE node. This should be the most common node type. Prefer one system node over several file nodes.
- "file" nodes: only for a substantial, standalone module that genuinely deserves its own node apart from its system.
- "concept" nodes: cross-cutting ideas, design decisions, or invariants that span multiple files (e.g. "local-first provider fallback", "staleness checking", "content-hash provenance"). Include several — they are the most valuable nodes for an agent.

Rules:
- Every summary must earn its tokens with NON-OBVIOUS information: invariants, ordering constraints, conventions, failure modes, "X must never happen after Y" facts, and the WHY behind a design. Never restate what a README says or what a directory listing already makes obvious ("src/api contains the API code" is worthless); an agent reading the node already sees the file paths. If all you can say about a group of files is what their names say, fold them into a larger node instead.
- Strongly prefer FEWER, larger, meaningful nodes. For a repo of N files, aim for well under N nodes. Do NOT emit one node per file, and never a node per incidental identifier (a local interface, helper, or third-party symbol).
- Merge duplicates and surface-form variants into one node.
- For each node give: a canonical human-readable name; a type ("system" | "file" | "concept"); a 1-3 sentence summary of its ROLE in the system; "sources" = the exact file paths (from the input) it is grounded in (a system lists all its files; a concept lists the files that motivate it); and "links" to other nodes you define, each with a relation and a short description of what concretely happens in the code.
- The relation MUST be one of exactly these verbs (each answers a question a code reviewer asks): "part_of" (where does this live?), "uses" (what breaks if the target changes?), "depends_on" (same, for non-call dependencies), "produces" (where does this output come from?), "configures" (what changes its behavior without a code change?), "validates" (what checks or judges this? tests, drift checks, scoring), "implements" (what contract must this honor?). Never invent vague relations like "influences", "supports", or "relates_to" — if none of the verbs fit, drop the link.
- Only link to nodes you actually define in this response.
Respond only via the record_graph tool / JSON schema.`;

const NODES_SCHEMA = {
  type: "object",
  properties: {
    nodes: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          type: { type: "string" },
          summary: { type: "string" },
          sources: { type: "array", items: { type: "string" } },
          links: {
            type: "array",
            items: {
              type: "object",
              properties: {
                to: { type: "string" },
                relation: {
                  type: "string",
                  enum: ["part_of", "uses", "depends_on", "produces", "configures", "validates", "implements"],
                },
                description: { type: "string" },
              },
              required: ["to", "relation"],
            },
          },
        },
        required: ["name", "type", "summary", "sources"],
      },
    },
  },
  required: ["nodes"],
} as const;

/** Cap the total summary text sent in one call so it never blows the context. */
const MAX_INPUT_CHARS = 60_000;

function userContent(files: FileSummary[]): string {
  const body = files.map((f) => `## ${f.path}\n\n${f.summary}`).join("\n\n");
  return body.length > MAX_INPUT_CHARS
    ? `${body.slice(0, MAX_INPUT_CHARS)}\n… (truncated)`
    : body;
}

/** Normalize a raw model response into clean {@link SynthNode}s. */
function clean(nodes: unknown): SynthNode[] {
  if (!Array.isArray(nodes)) return [];
  const out: SynthNode[] = [];
  for (const n of nodes as Array<Record<string, unknown>>) {
    if (!n || typeof n.name !== "string" || typeof n.type !== "string") continue;
    out.push({
      name: n.name,
      type: n.type,
      summary: typeof n.summary === "string" ? n.summary : "",
      sources: Array.isArray(n.sources) ? (n.sources as unknown[]).filter((s): s is string => typeof s === "string") : [],
      links: Array.isArray(n.links)
        ? (n.links as Array<Record<string, unknown>>)
            .filter((l) => l && typeof l.to === "string" && typeof l.relation === "string")
            .map((l) => ({
              to: l.to as string,
              relation: l.relation as string,
              description: typeof l.description === "string" ? l.description : undefined,
            }))
        : [],
    });
  }
  return out;
}

/**
 * A forced `record_graph` call can still deliver `nodes` as a JSON *string*
 * (double-encoded args). `clean` would then return [] and the CLI ticked
 * `✓ concepts: 0 nodes` (#383). Parse, then salvage balanced `{"name":…}`
 * objects if a stray brace breaks the string. Do not reuse recover-tool —
 * that path only runs when there is no tool-call args object.
 */
function coerceRecordGraphNodes(nodes: unknown, toolCalls: number): unknown[] {
  if (Array.isArray(nodes)) return nodes;
  if (typeof nodes !== "string") return [];
  let parsed: unknown;
  let salvaged = 0;
  try {
    parsed = JSON.parse(nodes);
  } catch {
    const objs = salvageNamedObjects(nodes);
    parsed = objs;
    salvaged = objs.length;
  }
  const values = Array.isArray(parsed) ? parsed : [];
  const salvageBit = salvaged > 0 ? ` — salvaged ${salvaged} node(s) from malformed JSON` : "";
  console.error(
    `⚠ synthesize: tool call returned "nodes" as a ${nodes.length}-char string, not an array; ${toolCalls} tool call(s)${salvageBit}`,
  );
  return values;
}

/** Pull complete `{"name":…}` objects out of a near-JSON string. */
function salvageNamedObjects(raw: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (let i = 0; i < raw.length; ) {
    const start = raw.indexOf("{", i);
    if (start === -1) break;
    const end = balancedClose(raw, start);
    if (end === -1) {
      i = start + 1;
      continue;
    }
    try {
      const obj = JSON.parse(raw.slice(start, end + 1)) as unknown;
      if (obj && typeof obj === "object" && !Array.isArray(obj) && typeof (obj as { name?: unknown }).name === "string") {
        out.push(obj as Record<string, unknown>);
      }
    } catch {
      /* slice was not a complete object */
    }
    i = end + 1;
  }
  return out;
}

function balancedClose(raw: string, start: number): number {
  let depth = 0;
  let inStr = false;
  let escape = false;
  for (let i = start; i < raw.length; i++) {
    const c = raw[i]!;
    if (inStr) {
      if (escape) {
        escape = false;
        continue;
      }
      if (c === "\\") {
        escape = true;
        continue;
      }
      if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') {
      inStr = true;
      continue;
    }
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function shapeOfNodes(nodes: unknown): string {
  if (typeof nodes === "string") return `"nodes" is string, ${nodes.length} chars`;
  if (Array.isArray(nodes)) return `"nodes" is array, ${nodes.length} entries`;
  if (nodes === undefined) return `"nodes" is undefined`;
  return `"nodes" is ${typeof nodes}`;
}

const RECORD_TOOL = "record_graph";

/** Synthesizer backed by any {@link ChatModel} via forced tool calling. */
export class ChatSynthesizer implements Synthesizer {
  constructor(private model: ChatModel) {}

  async synthesize(files: FileSummary[]): Promise<SynthNode[]> {
    if (files.length === 0) return [];
    const res = await this.model.create({
      temperature: 0,
      maxTokens: 8192,
      tools: [
        {
          name: RECORD_TOOL,
          description: "Record the curated architecture-graph nodes and their links.",
          parameters: NODES_SCHEMA as unknown as Record<string, unknown>,
        },
      ],
      responseFormat: { kind: "tool", name: RECORD_TOOL },
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userContent(files) },
      ],
    });
    const raw = nodesFromResponse(res)?.nodes;
    const out = clean(coerceRecordGraphNodes(raw, res.toolCalls.length));
    if (out.length === 0) {
      console.error(`⚠ synthesize: empty batch (${shapeOfNodes(raw)}; ${res.toolCalls.length} tool call(s))`);
    }
    return out;
  }
}

/**
 * Prefer a real tool call; if the gateway ignored `tool_choice` (#129), recover
 * the same payload from `content`. Recovered args still go through {@link clean}.
 */
function nodesFromResponse(res: { text: string; toolCalls: { name: string; args: unknown }[] }): {
  nodes?: unknown;
} | undefined {
  const call = res.toolCalls.find((c) => c.name === RECORD_TOOL) ?? res.toolCalls[0];
  if (call?.args && typeof call.args === "object" && !Array.isArray(call.args)) {
    return call.args as { nodes?: unknown };
  }
  const recovered = recoverToolArgsFromContent(res.text, {
    toolNames: [RECORD_TOOL, "emit_json"],
    payloadKey: "nodes",
  });
  if (!recovered) warnToolChoiceIgnored("synthesize", res.text?.trim() ? "unparsed" : "empty");
  return recovered as { nodes?: unknown } | undefined;
}

