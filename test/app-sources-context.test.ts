/**
 * The early upload carries every file a team wrote for its agents, not only
 * the root ones: folder CLAUDE.md / AGENTS.md files and Claude skills. What
 * matters is which ones — shallow enough, outside dependencies and build
 * output, not ignored, never graft's own — and that there is a cap.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { folderInstructionFiles, readAgentInstructions, skillFiles } from '../src/app/sources.js';
import { tmpRepo } from './helpers.js';

function put(root: string, rel: string, text: string): void {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), text);
}

function fixture(): string {
  const root = tmpRepo('sources');
  put(root, 'CLAUDE.md', '# root\n\nUse pnpm.\n');
  put(root, 'web/CLAUDE.md', '# web\n\nComponents are PascalCase.\n');
  put(root, 'services/api/AGENTS.md', '# api\n\nHandlers stay thin.\n');
  put(root, 'a/b/c/d/CLAUDE.md', '# depth four\n\nStill read.\n');
  put(root, 'a/b/c/d/e/CLAUDE.md', '# depth five\n\nToo deep.\n');
  put(root, 'node_modules/pkg/CLAUDE.md', '# dependency\n');
  put(root, 'dist/CLAUDE.md', '# build output\n');
  put(root, 'graft/CLAUDE.md', '# graft cache\n');
  put(root, '.hidden/CLAUDE.md', '# dot dir\n');
  put(root, 'scratch/CLAUDE.md', '# ignored by the repo\n');
  put(root, '.gitignore', 'scratch/\n');
  put(root, '.claude/skills/deploy/SKILL.md', '---\nname: deploy\n---\nAlways deploy from main.\n');
  put(root, '.claude/skills/graft/SKILL.md', '---\nname: graft\n---\ngraft teaches graft\n');
  put(root, '.claude/skills/empty/README.md', 'no skill file here\n');
  put(root, 'web/AGENTS.md', 'before\n<!-- graft:start -->\ngraft block\n<!-- graft:end -->\nafter\n');
  return root;
}

test('folder instruction files: shallow ones, outside ignored and generated dirs, shallowest first', () => {
  const root = fixture();
  spawnSync('git', ['init', '-q'], { cwd: root });
  const got = folderInstructionFiles(root);
  assert.deepEqual(got, ['web/AGENTS.md', 'web/CLAUDE.md', 'services/api/AGENTS.md', 'a/b/c/d/CLAUDE.md']);
});

test('folder instruction files are found without git too', () => {
  const root = fixture();
  const got = folderInstructionFiles(root);
  // No git to read .gitignore, so scratch/ is read; everything else is the same.
  assert.ok(got.includes('web/CLAUDE.md') && got.includes('a/b/c/d/CLAUDE.md'));
  assert.ok(!got.some((p) => /node_modules|dist|graft\/|\.hidden|\/e\//.test(p)), got.join(', '));
});

test('folder instruction files are capped', () => {
  const root = tmpRepo('sources-cap');
  for (let i = 0; i < 40; i++) put(root, `pkg${String(i).padStart(2, '0')}/CLAUDE.md`, `# ${i}\n\nrule ${i}\n`);
  assert.equal(folderInstructionFiles(root).length, 30);
  assert.equal(folderInstructionFiles(root, 5).length, 5);
});

test('skills: every SKILL.md but graft\'s own', () => {
  const root = fixture();
  assert.deepEqual(skillFiles(root), ['.claude/skills/deploy/SKILL.md']);
});

test('readAgentInstructions carries them all as agent_instructions, graft blocks stripped', () => {
  const root = fixture();
  spawnSync('git', ['init', '-q'], { cwd: root });
  const got = readAgentInstructions(root);
  const paths = got.map((s) => s.path);
  for (const p of ['CLAUDE.md', 'web/CLAUDE.md', 'services/api/AGENTS.md', '.claude/skills/deploy/SKILL.md']) {
    assert.ok(paths.includes(p), `${p} missing from ${paths.join(', ')}`);
  }
  assert.ok(got.every((s) => s.kind === 'agent_instructions'));
  const web = got.find((s) => s.path === 'web/AGENTS.md')!;
  assert.doesNotMatch(web.text, /graft block/);
  assert.match(web.text, /before[\s\S]*after/);
  assert.ok(!paths.includes('.claude/skills/graft/SKILL.md'));
});
