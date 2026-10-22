import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  deleteNode, existingNodeSlugs, preserveRenamedNodeNotes, renderNodeFile,
  SLUG_POLICY, slugify, writeManifest, writeNode, type ContextNode,
} from "../src/context/node-file.js";

function node(name: string, human = ""): ContextNode {
  return { name, slug: slugify(name), type: "concept", summary: name, sources: [], sourcesDigest: "digest", links: [], human };
}

function legacy(dir: string, name: string, slug: string, note: string): string {
  const content = renderNodeFile({ ...node(name, `\n## Notes\n\n${note}\n`), slug });
  writeFileSync(join(dir, `${slug}.md`), content);
  return content;
}

function reconcile(dir: string, nodes: ContextNode[]): void {
  preserveRenamedNodeNotes(dir, nodes);
  const live = new Set(nodes.map(n => n.slug));
  for (const slug of existingNodeSlugs(dir)) if (!live.has(slug)) deleteNode(dir, slug);
  for (const n of nodes) writeNode(dir, n);
}

function backups(dir: string): string[] {
  const path = join(dir, ".cache", "slug-upgrades");
  return existsSync(path) ? readdirSync(path).map(file => readFileSync(join(path, file), "utf8")) : [];
}

test("canonical-equivalent legacy names preserve notes even when their ASCII slugs differ", () => {
  const dir = mkdtempSync(join(tmpdir(), "node-notes-nfd-"));
  try {
    const content = legacy(dir, "Cafe\u0301", "cafe", "NFD_NOTE");
    reconcile(dir, [node("Café")]);
    assert.deepEqual(backups(dir), [content], "backup retains the exact former file before pruning");
    assert.match(readFileSync(join(dir, "café.md"), "utf8"), /NFD_NOTE/);
    assert.equal(existsSync(join(dir, "cafe.md")), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("each legacy canonical spelling is backed up without overwriting an earlier note transfer", () => {
  const dir = mkdtempSync(join(tmpdir(), "node-notes-canonical-"));
  try {
    const nfc = legacy(dir, "Café", "caf", "NFC_NOTE");
    const nfd = legacy(dir, "Cafe\u0301", "cafe", "NFD_NOTE");
    reconcile(dir, [node("Café")]);
    assert.deepEqual(new Set(backups(dir)), new Set([nfc, nfd]));
    assert.match(readFileSync(join(dir, "café.md"), "utf8"), /NFC_NOTE/);
    assert.doesNotMatch(readFileSync(join(dir, "café.md"), "utf8"), /NFD_NOTE/);
    reconcile(dir, [node("Café")]);
    assert.deepEqual(new Set(backups(dir)), new Set([nfc, nfd]));
    assert.match(readFileSync(join(dir, "café.md"), "utf8"), /NFC_NOTE/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("formerly merged notes are reconciled even when the primary name keeps the ASCII slug", () => {
  const dir = mkdtempSync(join(tmpdir(), "node-notes-ascii-"));
  try {
    const content = legacy(dir, "URL", "url", "MERGED_THEMES_NOTE");
    reconcile(dir, [node("URL"), node("Канонізація URL і паритет")]);
    assert.deepEqual(backups(dir), [content]);
    assert.doesNotMatch(readFileSync(join(dir, "url.md"), "utf8"), /MERGED_THEMES_NOTE/);
    assert.doesNotMatch(readFileSync(join(dir, "канонізація-url-і-паритет.md"), "utf8"), /MERGED_THEMES_NOTE/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("an existing modern target retains its notes and exact legacy backup across rebuilds", () => {
  const dir = mkdtempSync(join(tmpdir(), "node-notes-target-"));
  try {
    const content = legacy(dir, "Café", "caf", "LEGACY_NOTE");
    writeNode(dir, node("Café", "\n## Notes\n\nTARGET_NOTE\n"));
    reconcile(dir, [node("Café")]);
    const modern = readFileSync(join(dir, "café.md"), "utf8");
    assert.match(modern, /TARGET_NOTE/);
    assert.doesNotMatch(modern, /LEGACY_NOTE/);
    assert.deepEqual(backups(dir), [content]);
    reconcile(dir, [node("Café")]);
    assert.equal(readFileSync(join(dir, "café.md"), "utf8"), modern);
    assert.deepEqual(backups(dir), [content]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a complete Unicode roster from the original policy preserves current ASCII notes", () => {
  const dir = mkdtempSync(join(tmpdir(), "node-notes-current-"));
  try {
    const nodes = [node("URL", "\n## Notes\n\nCURRENT_URL_NOTE\n"), node("Канонізація URL і паритет")];
    for (const n of nodes) writeNode(dir, n);
    writeManifest(dir, { version: 1, model: "fake", repoDigest: "digest", files: [], nodes: nodes.map(n => ({ slug: n.slug, name: n.name, type: n.type, sources: [], sourcesDigest: n.sourcesDigest })) });
    reconcile(dir, nodes.map(n => node(n.name)));
    assert.match(readFileSync(join(dir, "url.md"), "utf8"), /CURRENT_URL_NOTE/);
    assert.deepEqual(backups(dir), []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a recorded Unicode policy preserves current ASCII notes when a new Unicode concept is added", () => {
  const dir = mkdtempSync(join(tmpdir(), "node-notes-policy-"));
  try {
    const current = node("URL", "\n## Notes\n\nCURRENT_URL_NOTE\n");
    writeNode(dir, current);
    writeManifest(dir, { version: 1, slugPolicy: SLUG_POLICY, model: "fake", repoDigest: "digest", files: [], nodes: [{ slug: current.slug, name: current.name, type: current.type, sources: [], sourcesDigest: current.sourcesDigest }] });
    reconcile(dir, [node("URL"), node("Канонізація URL і паритет")]);
    assert.match(readFileSync(join(dir, "url.md"), "utf8"), /CURRENT_URL_NOTE/);
    assert.deepEqual(backups(dir), []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
