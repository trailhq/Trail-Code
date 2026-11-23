/**
 * Active-layer install for Google Antigravity (`~/.gemini/config/hooks.json`).
 *
 * Antigravity speaks its own lifecycle hook contract (camelCase payloads on
 * stdin, `{ injectSteps }` / `{}` / `{ decision }` on stdout, and a top-level
 * named-hook map in `~/.gemini/config/hooks.json`), whereas Trail's shared
 * hooks shim (`hooks.js`) speaks Claude Code's snake_case contract. Three files
 * under `~/.gemini/config/`, mirroring the Pi and Codex installs:
 *
 *   - the SAME shared shim (`~/.gemini/config/hooks/<name>/<name>-hooks.cjs`):
 *     all real hook logic stays in the installed package and upgrades with it;
 *   - a tiny zero-dependency CJS adapter
 *     (`~/.gemini/config/hooks/<name>/<name>-antigravity-hooks.cjs`) that
 *     translates Antigravity's four events (`SessionStart`, `PreInvocation`,
 *     `PostToolUse`, `Stop`) to/from the shim's stdin/stdout contract;
 *   - a named top-level `<name>` entry merged into `~/.gemini/config/hooks.json`,
 *     leaving every foreign named hook untouched.
 *
 * `PreInvocation` fires before every model call inside a turn (not just once per
 * user prompt), and Antigravity's `PostToolUse` expects an empty `{}` output
 * rather than inline context. The adapter keeps tiny per-conversation state
 * under its own private `.state/` dir (inside `~/.gemini/config/hooks/<name>/`,
 * never world-writable `/tmp`) so `prompt` runs once per user turn and any
 * `post-edit` blast radius / file learnings are delivered on the very next
 * `PreInvocation`.
 *
 * User-level (`~/.gemini/config`), so `--no-global` suppresses these and the
 * picker labels them machine-wide. `antigravityHookTargets()` is the pure half
 * (planning / retract); `installAntigravityHooks()` does the writes.
 */
import { existsSync, mkdirSync, rmSync, rmdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { hooksShim } from '../claude/shim-template.js';
import { failOpen } from '../claude/settings-merge.js';
import { toPosixPath } from '../util/paths.js';
import type { PlannedWrite } from './plan.js';
import { readJsonObject, writeOwned, type ConfigWrite } from './config-write.js';
import type { Brand } from '../brand.js';

function dirExists(p: string): boolean {
  try { return statSync(p).isDirectory(); } catch { return false; }
}

/** Antigravity's edit/write tool names across Antigravity 2.0 and IDE. */
export const ANTIGRAVITY_EDIT_MATCHER =
  'edit_file|write_file|replace_file_content|multi_replace_file_content|write_to_file';

/** `~/.gemini/config/hooks/<name>/<name>-hooks.cjs`. */
export function antigravityShimPathFor(home: string, name: Brand = 'graft'): string {
  return join(home, '.gemini', 'config', 'hooks', name, `${name}-hooks.cjs`);
}

/** `~/.gemini/config/hooks/<name>/<name>-antigravity-hooks.cjs`. */
export function antigravityAdapterPathFor(home: string, name: Brand = 'graft'): string {
  return join(home, '.gemini', 'config', 'hooks', name, `${name}-antigravity-hooks.cjs`);
}

/** `~/.gemini/config/hooks/<name>/.state` — private per-conversation adapter state. */
export function antigravityStateDirFor(home: string, name: Brand = 'graft'): string {
  return join(home, '.gemini', 'config', 'hooks', name, '.state');
}

/** `~/.gemini/config/hooks.json` — Antigravity's global lifecycle hooks config. */
export function antigravityHooksConfigPathFor(home: string): string {
  return join(home, '.gemini', 'config', 'hooks.json');
}

/**
 * The files an Antigravity-hooks install would touch — pure, no writes. All
 * three live under `~/.gemini/config`, so all are scoped 'global': the hooks
 * fire in every workspace opened with Antigravity, not just this one. Empty
 * when Antigravity's global config dir is absent, mirroring `codex-hooks` and
 * `pi-hooks`.
 */
export function antigravityHookTargets(home: string, name: Brand = 'graft'): PlannedWrite[] {
  if (!dirExists(join(home, '.gemini', 'config'))) return [];
  return [
    {
      hostId: 'antigravity', id: 'antigravity-hook-shim',
      path: antigravityShimPathFor(home, name),
      scope: 'global', kind: 'hook', what: 'hooks shim (user level)',
    },
    {
      hostId: 'antigravity', id: 'antigravity-hook-adapter',
      path: antigravityAdapterPathFor(home, name),
      scope: 'global', kind: 'hook', what: 'Antigravity hook adapter',
    },
    {
      hostId: 'antigravity', id: 'antigravity-hooks',
      path: antigravityHooksConfigPathFor(home),
      scope: 'global', kind: 'hook', what: 'SessionStart / PreInvocation / PostToolUse / Stop',
    },
  ];
}

/** The named hook block written under `root[name]` in `~/.gemini/config/hooks.json`. */
export function desiredAntigravityHookBlock(adapterPath: string): Record<string, unknown> {
  const cmd = (sub: string) => failOpen(`node "${toPosixPath(adapterPath)}" ${sub}`);
  return {
    SessionStart: [{ type: 'command', command: cmd('session-start'), timeout: 10 }],
    PreInvocation: [{ type: 'command', command: cmd('prompt'), timeout: 15 }],
    PostToolUse: [
      {
        matcher: ANTIGRAVITY_EDIT_MATCHER,
        hooks: [{ type: 'command', command: cmd('post-edit'), timeout: 10 }],
      },
    ],
    Stop: [{ type: 'command', command: cmd('stop'), timeout: 10 }],
  };
}

/**
 * The generated CJS adapter: translates between Antigravity's hook JSON
 * contract and the shared shim's Claude-Code-shaped stdin/stdout contract.
 *
 * Security & reliability invariants:
 *   - No shell strings: spawns `process.execPath` directly with `windowsHide: true`.
 *   - Never falls back to `process.cwd()` (which Antigravity sets to the folder
 *     holding `hooks.json`, i.e., `~/.gemini/config/`): requires `input.cwd` or
 *     `input.workspacePaths[0]`, else returns `{}` cleanly.
 *   - Per-conversation state lives inside `__dirname/.state` (user-private
 *     `~/.gemini/config/hooks/<name>/.state`), keyed by a SHA-256 hex digest of
 *     `conversationId` (no path traversal, no world-writable `/tmp`).
 *   - Missing shim, wedged child, or unparseable JSON always produces `{}` on
 *     stdout and exits 0 — hooks are enhancements, never load-bearing.
 */
export function antigravityAdapterTemplate(shimPath: string, name: Brand = 'graft'): string {
  return `#!/usr/bin/env node
// Generated by \`${name} init\` (Antigravity hook adapter) — do not edit; re-running init rewrites it.
// Spawns the hooks shim on Antigravity's four lifecycle hook events and reshapes the results.
// The real logic lives in the installed package's hooks.js and upgrades with it.
'use strict';

const { spawn } = require('node:child_process');
const { createHash } = require('node:crypto');
const { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } = require('node:fs');
const { isAbsolute, join, resolve } = require('node:path');

const SHIM = ${JSON.stringify(shimPath)};
const STATE_DIR = join(__dirname, '.state');
const TIMEOUT_MS = { prompt: 15000, 'session-start': 10000, 'post-edit': 10000, stop: 10000 };
const PENDING_CAP = 5;
const STATE_TTL_MS = 24 * 60 * 60 * 1000;

function readStdin() {
  try {
    const raw = readFileSync(0, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function resolveDir(input) {
  if (typeof input.cwd === 'string' && input.cwd.trim()) return input.cwd;
  if (Array.isArray(input.workspacePaths)) {
    const first = input.workspacePaths.find((p) => typeof p === 'string' && p.trim());
    if (first) return first;
  }
  return null;
}

function sessionIdOf(input) {
  return typeof input.conversationId === 'string' && input.conversationId.trim()
    ? input.conversationId
    : 'default';
}

function hashText(text) {
  return createHash('sha256').update(String(text)).digest('hex');
}

function stateFile(sessionId) {
  return join(STATE_DIR, hashText(sessionId).slice(0, 24) + '.json');
}

function readState(sessionId) {
  try {
    const raw = JSON.parse(readFileSync(stateFile(sessionId), 'utf8'));
    return {
      turnActive: Boolean(raw && raw.turnActive),
      lastPromptHash: typeof raw?.lastPromptHash === 'string' ? raw.lastPromptHash : '',
      pending: Array.isArray(raw?.pending) ? raw.pending.filter((x) => typeof x === 'string' && x) : [],
    };
  } catch {
    return { turnActive: false, lastPromptHash: '', pending: [] };
  }
}

function writeState(sessionId, state) {
  try {
    mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
    writeFileSync(stateFile(sessionId), JSON.stringify(state), { mode: 0o600 });
  } catch {
    /* best-effort: state loss degrades to a clean no-op */
  }
}

function pruneState() {
  try {
    const cutoff = Date.now() - STATE_TTL_MS;
    for (const f of readdirSync(STATE_DIR)) {
      const p = join(STATE_DIR, f);
      try {
        if (statSync(p).mtimeMs < cutoff) rmSync(p, { force: true });
      } catch { /* ignore */ }
    }
  } catch {
    /* state dir not created yet */
  }
}

function editedPathOf(input, dir) {
  const args = input && input.toolCall && typeof input.toolCall === 'object' ? input.toolCall.args : null;
  if (!args || typeof args !== 'object') return null;
  const raw = [args.Path, args.TargetFile, args.file_path, args.path].find(
    (v) => typeof v === 'string' && v.trim(),
  );
  if (!raw) return null;
  return isAbsolute(raw) ? raw : resolve(dir, raw);
}

/** Spawn the shim with a Claude-Code-shaped payload on stdin; resolve its parsed JSON or null. */
function runShim(sub, payload) {
  return new Promise((resolveHook) => {
    let settled = false;
    let timer;
    const done = (value) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolveHook(value);
    };
    let child;
    try {
      child = spawn(process.execPath, [SHIM, sub], {
        stdio: ['pipe', 'pipe', 'ignore'],
        windowsHide: true,
      });
    } catch {
      done(null);
      return;
    }
    let out = '';
    timer = setTimeout(() => {
      try { child.kill(); } catch { /* already gone */ }
      done(null);
    }, TIMEOUT_MS[sub] || 10000);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.on('error', () => done(null));
    child.on('close', () => {
      try {
        const parsed = JSON.parse(out);
        done(parsed && typeof parsed === 'object' ? parsed : null);
      } catch {
        done(null);
      }
    });
    child.stdin.on('error', () => { /* shim exited before reading stdin */ });
    child.stdin.end(JSON.stringify(payload));
  });
}

function extract(parsed) {
  const ctx = parsed && parsed.hookSpecificOutput && typeof parsed.hookSpecificOutput.additionalContext === 'string'
    ? parsed.hookSpecificOutput.additionalContext
    : '';
  const notice = parsed && typeof parsed.systemMessage === 'string' ? parsed.systemMessage : '';
  const blockReason = parsed && parsed.decision === 'block' && typeof parsed.reason === 'string'
    ? parsed.reason
    : '';
  return { ctx, notice, blockReason };
}

function toInjectOutput(contexts, notices) {
  const injectSteps = [];
  const joined = contexts.filter(Boolean).join('\\n\\n');
  if (joined) injectSteps.push({ systemMessage: { systemMessage: joined } });
  for (const n of notices.filter(Boolean)) {
    injectSteps.push({ systemMessage: { systemMessage: '', metadata: { user_markdown: n } } });
  }
  return injectSteps.length ? { injectSteps } : {};
}

function respond(obj) {
  process.stdout.write(JSON.stringify(obj));
}

async function main() {
  const event = process.argv[2] || '';
  const input = readStdin();
  const dir = resolveDir(input);
  if (!dir) {
    respond({});
    return;
  }
  const sessionId = sessionIdOf(input);

  if (event === 'session-start') {
    pruneState();
    writeState(sessionId, { turnActive: false, lastPromptHash: '', pending: [] });
    const parsed = await runShim('session-start', { cwd: dir, session_id: sessionId });
    const { ctx, notice } = extract(parsed);
    respond(toInjectOutput(ctx ? [ctx] : [], notice ? [notice] : []));
    return;
  }

  if (event === 'prompt') {
    const state = readState(sessionId);
    const contexts = [...state.pending];
    const notices = [];
    const prompt = typeof input.lastUserInput === 'string' ? input.lastUserInput : '';
    const promptHash = prompt ? hashText(prompt) : '';
    const isNewTurn = !state.turnActive || (promptHash !== '' && promptHash !== state.lastPromptHash);

    if (isNewTurn || contexts.length > 0) {
      writeState(sessionId, {
        turnActive: true,
        lastPromptHash: promptHash || state.lastPromptHash,
        pending: [],
      });
    }

    if (isNewTurn && prompt) {
      const parsed = await runShim('prompt', { prompt, cwd: dir, session_id: sessionId });
      const { ctx, notice } = extract(parsed);
      if (ctx) contexts.push(ctx);
      if (notice) notices.push(notice);
    }

    respond(toInjectOutput(contexts, notices));
    return;
  }

  if (event === 'post-edit') {
    if (typeof input.error === 'string' && input.error.trim()) {
      respond({});
      return;
    }
    const filePath = editedPathOf(input, dir);
    if (!filePath) {
      respond({});
      return;
    }
    const parsed = await runShim('post-edit', {
      tool_input: { file_path: filePath },
      cwd: dir,
      session_id: sessionId,
    });
    const { ctx } = extract(parsed);
    if (ctx) {
      const state = readState(sessionId);
      state.pending = [...state.pending, ctx].slice(-PENDING_CAP);
      writeState(sessionId, state);
    }
    respond({});
    return;
  }

  if (event === 'stop') {
    const state = readState(sessionId);
    writeState(sessionId, { turnActive: false, lastPromptHash: state.lastPromptHash, pending: [] });
    const parsed = await runShim('stop', {
      cwd: dir,
      session_id: sessionId,
      stop_hook_active: Boolean(input.continuationActive),
    });
    const { blockReason } = extract(parsed);
    const normalEnd = !input.terminationReason || input.terminationReason === 'NO_TOOL_CALL';
    if (blockReason && !input.continuationActive && normalEnd) {
      respond({ decision: 'continue', reason: blockReason });
      return;
    }
    respond({});
    return;
  }

  respond({});
}

main().catch(() => {
  respond({});
});
`;
}

/** Whether a top-level entry in `~/.gemini/config/hooks.json` is one graft/trail installed. */
export function isAntigravityHookBlock(entry: unknown): boolean {
  const s = JSON.stringify(entry ?? '');
  return s.includes('graft-antigravity-hooks.cjs') || s.includes('trail-antigravity-hooks.cjs');
}

/**
 * Remove legacy graft hook files under `~/.gemini/config/hooks/graft/` once a
 * machine moves to trail, pruning the empty directory if nothing else lives there.
 */
function removeGraftHookFiles(home: string): void {
  rmSync(antigravityAdapterPathFor(home, 'graft'), { force: true });
  rmSync(antigravityShimPathFor(home, 'graft'), { force: true });
  rmSync(antigravityStateDirFor(home, 'graft'), { recursive: true, force: true });
  try { rmdirSync(dirname(antigravityShimPathFor(home, 'graft'))); } catch { /* not empty or absent */ }
}

/**
 * Install (or refresh) Antigravity's global hook layer. Idempotent, and
 * conservative with hand-edited configs: an unparseable `hooks.json` is left
 * untouched (`skipped-unparseable`), and every foreign top-level hook entry is
 * preserved byte for byte.
 *
 * Machine-wide brand rule (mirroring `antigravity.ts` and `mcp-config.ts`):
 *   - under `trail`, `graft`'s top-level block and files go so Antigravity
 *     never runs both;
 *   - under `graft`, if `trail`'s block is already wired in `hooks.json`, leave
 *     it alone rather than adding `graft` beside it.
 */
export function installAntigravityHooks(home: string, name: Brand = 'graft'): ConfigWrite[] {
  const targets = antigravityHookTargets(home, name);
  if (targets.length === 0) return [];

  const [shimTarget, adapterTarget, cfgTarget] = targets;
  const loaded = readJsonObject(cfgTarget.path);
  if (loaded !== 'unparseable' && name === 'graft' && isAntigravityHookBlock(loaded.root.trail)) {
    return [
      { id: shimTarget.id, path: antigravityShimPathFor(home, 'trail'), action: 'unchanged' },
      { id: adapterTarget.id, path: antigravityAdapterPathFor(home, 'trail'), action: 'unchanged' },
      { id: cfgTarget.id, path: cfgTarget.path, action: 'unchanged' },
    ];
  }

  const shimWrite = writeOwned(shimTarget.id, shimTarget.path, hooksShim(), 0o755);
  const adapterWrite = writeOwned(
    adapterTarget.id,
    adapterTarget.path,
    antigravityAdapterTemplate(shimTarget.path, name),
    0o755,
  );
  if (name === 'trail' && existsSync(dirname(antigravityShimPathFor(home, 'graft')))) {
    removeGraftHookFiles(home);
  }

  if (loaded === 'unparseable') {
    return [shimWrite, adapterWrite, { id: cfgTarget.id, path: cfgTarget.path, action: 'skipped-unparseable' }];
  }

  const { root, existed } = loaded;
  const before = JSON.stringify(root);
  if (name === 'trail' && isAntigravityHookBlock(root.graft)) delete root.graft;
  root[name] = desiredAntigravityHookBlock(adapterTarget.path);

  if (JSON.stringify(root) === before) {
    return [shimWrite, adapterWrite, { id: cfgTarget.id, path: cfgTarget.path, action: 'unchanged' }];
  }
  mkdirSync(dirname(cfgTarget.path), { recursive: true });
  writeFileSync(cfgTarget.path, `${JSON.stringify(root, null, 2)}\n`);
  return [shimWrite, adapterWrite, { id: cfgTarget.id, path: cfgTarget.path, action: existed ? 'updated' : 'created' }];
}
