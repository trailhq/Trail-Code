import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { forEachFileLine, forEachLine, openAtomic } from "../src/util/json-stream.js";

test("openAtomic: nothing is visible at the target until commit, and the temp file is gone after", () => {
  const d = mkdtempSync(join(tmpdir(), "graft-atomic-"));
  const p = join(d, "sub", "out.json");
  const w = openAtomic(p);
  w.write("{\"a\":");
  assert.ok(!existsSync(p), "target absent before commit");
  w.write("1}\n");
  w.commit();
  assert.equal(readFileSync(p, "utf8"), "{\"a\":1}\n");
  assert.deepEqual(readdirSync(join(d, "sub")), ["out.json"], "no temp file left behind");
});

test("openAtomic: abort leaves no file", () => {
  const d = mkdtempSync(join(tmpdir(), "graft-atomic-"));
  const p = join(d, "out.json");
  const w = openAtomic(p);
  w.write("partial");
  w.abort();
  assert.deepEqual(readdirSync(d), []);
});

test("openAtomic: a multi-megabyte chunk is written whole (short-write loop)", () => {
  const d = mkdtempSync(join(tmpdir(), "graft-atomic-"));
  const p = join(d, "big.txt");
  const chunk = "x".repeat(8 * 1024 * 1024) + "é\n"; // multibyte tail catches byte/char confusion
  const w = openAtomic(p);
  w.write(chunk);
  w.commit();
  assert.equal(readFileSync(p, "utf8"), chunk);
});

test("forEachLine: splits on newline, handles a missing trailing newline, and decodes UTF-8 per line", () => {
  const seen: [string, number][] = [];
  forEachLine(Buffer.from("a\n{\"k\":\"é\"}\n\nlast"), (l, i) => seen.push([l, i]));
  assert.deepEqual(seen, [["a", 0], ["{\"k\":\"é\"}", 1], ["", 2], ["last", 3]]);
});

test("forEachLine: an empty buffer yields nothing", () => {
  let n = 0;
  forEachLine(Buffer.alloc(0), () => n++);
  assert.equal(n, 0);
});

test("forEachLine: a CRLF line ending is stripped like LF", () => {
  const seen: string[] = [];
  forEachLine(Buffer.from("a\r\nb\r\n"), (l) => seen.push(l));
  assert.deepEqual(seen, ["a", "b"]);
});

test("forEachFileLine: lines straddling every chunk boundary come out whole, multibyte UTF-8 and CRLF included", () => {
  const d = mkdtempSync(join(tmpdir(), "graft-lines-"));
  const p = join(d, "lines.ndjson");
  const text = "a\n{\"k\":\"é\"}\r\n\nlonger line than any chunk é€😀\r\nlast";
  writeFileSync(p, text);
  const expected: [string, number][] = [["a", 0], ["{\"k\":\"é\"}", 1], ["", 2], ["longer line than any chunk é€😀", 3], ["last", 4]];
  for (const chunk of [1, 2, 3, 5, 7, 64 * 1024]) {
    const seen: [string, number][] = [];
    forEachFileLine(p, (l, i) => seen.push([l, i]), chunk);
    assert.deepEqual(seen, expected, `chunk size ${chunk}`);
  }
});

test("forEachFileLine: an empty file yields nothing; a trailing newline adds no line", () => {
  const d = mkdtempSync(join(tmpdir(), "graft-lines-"));
  const empty = join(d, "empty");
  writeFileSync(empty, "");
  let n = 0;
  forEachFileLine(empty, () => n++, 4);
  assert.equal(n, 0);
  const one = join(d, "one");
  writeFileSync(one, "x\n");
  const seen: string[] = [];
  forEachFileLine(one, (l) => seen.push(l), 1);
  assert.deepEqual(seen, ["x"]);
});
