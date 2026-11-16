/**
 * The phase 1b contracts (design 1.0): the types the 1b groups code against,
 * pinned by field name so a rename breaks here and not in a sibling group.
 * 1b adds its fields to a 1a interface in a second declaration of it (merged
 * by TypeScript), so 1a's own pins in skills-contracts.test.ts stay as they
 * were; this file reads the second one.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpRepo } from "./helpers.js";
import { VALUES } from "../src/telemetry/contract.js";
import { HOST_FACTS, hostFacts } from "../src/skills/host-facts.js";
import { WALL_CLASSES } from "../src/notes/learning-fields.js";
import { offerEndsReply } from "../src/skills/offer-moment.js";
import { withoutOffer } from "../src/claude/stop-skills.js";
import { noticeText, postToolOfferText, stopBlockReason } from "../src/skills/offer-words.js";
import type { PendingOffer } from "../src/trace/types.js";
import { add, box as box1b, kept, offered, prompt, state, ctxAt } from "./skills-consent-fixtures.js";
import { withSkillSession } from "../src/trace/skill-session.js";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
const read = (f: string) => readFileSync(join(SRC, f), "utf8");

/** Every `export interface Name {…}` body, or `export type Name = …` text, of `name` in `text`, in order. */
function declarations(text: string, name: string): string[] {
  const out: string[] = [];
  const re = new RegExp(`^export (?:interface ${name}\\b|type ${name}\\b)`, "gm");
  for (const m of text.matchAll(re)) {
    const rest = text.slice(m.index!);
    if (rest.startsWith("export type")) {
      out.push(rest.slice(0, endAtTop(rest, 0, ";")));
      continue;
    }
    const open = rest.indexOf("{");
    out.push(rest.slice(open + 1, endAtTop(rest, open + 1, "}")));
  }
  assert.ok(out.length > 0, `${name} is exported`);
  return out;
}

/** The index of the first `stop` at brace depth 0 from `from` (a `}` closes the body it starts in). */
function endAtTop(s: string, from: number, stop: ";" | "}"): number {
  let depth = 0;
  for (let i = from; i < s.length; i++) {
    const ch = s[i];
    if (ch === "{") depth++;
    else if (ch === "}" && depth === 0 && stop === "}") return i;
    else if (ch === "}") depth--;
    else if (ch === stop && depth === 0) return i;
  }
  throw new Error("unclosed");
}

/** Field names at the top level of a declaration body. */
function fields(body: string): string[] {
  const noComments = body.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  let depth = 0;
  let top = "";
  for (const ch of noComments) {
    if (ch === "{" || ch === "(") depth++;
    top += depth === 0 ? ch : ch === "\n" ? "\n" : " ";
    if (ch === "}" || ch === ")") depth--;
  }
  return [...top.matchAll(/(?:^|[;\n])\s*(['"]?)([\w-]+)\1\??\s*:/g)].map((m) => m[2]!);
}

/** The type text of field `f` in a body, comments dropped. */
function fieldType(body: string, f: string): string {
  const clean = body.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  const m = new RegExp(`(?:^|[;\\n{])\\s*${f}\\??\\s*:\\s*`).exec(clean);
  assert.ok(m, `${f} is declared`);
  const from = m.index + m[0].length;
  return clean.slice(from, endAtTop(clean, from, ";")).replace(/\s+/g, " ").trim();
}

/** Inside the outer braces of `type X = { … }`. */
const inner = (decl: string) => decl.slice(decl.indexOf("{") + 1, decl.lastIndexOf("}"));

const literals = (decl: string) => [...decl.matchAll(/'([^']+)'/g)].map((m) => m[1]!);

test("trace/types.ts: the 1b types with exactly the design's fields", () => {
  const text = read("trace/types.ts");
  assert.deepEqual(literals(declarations(text, "WallClass")[0]!), [...VALUES.wall_hit!.class!], "WallClass equals telemetry's wall_hit.class");
  assert.deepEqual(literals(declarations(text, "FixDeltaKind")[0]!), ["env", "flag", "wrapper", "enable-step"]);
  assert.deepEqual(fields(declarations(text, "FixDelta")[0]!), ["kind", "name", "text", "callId"]);
  assert.deepEqual(fields(declarations(text, "RepairEvent")[0]!), ["cls", "program", "failCallId", "fixCallId", "delta", "epoch", "runId", "at"]);
  // Phase 2 widens the union after these (skills-contracts-2.test.ts pins the whole of it).
  assert.deepEqual(literals(declarations(text, "OfferMoment")[0]!).slice(0, 3), ["repeated", "repaired", "correction"]);
});

test("trace/types.ts: 1b's additions to 1a interfaces sit in a second declaration with the design's fields", () => {
  const text = read("trace/types.ts");
  const added: Record<string, string[]> = {
    RunCall: ["wall", "editsBefore"], // editsBefore: b2 review (an edit between a failure and its retry)
    RunState: ["repairs"],
    PendingOffer: ["repo", "repair", "correction"], // b4: repo (a correction key names no repo)
    SkillInjection: ["phraseSha"],
    CreditState: ["phraseSha", "corrected"],
    SkillSessionState: ["lessonWatch", "withdrewFor", "deniedSeen"],
  };
  for (const [name, want] of Object.entries(added)) {
    const decls = declarations(text, name);
    // Phase 2 adds a third to some (skills-contracts-2.test.ts); 1b's is the second.
    assert.ok(decls.length >= 2, `${name}: the 1a declaration and 1b's`);
    assert.deepEqual(fields(decls[1]!), want, name);
  }
  // The widened 1a fields.
  const po = declarations(text, "PendingOffer");
  assert.equal(fieldType(po[0]!, "moment"), "OfferMoment");
  assert.equal(fieldType(po[0]!, "lines"), "[string, string] | null");
  assert.deepEqual(fields(fieldType(po[1]!, "repair").replace(/^\{|\}$/g, "")), ["cls", "program", "nth", "firstAt", "as", "delta", "lessonSha"]);
  assert.deepEqual(fields(fieldType(po[1]!, "correction").replace(/^\{|\}$/g, "")), ["skillId", "useId", "typed", "fixCallId", "lessonSha", "fix"]);
  assert.match(fieldType(declarations(text, "RunCall")[1]!, "wall"), /^WallClass$/);
  assert.match(fieldType(declarations(text, "RunState")[1]!, "repairs"), /^RepairEvent\[\]$/);
  assert.match(fieldType(declarations(text, "SkillInjection")[1]!, "phraseSha"), /^string \| null$/);
});

test("skills/types.ts: offers, ledger, state and the two receipts", () => {
  const text = read("skills/types.ts");
  const offer = declarations(text, "OfferLine")[0]!;
  assert.deepEqual(literals(fieldType(offer, "event")), ["shown", "answer", "not-shown", "closed"]);
  assert.deepEqual(literals(fieldType(offer, "moment")).slice(0, 4), ["repeated", "repaired", "correction", "init"]);
  const ledger = declarations(text, "LedgerLine")[0]!;
  assert.match(ledger, /\bLedgerLesson\b/);
  assert.match(ledger, /\bLedgerCue\b/);
  assert.match(ledger, /consent: 'offer-yes' \| 'asked' \| 'init'/);
  assert.deepEqual(fields(inner(declarations(text, "LedgerLesson")[0]!)), ["at", "event", "skill", "lessonId", "src", "consent"]);
  assert.deepEqual(fields(inner(declarations(text, "LedgerCue")[0]!)), ["at", "event", "skill", "phraseSha", "change"]);
  const st = declarations(text, "SkillState");
  assert.ok(st.length >= 2, "1a's and 1b's (phase 2 adds a third)");
  assert.deepEqual(fields(st[1]!), ["cueMisses", "unusedSaidAt", "missingSaidAt"]);
  assert.deepEqual(fields(declarations(text, "KeepReceipt")[0]!),
    ["v", "kind", "session", "transcriptPath", "toolUseId", "list", "typed", "replySha", "numbers", "at", "verdict", "heldWhy", "usedAt"]);
  assert.deepEqual(fields(declarations(text, "LessonReceipt")[0]!),
    ["v", "kind", "session", "transcriptPath", "toolUseId", "offerId", "skill", "typed", "lessonSha", "at", "verdict", "heldWhy", "usedAt"]);
  assert.deepEqual(literals(fieldType(declarations(text, "KeepReceipt")[0]!, "heldWhy")), ["no-answer", "numbers", "not-shown", "host"]);
  assert.deepEqual(literals(fieldType(declarations(text, "LessonReceipt")[0]!, "heldWhy")), ["no-yes", "changed", "host"]);
});

test("init/types.ts: init's shared types, types only", () => {
  const text = read("init/types.ts");
  // D184: 'claude' is #662's team row from what Claude Code keeps about the repo; 'session' is setup's read of past sessions.
  assert.deepEqual(literals(declarations(text, "InitKind")[0]!), ["skill", "guardrail", "preference", "review", "session", "claude", "claudeai"]);
  assert.deepEqual(fields(declarations(text, "TypedRef")[0]!), ["t", "o", "s"]);
  assert.deepEqual(fields(declarations(text, "InitCandidate")[0]!),
    ["id", "kind", "key", "plainName", "nameWords", "count", "scope", "applies", "typed", "ticked", "skill", "guardrail", "pref", "review", "memory", "detail", "evidence", "rank"]);
  assert.deepEqual(fields(declarations(text, "InitItem")[0]!), ["n", "title", "description"]);
  assert.match(text, /export interface InitItem extends InitCandidate\b/);
  assert.deepEqual(fields(declarations(text, "LookBack")[0]!),
    ["sessions", "skipped", "days", "from", "to", "parent", "candidates", "alreadyKept", "howtos", "ms", "errors"]);
  assert.deepEqual(fields(declarations(text, "SkillSource")[0]!), ["t", "size", "mtimeMs", "run", "prior", "skillSha"]);
  assert.match(declarations(text, "KeepAnswer")[0]!, /\{ numbers: number\[\] \} \| \{ all: true \} \| \{ none: true \}/);
  assert.doesNotMatch(text, /^export (?:const|function|class|let|var)\b/m);
  assert.doesNotMatch(text, /^import (?!type\b)/m);
});

test("the 1b type files stay types only", () => {
  for (const file of ["trace/types.ts", "skills/types.ts", "init/types.ts"]) {
    const src = read(file);
    assert.doesNotMatch(src, /^export (?:const|function|class|let|var)\b/m, file);
    assert.doesNotMatch(src, /^import (?!type\b)/m, file);
  }
});

test("WALL_CLASSES (the runtime list) equals WallClass and telemetry's wall_hit.class, in table order", () => {
  assert.deepEqual([...WALL_CLASSES], [...VALUES.wall_hit!.class!]);
  assert.deepEqual([...WALL_CLASSES], literals(declarations(read("trace/types.ts"), "WallClass")[0]!));
});

test("host facts: failureContext defaults true and merges from TRAIL_HOST_FACTS only in a test home", () => {
  assert.equal(HOST_FACTS.failureContext, true);
  const home = tmpRepo("hf1b");
  const real: NodeJS.ProcessEnv = { HOME: home, TRAIL_HOST_FACTS: JSON.stringify({ failureContext: false }) };
  const lab: NodeJS.ProcessEnv = { ...real, TRAIL_HOME: join(home, ".trail") };
  assert.equal(hostFacts(lab).failureContext, true, "Trail in its usual place, no marker: a real home");
  assert.equal(hostFacts(real).failureContext, true, "a real home ignores the switch");
  const test1: NodeJS.ProcessEnv = { ...real, TRAIL_HOME: join(home, "sandbox") };
  assert.equal(hostFacts(test1).failureContext, false, "a test home takes it");
  assert.equal(hostFacts({ ...test1, TRAIL_HOST_FACTS: JSON.stringify({ failureContext: "no" }) }).failureContext, true, "only a boolean");
  mkdirSync(join(home, ".trail-lab"));
  assert.equal(hostFacts(lab).failureContext, false, "the lab box takes it");
});

/* -------------------------------------------------------------------------- */
/* A PendingOffer with no lines (a moment-4 offer before b4's offerLinesOf)    */
/* fails closed at every 1a reader: never shown, answered or saved.            */
/* -------------------------------------------------------------------------- */

const NO_LINES: PendingOffer = {
  offerId: "o-0b2d17", moment: "correction", runId: "r-1103-77ab", name: "release-npm", key: "s-7f3a2c|correction",
  lines: null, channel: "stop", shownAt: null, showMe: false, yes: null, typedAfter: [],
};

test("null lines: offerEndsReply is false, whatever the reply says", () => {
  assert.equal(offerEndsReply(NO_LINES, "Done.\nKeep it as a skill? (yes / no)"), false);
  assert.equal(offerEndsReply(NO_LINES, ""), false);
});

test("null lines: withoutOffer leaves the reply as it is", () => {
  const reply = "Published 1.4.0.\nWant me to keep these steps as a skill for this repo? (yes / no)";
  assert.equal(withoutOffer(reply, NO_LINES), reply);
});

test("null lines: the offer texts are empty, so no block, notice or context goes out", () => {
  assert.equal(stopBlockReason(NO_LINES), "");
  assert.equal(noticeText(NO_LINES), "");
  assert.equal(postToolOfferText(NO_LINES), "");
});

test("null lines: the save gate finds no yes to the offer, so the add is held and nothing is kept", () => {
  const b = box1b();
  const { offer } = offered(b, 0);
  assert.equal(prompt(b, 70, "yes").answer, "yes");
  withSkillSession(ctxAt(b, 75), { catchUp: true }, (st) => {
    st.pendingOffer = { ...st.pendingOffer!, lines: null };
  });
  assert.equal(state(b).pendingOffer?.lines, null);
  const r = add(b, 80, `trail skills add ${offer.name} --run ${offer.runId}`);
  assert.equal(r.cli?.held, "no-yes");
  assert.deepEqual(kept(b).skills, []);
});
