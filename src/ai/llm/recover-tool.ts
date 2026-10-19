/**
 * Recover a forced-tool payload from assistant `content` when a gateway ignored
 * `tool_choice` and wrote JSON text instead of `tool_calls` (#129, #253).
 *
 * Conservative: only succeeds when `text` parses as JSON matching one of:
 *   - `[{ name, parameters|arguments|args }]`
 *   - `{ name, parameters|arguments|args }`
 *   - a fenced ```json block wrapping either
 *   - a bare object whose `payloadKey` is an array
 *   - a bare array of payload items (no tool envelope) — items may carry `name`
 * Truncated JSON is repaired only by closing unmatched `[`/`{` after the last
 * complete object (linear scan, bounded closers). Anything else (prose,
 * unrepairable truncation, a guessed shape) returns undefined.
 * Callers MUST run the same schema validation they use for real tool calls.
 */

/** Leading/trailing ```json fence, linear in `raw.length` — no quantified-whitespace regex. */
function unwrapMarkdownFence(raw: string): string {
  let s = raw;
  if (s.startsWith("```")) {
    s = s.slice(3);
    if (s.length >= 4 && s.slice(0, 4).toLowerCase() === "json") s = s.slice(4);
    s = s.trimStart();
  }
  if (s.endsWith("```")) s = s.slice(0, -3).trimEnd();
  return s.trim();
}

/** Walk back at most this many complete `}` when repairing a truncated prefix. */
const MAX_REPAIR_CUTS = 64;
/** Refuse to invent a deep wrapper — typical payloads need 1–3 closers. */
const MAX_REPAIR_CLOSERS = 8;

type PayloadFn = (value: unknown) => Record<string, unknown> | undefined;

/**
 * Closers that would finish `head` as JSON, or `undefined` if the prefix is
 * already balanced, still inside a string, mismatched, or too deep to close.
 * Linear in `head.length`; no regex.
 */
function closersFor(head: string): { closers: string; arrayStart: number } | undefined {
  const stack: Array<{ closer: "}" | "]"; start: number }> = [];
  let inString = false;
  let escape = false;
  for (let i = 0; i < head.length; i++) {
    const c = head[i]!;
    if (inString) {
      if (escape) {
        escape = false;
        continue;
      }
      if (c === "\\") {
        escape = true;
        continue;
      }
      if (c === '"') inString = false;
      continue;
    }
    if (c === '"') {
      inString = true;
      continue;
    }
    if (c === "{") stack.push({ closer: "}", start: i });
    else if (c === "[") stack.push({ closer: "]", start: i });
    else if (c === "}" || c === "]") {
      const want = stack.pop();
      if (want?.closer !== c) return undefined;
    }
  }
  if (inString) return undefined;
  if (stack.length === 0 || stack.length > MAX_REPAIR_CLOSERS) return undefined;
  // A complete payload item ends directly inside an array, not inside an
  // unfinished outer object. The caller also verifies this is the payload array.
  const parent = stack[stack.length - 1]!;
  if (parent.closer !== "]") return undefined;
  let closers = "";
  for (let i = stack.length - 1; i >= 0; i--) closers += stack[i]!.closer;
  return { closers, arrayStart: parent.start };
}

/**
 * After `JSON.parse` of the whole string / `{…}` / `[…]` slices fail, keep
 * complete objects by cutting at a `}` that is not inside a string and
 * appending only `]` / `}`. Does not close dangling quotes (that would guess
 * a truncated value). Linear scans; at most {@link MAX_REPAIR_CUTS} repair attempts.
 */
function tryRepairedPayload(stripped: string, asPayload: PayloadFn, payloadKey: string): Record<string, unknown> | undefined {
  const cuts: number[] = [];
  let inString = false;
  let escape = false;
  for (let i = 0; i < stripped.length; i++) {
    const c = stripped[i]!;
    if (inString) {
      if (escape) {
        escape = false;
        continue;
      }
      if (c === "\\") {
        escape = true;
        continue;
      }
      if (c === '"') inString = false;
      continue;
    }
    if (c === '"') {
      inString = true;
      continue;
    }
    if (c === "}") cuts.push(i);
  }
  const from = Math.max(0, cuts.length - MAX_REPAIR_CUTS);
  for (let k = cuts.length - 1; k >= from; k--) {
    const head = stripped.slice(0, cuts[k]! + 1);
    const repair = closersFor(head);
    if (repair === undefined) continue;
    try {
      const hit = asPayload(JSON.parse(head + repair.closers));
      // Nested arrays (e.g. a partially emitted node's links) may also end in
      // a complete object. Accept only when this array is the recovered payload,
      // so none of its item-closing braces were invented by the repair.
      const completeItems = JSON.parse(head.slice(repair.arrayStart) + "]");
      if (hit && JSON.stringify(hit[payloadKey]) === JSON.stringify(completeItems)) return hit;
    } catch {
      /* earlier complete object */
    }
  }
  return undefined;
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
      // Bare item array: only parameters|arguments|args mark a tool wrapper —
      // synth nodes legitimately carry `name` (#253).
      if (
        value.length > 0 &&
        value.every(
          (it) =>
            it !== null &&
            typeof it === "object" &&
            !Array.isArray(it) &&
            !("parameters" in it) &&
            !("arguments" in it) &&
            !("args" in it),
        )
      ) {
        return { [opts.payloadKey]: value };
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
    return asPayload(JSON.parse(stripped));
  } catch {
    /* try a bracket slice below */
  }
  const objStart = stripped.indexOf("{");
  const objEnd = stripped.lastIndexOf("}");
  const arrStart = stripped.indexOf("[");
  if (objStart >= 0 && objEnd > objStart) {
    try {
      const hit = asPayload(JSON.parse(stripped.slice(objStart, objEnd + 1)));
      if (hit) return hit;
      // When the first opener is an array this slice may be its first item;
      // repair still needs to close the outer array after that item.
      if (arrStart < 0 || objStart < arrStart) return undefined;
    } catch {
      /* try array slice */
    }
  }
  const arrEnd = stripped.lastIndexOf("]");
  // A nested array must not bypass a tool envelope (including a truncated one).
  if (arrStart >= 0 && (objStart < 0 || arrStart < objStart) && arrEnd > arrStart) {
    try {
      const hit = asPayload(JSON.parse(stripped.slice(arrStart, arrEnd + 1)));
      if (hit) return hit;
    } catch {
      /* truncated — repair below */
    }
  }
  return tryRepairedPayload(stripped, asPayload, opts.payloadKey);
}

/** One stderr line when a structured op got neither a tool call nor recoverable JSON. */
export function warnToolChoiceIgnored(op: string, reason: "empty" | "unparsed"): void {
  const detail =
    reason === "empty"
      ? "model returned no tool call and no content (provider may ignore forced tool_choice)"
      : "model did not honor tool_choice and content is not parseable tool-call JSON";
  console.error(`⚠ ${op}: ${detail} — this batch is empty`);
}
