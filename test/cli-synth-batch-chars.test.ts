/**
 * `--synth-batch-chars` input validation at the CLI boundary (`src/cli.ts`).
 *
 * 0 and negatives used to be floored into a 1-char budget: one synthesis call
 * per file — the exact per-file call storm the batch pass exists to prevent —
 * because `Math.max(1, …)` ran before the guard that was meant to catch exactly
 * those values. The raw value is validated instead, so a degenerate budget is a
 * usage error, not a silent way to pay for a repo one file at a time.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runCli, tmpRepo } from "./helpers.js";

/** Env with every graft LLM/env knob removed, so this test never inherits a
 *  developer's provider: the valid case below must degrade to the $0 structural
 *  build, not call anyone. */
function cleanEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const k of [
    "GRAFT_API_KEY", "GRAFT_PROVIDER", "GRAFT_MODEL", "GRAFT_SYNTH_MODEL",
    "GRAFT_BASE_URL", "GRAFT_DIR", "OPENROUTER_API_KEY", "ORCAROUTER_API_KEY",
  ]) {
    delete env[k];
  }
  return env;
}

function repo(tag: string): string {
  const dir = tmpRepo(tag);
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "src", "m.ts"), "export const m = 1;\n");
  return dir;
}

test("a budget of 0 or less is a usage error, not a 1-char budget", () => {
  const dir = repo("synthchars-bad");
  for (const bad of ["0", "-5", "-0.5"]) {
    const r = runCli(["build", dir, "--deep", "--synth-batch-chars", bad], { env: cleanEnv() });
    assert.equal(r.status, 1, `expected exit 1 for --synth-batch-chars ${bad}\n${r.describe()}`);
    assert.match(r.stderr, /--synth-batch-chars must be a positive number/);
    assert.doesNotMatch(r.stderr, /✓ concepts:/, "the build must not run on a rejected budget");
  }
});

test("a non-numeric budget is still rejected", () => {
  const dir = repo("synthchars-nan");
  for (const bad of ["abc", "1e999"]) {
    const r = runCli(["build", dir, "--deep", "--synth-batch-chars", bad], { env: cleanEnv() });
    assert.equal(r.status, 1, `expected exit 1 for --synth-batch-chars ${bad}\n${r.describe()}`);
    assert.match(r.stderr, /--synth-batch-chars must be a positive number/);
  }
});

test("a valid budget still builds", () => {
  const dir = repo("synthchars-ok");
  const r = runCli(["build", dir, "--deep", "--synth-batch-chars", "24000"], { env: cleanEnv() });
  assert.equal(r.status, 0, `a valid budget must build\n${r.describe()}`);
  assert.doesNotMatch(r.stderr, /--synth-batch-chars must be a positive number/);
});
