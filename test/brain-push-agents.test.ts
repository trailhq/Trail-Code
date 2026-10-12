/**
 * The push tells Trail which agents this repo is wired for, so its sidebar
 * shows only the context files those agents read — the same set `graft trail
 * pull` filters by. A repo that has never been wired sends none, and Trail then
 * shows every kind.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pickedAgents } from '../src/brain/push.js';
import { buildDigest } from '../src/app/history.js';

const empty = {
  owner: 'o', name: 'n', headSha: 'h', defaultBranch: 'main', isPrivate: false,
  commits: [], threads: [], symbols: [], sources: [], autoApprove: true,
};

test('an unwired repo sends no agents', () => {
  const repo = mkdtempSync(join(tmpdir(), 'graft-agents-'));
  assert.deepEqual(pickedAgents(repo), []);
  assert.equal('agents' in buildDigest({ ...empty, agents: pickedAgents(repo) }), false);
});

test('a repo wired for Claude Code and Cursor sends both', () => {
  const repo = mkdtempSync(join(tmpdir(), 'graft-agents-'));
  mkdirSync(join(repo, '.claude', 'helpers'), { recursive: true });
  writeFileSync(join(repo, '.claude', 'helpers', 'graft-hooks.cjs'), '');
  mkdirSync(join(repo, '.cursor', 'rules'), { recursive: true });
  writeFileSync(join(repo, '.cursor', 'rules', 'graft.mdc'), '---\n---\n');
  const agents = pickedAgents(repo);
  assert.ok(agents.includes('claude'));
  assert.ok(agents.includes('cursor'));
  assert.deepEqual(buildDigest({ ...empty, agents }).agents, agents);
});
