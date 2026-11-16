/**
 * Recoverable extraction failures write the healthy portion of the graph
 * and exit 0 by default, but fail the command under --strict.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runCli, runCliWithWasmParserFailure, tmpRepo } from "./helpers.js";

function repo(tag: string): string {
  const root = tmpRepo(tag);
  writeFileSync(join(root, "Broken.cs"), "public class Broken {}\n");
  writeFileSync(join(root, "healthy.ts"), "export function healthy() { return 42; }\n");
  return root;
}

function assertStructuralFailure(
  r: ReturnType<typeof runCliWithWasmParserFailure>,
  expectedErrors = 1,
): void {
  assert.equal(r.status, 1, r.describe());
  assert.match(r.stderr, new RegExp(`wiring incomplete: ${expectedErrors} structural error\\(s\\)`), r.describe());
  assert.match(r.stderr, /Broken\.cs: parse failed/, r.describe());
  assert.doesNotMatch(r.stdout, /wiring:/, r.describe());
}

test("a structural parse failure writes the healthy graph and exits 0 by default", () => {
  const root = repo("cli-structural-default");
  const r = runCliWithWasmParserFailure(["build", root, "--no-gitignore", "--no-ignore"]);

  assert.equal(r.status, 0, r.describe());
  assert.match(r.stdout, /wiring:/, r.describe());
  assert.match(r.stderr, /Broken\.cs: parse failed/, r.describe());
  const wiring = readFileSync(join(root, "graft", ".graph", "wiring.json"), "utf8");
  assert.match(wiring, /healthy/);
});

test("with --strict, a structural parse failure writes the healthy graph but exits 1", () => {
  const root = repo("cli-structural-strict");
  const r = runCliWithWasmParserFailure(["build", root, "--strict", "--no-gitignore", "--no-ignore"]);

  assertStructuralFailure(r);
  const wiring = readFileSync(join(root, "graft", ".graph", "wiring.json"), "utf8");
  assert.match(wiring, /healthy/);
});

test("with --strict, --allow-partial cannot waive structural failures", () => {
  const root = repo("cli-structural-partial");
  const r = runCliWithWasmParserFailure([
    "build", root, "--strict", "--allow-partial", "--no-gitignore", "--no-ignore",
  ]);

  assertStructuralFailure(r);
});

test("with --strict, --deep fallback without a key still fails for structural errors", () => {
  const root = repo("cli-structural-deep-fallback");
  const r = runCliWithWasmParserFailure([
    "build", root, "--strict", "--deep", "--allow-partial", "--no-gitignore", "--no-ignore",
  ]);

  assertStructuralFailure(r);
  assert.match(r.stderr, /falling back to the structural build/, r.describe());
});

test("an incremental build re-parses a cached failure: it clears once the run is healthy, and --strict still fails while it recurs", () => {
  const root = repo("cli-structural-incremental");
  const r1 = runCliWithWasmParserFailure([
    "build", root, "--no-gitignore", "--no-ignore",
  ]);
  assert.equal(r1.status, 0, r1.describe());

  // A cached failure is re-parsed, not replayed (#312): the failure can belong to
  // the run rather than the file, so the healthy file alone comes from cache.
  const strictRecurring = runCliWithWasmParserFailure([
    "build", root, "--strict", "--no-gitignore", "--no-ignore",
  ]);
  assertStructuralFailure(strictRecurring);

  const healed = runCli(["build", root, "--strict", "--no-gitignore", "--no-ignore"]);
  assert.equal(healed.status, 0, healed.describe());
  assert.match(healed.stdout, /parsed: 1 of 2 files \(1 replayed from cache\)/, healed.describe());
  assert.doesNotMatch(healed.stderr, /wiring incomplete/, healed.describe());
});

test("a healthy structural build keeps the success banner and exits 0", () => {
  const root = tmpRepo("cli-structural-success");
  writeFileSync(join(root, "healthy.ts"), "export function healthy() { return 42; }\n");

  const r = runCli(["build", root, "--no-gitignore", "--no-ignore"]);
  assert.equal(r.status, 0, r.describe());
  assert.match(r.stdout, /wiring:/, r.describe());
  assert.doesNotMatch(r.stderr, /wiring incomplete/, r.describe());
});

test("a workspace preserves and federates partial child graphs and exits 0 by default", () => {
  const root = tmpRepo("cli-structural-workspace-default");
  const broken = join(root, "broken-repo");
  const healthy = join(root, "healthy-repo");
  mkdirSync(join(broken, ".git"), { recursive: true });
  mkdirSync(join(healthy, ".git"), { recursive: true });
  writeFileSync(join(broken, "Broken.cs"), "public class Broken {}\n");
  writeFileSync(join(broken, "healthy.ts"), "export const retained = 1;\n");
  writeFileSync(join(healthy, "healthy.ts"), "export const healthy = 1;\n");

  const r = runCliWithWasmParserFailure([
    "build", root, "--no-gitignore", "--no-ignore",
  ]);

  assert.equal(r.status, 0, r.describe());
  assert.match(r.stdout, /broken-repo\/:/, r.describe());
  assert.match(r.stdout, /healthy-repo\/:/, r.describe());
  assert.match(r.stdout, /workspace: 2 repos federated/, r.describe());
  assert.match(r.stderr, /Broken\.cs: parse failed/, r.describe());
  assert.ok(existsSync(join(root, "graft", "workspace.json")));
  assert.ok(existsSync(join(broken, "graft", ".graph", "wiring.json")));
  assert.ok(existsSync(join(healthy, "graft", ".graph", "wiring.json")));
});

test("a workspace preserves and federates partial child graphs but exits 1 with --strict", () => {
  const root = tmpRepo("cli-structural-workspace-strict");
  const broken = join(root, "broken-repo");
  const healthy = join(root, "healthy-repo");
  mkdirSync(join(broken, ".git"), { recursive: true });
  mkdirSync(join(healthy, ".git"), { recursive: true });
  writeFileSync(join(broken, "Broken.cs"), "public class Broken {}\n");
  writeFileSync(join(broken, "healthy.ts"), "export const retained = 1;\n");
  writeFileSync(join(healthy, "healthy.ts"), "export const healthy = 1;\n");

  const r = runCliWithWasmParserFailure([
    "build", root, "--strict", "--no-gitignore", "--no-ignore",
  ]);

  assert.equal(r.status, 1, r.describe());
  assert.match(r.stderr, /broken-repo\/: wiring incomplete/, r.describe());
  assert.match(r.stderr, /workspace incomplete: 1 of 2 repo\(s\)/, r.describe());
  assert.match(r.stdout, /healthy-repo\/:/, r.describe());
  assert.doesNotMatch(r.stdout, /workspace: 2 repos federated/, r.describe());
  assert.ok(existsSync(join(root, "graft", "workspace.json")));
  assert.ok(existsSync(join(broken, "graft", ".graph", "wiring.json")));
  assert.ok(existsSync(join(healthy, "graft", ".graph", "wiring.json")));
});
