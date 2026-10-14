/**
 * Recover a forced-tool payload from assistant `content` when a gateway ignored
 * `tool_choice` and wrote JSON text instead of `tool_calls` (#129).
 *
 * Conservative: only succeeds when `text` parses as JSON matching one of:
 *   - `[{ name, parameters|arguments|args }]`
 *   - `{ name, parameters|arguments|args }`
 *   - a fenced ```json block wrapping either
 *   - a bare object whose `payloadKey` is an array
 * Anything else (prose, truncated JSON, a guessed shape) returns undefined.
 * Callers MUST run the same schema validation they use for real tool calls.
 */

/** Leading/trailing ```json fence, linear in `raw.length` — no quantified-whitespace regex. */
export function unwrapMarkdownFence(raw: string): string {
  let s = raw;
  if (s.startsWith("```")) {
    s = s.slice(3);
    if (s.length >= 4 && s.slice(0, 4).toLowerCase() === "json") s = s.slice(4);
    s = s.trimStart();
  }
  if (s.endsWith("```")) s = s.slice(0, -3).trimEnd();
  return s.trim();
}

export function recoverToolArgsFromContent(
  text: string,
  opts: { toolNames: readonly string[]; payloadKey: string },
): Record<string, unknown> | undefined {
  const raw = text?.trim();
  if (!raw) return undefined;
  const stripped = unwrapMarkdownFence(raw);
  const accepted = new Set(opts.toolNames);

  const asPayload = (value: unknown): Record<string, unknown> | undefined => {
    if (!value || typeof value !== "object") return undefined;
    if (Array.isArray(value)) {
      for (const item of value) {
        const hit = asPayload(item);
        if (hit) return hit;
      }
      return undefined;
    }
    const obj = value as Record<string, unknown>;
    const wrapped =
      typeof obj.name === "string" || "parameters" in obj || "arguments" in obj || "args" in obj;
    if (wrapped) {
      const name = typeof obj.name === "string" ? obj.name : "";
      if (name && !accepted.has(name)) return undefined;
      let params: unknown = obj.parameters ?? obj.arguments ?? obj.args;
      if (typeof params === "string") {
        try {
          params = JSON.parse(params);
        } catch {
          return undefined;
        }
      }
      const hit = asPayload(params);
      if (hit) return hit;
      // `{ name, nodes: [...] }` — payload at the same level as the wrapper.
      if (Array.isArray(obj[opts.payloadKey])) return obj;
      return undefined;
    }
    if (Array.isArray(obj[opts.payloadKey])) return obj;
    return undefined;
  };

  try {
    const hit = asPayload(JSON.parse(stripped));
    if (hit) return hit;
  } catch {
    /* try a bracket slice below */
  }
  const objStart = stripped.indexOf("{");
  const objEnd = stripped.lastIndexOf("}");
  if (objStart >= 0 && objEnd > objStart) {
    try {
      const hit = asPayload(JSON.parse(stripped.slice(objStart, objEnd + 1)));
      if (hit) return hit;
    } catch {
      /* try array slice */
    }
  }
  const arrStart = stripped.indexOf("[");
  const arrEnd = stripped.lastIndexOf("]");
  if (arrStart >= 0 && arrEnd > arrStart) {
    try {
      return asPayload(JSON.parse(stripped.slice(arrStart, arrEnd + 1)));
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/** One stderr line when a structured op got neither a tool call nor recoverable JSON. */
export function warnToolChoiceIgnored(op: string, reason: "empty" | "unparsed"): void {
  const detail =
    reason === "empty"
      ? "model returned no tool call and no content (provider may ignore forced tool_choice)"
      : "model did not honor tool_choice and content is not parseable tool-call JSON";
  console.error(`⚠ ${op}: ${detail} — this batch is empty`);
}
