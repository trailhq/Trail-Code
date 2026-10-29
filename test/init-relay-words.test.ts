/**
 * fix-lab5: the relay's "show the list as written", firmer and in D101's shape. In the 1b lab an agent waited for
 * the answer but reworded the list (bold names, a dash, "candidate skill" for a guardrail). The line now says what to
 * keep as it is (each line's number, name and kind) and why (the numbers the person types point at those lines),
 * with no order to recite or say anything word for word (D101, D115). Made-up items.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { RELAY_LINE } from "../src/init/relay.js";
import { relayLines } from "../src/init/review-screen.js";
import { factsOf, guardrailCandidate } from "./init-screen-fixtures.js";

test("the relay line says to keep each line as it is, and why", () => {
  assert.match(RELAY_LINE, /^Show the list as written/);
  assert.match(RELAY_LINE, /number, name and kind/);
  assert.match(RELAY_LINE, /\bso the numbers (?:the person|they) types? point at\b/);
  assert.match(RELAY_LINE, /Wait for their answer, then run the command\. Don't choose for them\.$/);
  assert.doesNotMatch(RELAY_LINE, /\b(?:recite|word for word|verbatim|exactly|say)\b|—/i);
});

test("the agent's relay opens from Trail and carries the line once, before the list", () => {
  const lines = relayLines([{ ...guardrailCandidate(), n: 1, title: "no-timeout", description: "" }], factsOf({ agent: true }));
  const at = lines.indexOf(RELAY_LINE);
  assert.ok(at >= 0 && lines.filter((l) => l === RELAY_LINE).length === 1, lines.join("\n"));
  assert.ok(lines.findIndex((l) => /^1\. no-timeout \(always-follow learning\) · Claude won't use the timeout command/.test(l)) > at);
  assert.ok(lines.some((l) => l.startsWith("[trail] From Trail, the tool this person installed")), lines.join("\n"));
});
