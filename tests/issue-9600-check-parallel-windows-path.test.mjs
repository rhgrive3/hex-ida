import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { runCheckParallel, shellEnvironment, shellInvocation } from '../scripts/run-check-parallel.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const localBin = path.join(root, 'node_modules', '.bin');

test('#9600 Windows shell environment prepends local package binaries', () => {
  const env = { PATH: 'C:\\Windows\\System32', ComSpec: 'C:\\Windows\\System32\\cmd.exe' };
  const next = shellEnvironment({ env, platform: 'win32' });
  assert.equal(next.PATH, `${localBin};C:\\Windows\\System32`);
  assert.equal(next.ComSpec, env.ComSpec);
});

test('#9600 Windows preserves the caller PATH key casing', () => {
  const env = { Path: 'C:\\Tools', ComSpec: 'cmd.exe' };
  const next = shellEnvironment({ env, platform: 'win32' });
  assert.equal(next.Path, `${localBin};C:\\Tools`);
  assert.equal(Object.hasOwn(next, 'PATH'), false);
});

test('#9600 configured Windows shell selection remains unchanged', () => {
  const env = { PATH: 'C:\\Windows\\System32', npm_config_script_shell: 'C:\\Tools\\pwsh.exe' };
  assert.deepEqual(
    shellInvocation('local-check', { env, platform: 'win32' }),
    { command: 'C:\\Tools\\pwsh.exe', args: ['-c', 'local-check'] },
  );
});

test('#9600 runCheckParallel passes augmented Windows PATH to canonical local CLI steps', async () => {
  const seen = [];
  const sink = { write() {} };
  const result = await runCheckParallel({
    checkScript: 'local-check',
    env: { PATH: 'C:\\Windows\\System32', ComSpec: 'cmd.exe' },
    platform: 'win32',
    stdout: sink,
    stderr: sink,
    runCommand: async (job) => {
      seen.push(job);
      return { ok: true, status: 0, signal: null, durationMs: 1, logPath: null };
    },
  });
  assert.equal(result.failures.length, 0);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].env.PATH, `${localBin};C:\\Windows\\System32`);
  assert.equal(seen[0].command, 'cmd.exe');
  assert.deepEqual(seen[0].args, ['/d', '/s', '/c', 'local-check']);
});
