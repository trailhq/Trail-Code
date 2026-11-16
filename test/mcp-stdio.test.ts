import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { handleMcpStdoutError } from '../src/mcp/stdio.js';

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
