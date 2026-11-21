/**
 * A read that streams: each finding is handed over the moment Claude Code has
 * written all of it, so init can show the first learning seconds in instead
 * of when the whole answer is done. The answer itself is the same.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { callClaude, completedFindings } from "../src/init/claude-call.js";

const ASK = { system: "find things", schema: { type: "object" } };
const posixOnly = { skip: process.platform === "win32" ? "shebang stand-ins" : false };

/** A stand-in `claude` that runs `body` (plain node, with `argv` and `line(obj)`) after reading stdin. */
function standIn(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), "claude-stream-"));
  const bin = join(dir, "claude");
  writeFileSync(
    bin,
    `#!/usr/bin/env node\nconst argv = process.argv.slice(2);\nconst line = (o) => process.stdout.write(JSON.stringify(o) + "\\n");\nprocess.stdin.resume();\nprocess.stdin.on("end", async () => {\n${body}\n});\n`,
  );
  chmodSync(bin, 0o755);
  return bin;
}

test("completedFindings: only the objects the answer has closed, braces and quotes inside strings ignored", () => {
  assert.deepEqual(completedFindings(""), []);
  assert.deepEqual(completedFindings('{"findings": [{"headline": "a {b"'), []);
  assert.deepEqual(completedFindings('{"findings": [{"headline": "a {b} \\"c\\"", "n": [1, 2]}, {"headline": "d'), [{ headline: 'a {b} "c"', n: [1, 2] }]);
  assert.deepEqual(completedFindings('{"findings":[{"a":1},{"a":2}]}'), [{ a: 1 }, { a: 2 }]);
  // Not the findings array yet, or something else entirely.
  assert.deepEqual(completedFindings('{"other": [{"a":1}]'), []);
});

test("with onFinding, each finding arrives as soon as it's whole, then the answer as before", posixOnly, async () => {
  const json = JSON.stringify({ findings: [{ headline: "Payments are kept in cents {never floats}" }, { headline: "Sessions live in Postgres" }] });
  const cut = [7, 30, 55, 70, json.length];
  const bin = standIn(`
    if (!argv.includes("stream-json") || !argv.includes("--include-partial-messages")) { line({ type: "result", is_error: true, result: "wrong mode" }); process.exit(1); }
    line({ type: "system", subtype: "init" });
    line({ type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "tool_use" } } });
    let at = 0;
    for (const end of ${JSON.stringify(cut)}) {
      line({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: ${JSON.stringify(json)}.slice(at, end) } } });
      at = end;
      await new Promise((r) => setTimeout(r, 20));
    }
    line({ type: "result", is_error: false, structured_output: ${json}, total_cost_usd: 0.25 });
  `);
  const seen: unknown[] = [];
  const answer = await callClaude<{ headline: string }>(bin, "x", "m", 10_000, { ...ASK, onFinding: (f) => seen.push(f) });
  assert.deepEqual(seen, [{ headline: "Payments are kept in cents {never floats}" }, { headline: "Sessions live in Postgres" }]);
  assert.deepEqual(answer, { ok: true, findings: JSON.parse(json).findings, costUsd: 0.25 });
});

test("a streamed read that fails says why the same way: not signed in, an error", posixOnly, async () => {
  const expired = standIn(`line({ type: "result", is_error: true, result: "Failed to authenticate: OAuth session expired" }); process.exit(1);`);
  assert.deepEqual(await callClaude(expired, "x", "m", 10_000, { ...ASK, onFinding: () => {} }), { ok: false, why: "not_signed_in" });
  const broken = standIn(`console.log("segfault"); process.exit(3);`);
  assert.deepEqual(await callClaude(broken, "x", "m", 10_000, { ...ASK, onFinding: () => {} }), { ok: false, why: "failed", said: "segfault" });
});

const splitUtf8 = `
  async function splitUtf8(stream, text) {
    const bytes = Buffer.from(text);
    const at = bytes.indexOf(Buffer.from("冬")) + 1;
    stream.write(bytes.subarray(0, at));
    await new Promise((r) => setTimeout(r, 80));
    stream.write(bytes.subarray(at));
  }
`;

test("a UTF-8 character split across pipe chunks survives both streamed and final findings", posixOnly, async () => {
  const findings = [{ headline: "冬の設定" }];
  const bin = standIn(`
    ${splitUtf8}
    const findings = ${JSON.stringify(findings)};
    const event = {
      type: "stream_event",
      event: { type: "content_block_delta", delta: { type: "input_json_delta", partial_json: JSON.stringify({ findings }) } },
    };
    await splitUtf8(process.stdout, JSON.stringify(event) + "\\n");
    await splitUtf8(process.stdout, JSON.stringify({ type: "result", structured_output: { findings } }) + "\\n");
  `);
  const seen: unknown[] = [];
  const answer = await callClaude(bin, "x", "m", 10_000, { ...ASK, onFinding: (f) => seen.push(f) });
  assert.deepEqual(seen, findings);
  assert.deepEqual(answer, { ok: true, findings });
});

test("a UTF-8 character split across stderr chunks survives in the failure reason", posixOnly, async () => {
  const bin = standIn(`
    ${splitUtf8}
    await splitUtf8(process.stderr, "Error: could not read 冬の設定\\n");
    process.exitCode = 1;
  `);
  assert.deepEqual(await callClaude(bin, "x", "m", 10_000, ASK), {
    ok: false, why: "failed", said: "Error: could not read 冬の設定",
  });
});

test("a listener that throws never breaks the read", posixOnly, async () => {
  const json = JSON.stringify({ findings: [{ headline: "one" }] });
  const bin = standIn(`
    line({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: ${JSON.stringify(json)} } } });
    line({ type: "result", is_error: false, structured_output: ${json} });
  `);
  const answer = await callClaude(bin, "x", "m", 10_000, { ...ASK, onFinding: () => { throw new Error("boom"); } });
  assert.deepEqual(answer, { ok: true, findings: [{ headline: "one" }] });
});
