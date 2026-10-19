/**
 * Front matter is YAML only: gray-matter would eval `---js` front matter, and
 * learnings, skills and graft/ cards all come from repos, a teammate's pushed
 * branch included.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { matter } from "../src/util/front-matter.js";
import { parseNote } from "../src/notes/notes.js";
import { parseTakeaway } from "../src/skills/skills.js";

const g = globalThis as { __ranFrontMatter?: number };

test("code front matter never runs, under any spelling of the fence", () => {
  for (const fence of ["js", "javascript", "JS", "Javascript", "coffee"]) {
    const text = `---${fence}\n{ title: (globalThis.__ranFrontMatter = (globalThis.__ranFrontMatter || 0) + 1, "Retries") }\n---\n## Decided\nfour\n`;
    const parsed = matter(text);
    assert.deepEqual(parsed.data, {}, fence);
    assert.equal(parseNote(text, "x.md"), null, `${fence}: a learning with no YAML title is skipped`);
    assert.equal(parseTakeaway(text, "x.md", "s")?.text.includes("globalThis") ?? false, false);
  }
  assert.equal(g.__ranFrontMatter, undefined);
});

test("YAML front matter still parses, and stringify still writes it", () => {
  const parsed = matter("---\ntitle: Retries stay at four\nauthor: Anirudh\n---\n## Decided\nfour\n");
  assert.equal(parsed.data.title, "Retries stay at four");
  assert.match(matter.stringify("body", { title: "x" }), /^---\ntitle: x\n---\n/);
});
