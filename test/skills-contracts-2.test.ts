/**
 * The phase 2 contracts (design 1.0, c0): the types the phase 2 groups code
 * against, pinned by field name so a rename breaks here and not in a sibling
 * group. Phase 2 adds its fields to a 1a interface in a further
 * declaration of it (merged by TypeScript), and widens a union in place only
 * where a union can't merge.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

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

function fieldType(body: string, f: string): string {
  const clean = body.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  const m = new RegExp(`(?:^|[;\\n{])\\s*${f}\\??\\s*:\\s*`).exec(clean);
  assert.ok(m, `${f} is declared`);
  const from = m.index + m[0].length;
  return clean.slice(from, endAtTop(clean, from, ";")).replace(/\s+/g, " ").trim();
}

const inner = (decl: string) => decl.slice(decl.indexOf("{") + 1, decl.lastIndexOf("}"));
const literals = (decl: string) => [...decl.matchAll(/'([^']+)'/g)].map((m) => m[1]!);
const unbrace = (t: string) => t.replace(/^\{|\}(?: \| null)?$/g, "");

/* -------------------------------------------------------------------------- */
/* Types                                                                       */
/* -------------------------------------------------------------------------- */

test("skills/types.ts: phase 2's SkillState fields sit in their own declaration", () => {
  const text = read("skills/types.ts");
  const st = declarations(text, "SkillState");
  assert.equal(st.length, 3, "1a's, 1b's and phase 2's");
  assert.deepEqual(fields(st[2]!), ["firings", "proposed", "changedAt", "pendingWrite"]);
  assert.equal(fieldType(st[2]!, "firings"), "Firing[]");
  assert.deepEqual(fields(unbrace(fieldType(st[2]!, "proposed"))), ["hash", "version", "op", "at"]);
  assert.match(fieldType(st[2]!, "proposed"), /op: FoldOp \| 'replace'/);
  assert.match(fieldType(st[2]!, "proposed"), /\| null$/);
  assert.deepEqual(fields(unbrace(fieldType(st[2]!, "pendingWrite"))), ["hash", "from", "at"]);
  assert.equal(fieldType(st[2]!, "changedAt"), "string | null");
  assert.deepEqual(fields(declarations(text, "Firing")[0]!), ["at", "followed"]);
  assert.deepEqual(fields(declarations(text, "FidelityCounts")[0]!), ["ran", "missing", "extra", "changed"]);
});

test("skills/types.ts: the fold and change ops, closed", () => {
  const text = read("skills/types.ts");
  assert.deepEqual(literals(declarations(text, "FoldOp")[0]!), ["update", "extend", "split"]);
  assert.deepEqual(literals(declarations(text, "ChangeOp")[0]!), ["update", "extend", "replace", "adopted", "restore-version"]);
});

test("skills/types.ts: the ledger gains the use facts, the changed line and the retire-offer reason", () => {
  const text = read("skills/types.ts");
  const use = declarations(text, "LedgerUse")[0]!;
  assert.deepEqual(literals(fieldType(inner(use.slice(0, use.lastIndexOf("}") + 1)), "cue")), ["job", "name", "compact", "run"]);
  assert.match(use, /&\s*LedgerUseFacts\s*$/, "the phase 2 facts join the 1a line");
  // c8 (D137): `handed`, the gated steps handed to the person.
  assert.deepEqual(fields(declarations(text, "LedgerUseFacts")[0]!), ["fid", "extraShas", "changedSteps", "handed"]);
  assert.equal(fieldType(declarations(text, "LedgerUseFacts")[0]!, "fid"), "FidelityCounts");
  const changed = declarations(text, "LedgerChanged")[0]!;
  assert.deepEqual(fields(inner(changed)), ["at", "event", "skill", "op", "from", "to", "offerId", "lessonIds"]);
  assert.equal(fieldType(inner(changed), "op"), "ChangeOp");
  const ledger = declarations(text, "LedgerLine")[0]!;
  assert.match(ledger, /\| LedgerChanged\b/);
  const status = ledger.slice(ledger.indexOf("event: 'status'"));
  assert.deepEqual(literals(status.slice(status.indexOf("reason:"))), ["checked-use", "failed-twice", "forget", "restore", "retire-offer"]);
});

test("skills/types.ts: the offer line's moments and op, and the update receipt", () => {
  const text = read("skills/types.ts");
  const offer = declarations(text, "OfferLine");
  assert.deepEqual(literals(fieldType(offer[0]!, "moment")), ["repeated", "repaired", "correction", "init", "update", "drift", "retire"]);
  assert.equal(offer.length, 2, "1a's and phase 2's");
  assert.deepEqual(fields(offer[1]!), ["op"]);
  assert.match(fieldType(offer[1]!, "op"), /^FoldOp \| 'replace' \| 'retire'$/);
  const r = declarations(text, "UpdateReceipt")[0]!;
  assert.deepEqual(fields(r), ["v", "kind", "session", "transcriptPath", "toolUseId", "host", "offerId", "skillId", "name", "runId", "op",
    "baseHash", "proposalSha", "typed", "at", "usedAt"]);
  assert.equal(fieldType(r, "kind"), "'update'");
  assert.equal(fieldType(r, "op"), "FoldOp | 'replace'");
  assert.deepEqual(fields(unbrace(fieldType(r, "typed"))), ["offset", "lineSha"]);
});

test("trace/types.ts: moments, answers, the pending offer's pins and the Codex session facts", () => {
  const text = read("trace/types.ts");
  assert.deepEqual(literals(declarations(text, "OfferMoment")[0]!), ["repeated", "repaired", "correction", "update", "drift", "retire"]);
  assert.deepEqual(literals(declarations(text, "TypedAnswer")[0]!), ["yes", "no", "show", "correction", "retire", "other"]);
  const po = declarations(text, "PendingOffer");
  assert.equal(po.length, 3, "1a's, 1b's and phase 2's");
  assert.deepEqual(fields(po[2]!), ["fold", "retire"]);
  assert.deepEqual(fields(unbrace(fieldType(po[2]!, "fold"))),
    ["op", "skillId", "baseHash", "proposalSha", "handEdited", "splitName", "lessonIds", "version"]);
  assert.match(fieldType(po[2]!, "fold"), /op: FoldOp \| 'replace'/);
  assert.deepEqual(fields(unbrace(fieldType(po[2]!, "retire"))), ["skillId", "name"]);
  const ss = declarations(text, "SkillSessionState");
  assert.equal(ss.length, 3, "1a's, 1b's and phase 2's");
  assert.deepEqual(fields(ss[2]!), ["codex", "firedLater"], "c8 adds firedLater");
  assert.deepEqual(fields(unbrace(fieldType(ss[2]!, "codex"))), ["meta", "typedShas"]);
  assert.match(fieldType(ss[2]!, "codex"), /meta: CodexMeta \| null/);
  assert.deepEqual(fields(declarations(text, "CodexMeta")[0]!), ["id", "originator", "source", "cliVersion", "cwd", "historyMode"]);
  assert.deepEqual(literals(fieldType(declarations(text, "CodexMeta")[0]!, "historyMode")), ["legacy", "paginated"]);
});

test("the type files stay types only", () => {
  for (const file of ["trace/types.ts", "skills/types.ts"]) {
    const src = read(file);
    assert.doesNotMatch(src, /^export (?:const|function|class|let|var)\b/m, file);
    assert.doesNotMatch(src, /^import (?!type\b)/m, file);
  }
});
