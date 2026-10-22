/**
 * How `src/ai/providers.ts` resolves the model configuration — in particular the
 * synthesis model, which exists so the concept pass can ride a different (say,
 * fast non-reasoning) model than the per-file summaries. The rule it must pin:
 * synthesis defaults to the build model, and an explicit synthesis model — flag
 * or env — wins, because the synthesis cache key is derived from it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveConfig } from "../src/ai/providers.js";

/** The model-related env the config reads, saved and restored around each test. */
const MODEL_ENV = ["GRAFT_MODEL", "GRAFT_SYNTH_MODEL"] as const;

function withoutModelEnv(): NodeJS.ProcessEnv {
  const saved: Record<string, string | undefined> = {};
  for (const k of MODEL_ENV) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  return saved;
}

function restoreModelEnv(saved: NodeJS.ProcessEnv): void {
  for (const k of MODEL_ENV) {
    const v = saved[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

test("the synthesis model defaults to the build model", () => {
  const saved = withoutModelEnv();
  try {
    assert.equal(resolveConfig({ model: "m" }).synthModel, "m");
    // And when the build model itself comes from the environment.
    process.env.GRAFT_MODEL = "env-m";
    assert.equal(resolveConfig().synthModel, "env-m");
  } finally {
    restoreModelEnv(saved);
  }
});

test("an explicit synthesis model wins over the build model, in config then env", () => {
  const saved = withoutModelEnv();
  try {
    assert.equal(resolveConfig({ model: "m", synthModel: "s" }).synthModel, "s");
    process.env.GRAFT_SYNTH_MODEL = "env-s";
    assert.equal(resolveConfig({ model: "m" }).synthModel, "env-s");
    // Config beats env, the same order every other knob follows.
    assert.equal(resolveConfig({ model: "m", synthModel: "s" }).synthModel, "s");
  } finally {
    restoreModelEnv(saved);
  }
});
