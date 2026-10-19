/**
 * A note from a session that only read code still touches the files it names,
 * so `trail check` and the ranked search can find it by file.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { mentionedFiles } from "../src/notes/notes.js";
import { tmpRepo } from "./helpers.js";

test("a note touches the repo files it names, and nothing else", () => {
  const d = tmpRepo("mentions");
  mkdirSync(join(d, "internal", "ocr"), { recursive: true });
  writeFileSync(join(d, "client.go"), "package x\n");
  writeFileSync(join(d, "internal", "ocr", "retry.go"), "package ocr\n");
  const body = "## Decided\n- Keep defaultRetryMax = 4 (client.go:51).\n- See ./internal/ocr/retry.go#Backoff, not missing.go, and v1.2 or e.g.\n- client.go again";
  assert.deepEqual(mentionedFiles(d, body), ["client.go", "internal/ocr/retry.go"]);
  assert.deepEqual(mentionedFiles(d, "nothing here"), []);
});
