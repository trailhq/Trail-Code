import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { handleMcpStdoutError } from '../src/mcp/stdio.js';
import { closeSync, existsSync, mkdtempSync, openSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('MCP stdout EPIPE exits cleanly after the host disconnects', async () => {
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `
    import { handleMcpStdoutError } from './src/mcp/stdio.ts';
    process.stdout.on('error', handleMcpStdoutError);
    process.stderr.write('ready\\n');
    process.stdin.once('data', () => process.stdout.write('reply\\n'));
  `], { stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
  await new Promise<void>((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error(`child did not become ready: ${stderr}`)), 10_000);
    child.stderr.on('data', (chunk: string) => {
      output += chunk;
      if (output.includes('ready\n')) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      reject(new Error(`child exited before ready: ${code}/${signal}`));
    });
  });

  child.stdout.destroy();
  child.stdin.end('go');
  const [code, signal] = await once(child, 'exit') as [number | null, NodeJS.Signals | null];
  assert.equal(code, 0, stderr);
  assert.equal(signal, null, stderr);
  assert.doesNotMatch(stderr, /EPIPE/);
});

test('MCP stdout handler still surfaces unexpected stream errors', () => {
  assert.throws(() => handleMcpStdoutError(Object.assign(new Error('unexpected'), { code: 'EINVAL' })), /unexpected/);
});

// A launcher between the client and the server can die while something else
// still holds stdin open, so the server is reparented and never sees EOF.
// Nothing but a parent check tells it to stop.
test('MCP server exits when its parent goes away and stdin stays open',
  { skip: process.platform === 'win32' ? 'needs mkfifo and signals' : false }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'graft-mcp-orphan-'));
  const home = mkdtempSync(join(tmpdir(), 'graft-mcp-orphan-home-'));
  const fifo = join(dir, 'in');
  const replies = join(dir, 'replies');
  execFileSync('mkfifo', [fifo]);
  const { TRAIL_HOME: _t, GRAFT_HOME: _g, ...env } = process.env;
  // The launcher starts the server on the FIFO and waits, so the server's stdin
  // has a writer that is not the launcher. Killing the launcher leaves the
  // server with stdin open and no parent.
  const launcher = spawn('/bin/sh', ['-c',
    `exec "${process.execPath}" --import tsx src/cli.ts mcp "$1" < "$2" > "$3" 2>&1 & echo $!; wait`,
    'sh', dir, fifo, replies], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...env, HOME: home } });
  let out = '';
  launcher.stdout.setEncoding('utf8').on('data', (chunk: string) => { out += chunk; });
  const writer = openSync(fifo, 'w');
  const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  try {
    const pid = await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`launcher did not report a pid: ${out}`)), 10_000);
      launcher.stdout.on('data', () => {
        const first = Number(out.trim().split('\n')[0]);
        if (Number.isInteger(first) && first > 0) { clearTimeout(timer); resolve(first); }
      });
    });
    // Kill only once the server is serving: a parent captured after the
    // reparenting says nothing about the case the watchdog exists for.
    execFileSync('sh', ['-c', `printf '%s\\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}' > "${fifo}"`]);
    const ready = Date.now() + 20_000;
    while (Date.now() < ready) {
      const seen = existsSync(replies) ? readFileSync(replies, 'utf8') : '';
      if (seen.includes('"id":1')) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.equal(alive(pid), true, 'server did not start');

    launcher.kill('SIGKILL');
    await once(launcher, 'exit');
    const deadline = Date.now() + 8_000;
    while (alive(pid) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
    const stillAlive = alive(pid);
    if (stillAlive) process.kill(pid, 'SIGKILL');
    assert.equal(stillAlive, false, 'server outlived the launcher that started it');
  } finally {
    closeSync(writer);
    if (launcher.exitCode === null && launcher.signalCode === null) launcher.kill('SIGKILL');
  }
});
