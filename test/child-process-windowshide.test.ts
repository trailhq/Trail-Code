/**
 * Every child process trail starts hides its console window on Windows.
 *
 * A console program started by a process that has no console of its own gets a
 * new one, and Windows Terminal opens it as a window. The hooks run
 * `trail check` after every edit and it runs `git` several times, so each call
 * without `windowsHide: true` was a terminal flashing on screen per edit; the
 * flag does nothing elsewhere. The sources are read with the TypeScript parser,
 * so this holds on every platform in CI. A call that hands the person's own
 * terminal to the child (`stdio: "inherit"`) is left as it is. Calls are those
 * of the names imported from `node:child_process` at the top of a file.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";

const ROOT = process.cwd();
const SPAWNERS = new Set(["execFileSync", "execSync", "spawnSync", "spawn", "execFile", "exec"]);

/** Calls left without `windowsHide`, each with why. `starts` is how the call's first argument begins. */
const EXEMPT: Array<{ file: string; starts: string; why: string }> = [
  { file: "src/cloud/onboarding.ts", starts: '"scutil"', why: "macOS only" },
  { file: "src/graph/lsp/registry.ts", starts: "`command -v", why: "the POSIX branch: Windows looks the command up on PATH itself" },
  { file: "src/util/browser.ts", starts: "opener", why: "only called when stdout is a terminal, so the person's own console is there" },
];

interface Call { file: string; line: number; fn: string; first: string }

/** The local names a file imports from `node:child_process` that start a process. */
function spawnersOf(sf: ts.SourceFile): Set<string> {
  const names = new Set<string>();
  for (const st of sf.statements) {
    if (!ts.isImportDeclaration(st) || !ts.isStringLiteral(st.moduleSpecifier)) continue;
    if (!/^(?:node:)?child_process$/.test(st.moduleSpecifier.text)) continue;
    const bound = st.importClause?.namedBindings;
    if (!bound || !ts.isNamedImports(bound)) continue;
    for (const e of bound.elements) if (SPAWNERS.has((e.propertyName ?? e.name).text)) names.add(e.name.text);
  }
  return names;
}

/** Every child_process call in `source` that neither passes `windowsHide: true` nor gives the child the person's terminal. */
export function unhidden(file: string, source: string): Call[] {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const names = spawnersOf(sf);
  const out: Call[] = [];
  const visit = (n: ts.Node): void => {
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && names.has(n.expression.text)) {
      const last = n.arguments[n.arguments.length - 1];
      const props = last && ts.isObjectLiteralExpression(last) ? last.properties : [];
      const value = (name: string): string | undefined =>
        props.find((p): p is ts.PropertyAssignment => ts.isPropertyAssignment(p) && p.name.getText(sf) === name)?.initializer.getText(sf);
      const hidden = value("windowsHide") === "true";
      const inherits = /^["']inherit["']$/.test(value("stdio") ?? "");
      if (!hidden && !inherits) {
        const line = sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
        out.push({ file, line, fn: n.expression.text, first: n.arguments[0]?.getText(sf) ?? "" });
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

function sources(dir: string): string[] {
  return readdirSync(join(ROOT, dir), { withFileTypes: true }).flatMap((e) => {
    const rel = `${dir}/${e.name}`;
    return e.isDirectory() ? sources(rel) : e.name.endsWith(".ts") ? [rel] : [];
  });
}

const exempt = (c: Call) => EXEMPT.some((e) => e.file === c.file && c.first.startsWith(e.starts));

test("the scanner finds a child_process call without windowsHide and leaves the others", () => {
  const src = [
    'import { execFileSync, spawn as run } from "node:child_process";',
    'execFileSync("git", ["status"], { cwd: "." });',
    'execFileSync("git", ["status"], { cwd: ".", windowsHide: true });',
    'run("node", ["x.js"]);',
    'execFileSync("npm", ["i"], { stdio: "inherit" });',
    'other.spawn("x");',
  ].join("\n");
  assert.deepEqual(unhidden("x.ts", src).map((c) => [c.line, c.fn]), [[2, "execFileSync"], [4, "run"]]);
});

test("every child process in src hides its console window on Windows", () => {
  const found = sources("src")
    .flatMap((f) => unhidden(f, readFileSync(join(ROOT, f), "utf8")))
    .filter((c) => !exempt(c))
    .map((c) => `${c.file}:${c.line} ${c.fn}(${c.first})`);
  assert.deepEqual(found, [], "add `windowsHide: true` to these calls, or list them in EXEMPT with why");
});

test("every exemption still names a call that is there", () => {
  for (const e of EXEMPT) {
    const calls = unhidden(e.file, readFileSync(join(ROOT, e.file), "utf8"));
    assert.ok(calls.some((c) => c.first.startsWith(e.starts)), `${e.file}: no call starts with ${e.starts} (${e.why})`);
  }
});
