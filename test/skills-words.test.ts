/**
 * The words rule for learned skills (design 0 rule 7, spec 3): every string a
 * person or an agent reads says learnings, skills, lessons, guardrails,
 * preferences or decisions, never notes, rules, memory, remember or
 * workflows, and has no em dash. Strings are collected with the TypeScript
 * parser from every string and template literal (exported copy constants and
 * the text built inside functions alike) in src/skills/*, src/claude/*skills*,
 * src/claude/pre-bash*, src/claude/post-bash* and src/claude/stop.ts. Comments
 * and identifiers are not strings, so they are not read; module paths and type
 * names are skipped. The scope is read from disk, so files added later count.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";

const ROOT = process.cwd();
const BANNED = /\b(?:notes?|rules?|memory|memories|remember\w*|workflows?)\b/i;
const EM_DASH = /—/;

/** Strings that are data, never shown, each with why. */
const EXEMPT: Array<{ file: string; starts: string; why: string }> = [
  { file: "src/skills/compile-words.ts", starts: "first again too as well", why: "askPhrases' stop words: matched against the person's typed words, never shown" },
  ...["memory", "release-notes", "workflow-authoring"].map((name) => (
    { file: "src/skills/compile-words.ts", starts: name, why: "AGENT_COMMAND_NAMES: Claude Code's command names, matched against a skill's name, never shown" })),
];

function scope(): string[] {
  const list = (dir: string, keep: (f: string) => boolean) =>
    readdirSync(join(ROOT, dir)).filter((f) => f.endsWith(".ts") && keep(f)).map((f) => `${dir}/${f}`);
  return [
    ...list("src/skills", () => true),
    ...list("src/claude", (f) => /skills/.test(f) || /^pre-bash/.test(f) || /^post-bash/.test(f) || f === "stop.ts"),
  ].sort();
}

interface Found { file: string; line: number; text: string }

/** Every string and template literal in `source` that is not a module path or a type, its template holes as `{}`. */
export function stringsOf(file: string, source: string): Found[] {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const out: Found[] = [];
  const at = (n: ts.Node) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
  const visit = (n: ts.Node): void => {
    let text: string | null = null;
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) text = n.text;
    else if (ts.isTemplateExpression(n)) text = [n.head.text, ...n.templateSpans.map((s) => s.literal.text)].join("{}");
    const p = n.parent;
    const skip = p && (ts.isImportDeclaration(p) || ts.isExportDeclaration(p) || ts.isLiteralTypeNode(p) || ts.isExternalModuleReference(p)
      || (ts.isCallExpression(p) && p.expression.kind === ts.SyntaxKind.ImportKeyword));
    if (text !== null && !skip) out.push({ file, line: at(n), text });
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

const offends = (t: string) => EM_DASH.test(t) || BANNED.test(t);

test("the scanner reads strings and template text, not comments, identifiers or module paths", () => {
  const src = [
    "// remember: notes and rules in a comment are fine",
    "import { notes } from '../notes/flatten.js';",
    "type R = 'rules';",
    "const memoryLimit = 3;",
    "export const A = 'Saved to your notes';",
    "const b = (n: string) => `Follow the ${n} workflows`;",
    "const c = \"a dash — here\";",
    "const d = 'learnings, skills, lessons';",
  ].join("\n");
  const hits = stringsOf("x.ts", src).filter((s) => offends(s.text)).map((s) => s.line);
  assert.deepEqual(hits, [5, 6, 7]);
});

test("the scope covers the skills code, the skills hooks and Stop", () => {
  const files = scope();
  for (const f of ["src/skills/cli-skills.ts", "src/skills/offer-words.ts", "src/skills/save-verify.ts", "src/claude/prompt-skills.ts", "src/claude/pre-bash.ts", "src/claude/stop.ts"]) {
    assert.ok(files.includes(f), f);
  }
  assert.ok(files.length >= 30, String(files.length));
});

test("no string under the skills scope has an em dash or a banned word", () => {
  const bad: string[] = [];
  let read = 0;
  for (const file of scope()) {
    for (const s of stringsOf(file, readFileSync(join(ROOT, file), "utf8"))) {
      read++;
      if (!offends(s.text)) continue;
      if (EXEMPT.some((e) => e.file === file && s.text.startsWith(e.starts))) continue;
      bad.push(`${s.file}:${s.line} ${JSON.stringify(s.text.slice(0, 120))}`);
    }
  }
  assert.ok(read > 500, `read ${read} strings`);
  assert.deepEqual(bad, []);
});

test("each exemption still names a string that is there", () => {
  for (const e of EXEMPT) {
    const found = stringsOf(e.file, readFileSync(join(ROOT, e.file), "utf8")).some((s) => s.text.startsWith(e.starts));
    assert.ok(found, `${e.file}: ${e.starts} (${e.why})`);
  }
});
