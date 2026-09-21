import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import test from 'node:test';

import { runQuietCommand } from '../scripts/run-quiet-command.mjs';

test('async spawn error remains primary when diagnostic cleanup also fails', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'quiet-9398-'));
  const spawnError = Object.assign(new Error('missing executable'), { code: 'ENOENT' });
  const cleanupError = Object.assign(new Error('temp cleanup failed'), { code: 'EIO' });
  let stderrText = '';
  try {
    const spawnImpl = () => {
      const child = new EventEmitter();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.pid = undefined;
      child.exitCode = null;
      child.signalCode = null;
      child.kill = () => true;
      queueMicrotask(() => child.emit('error', spawnError));
      return child;
    };

    const result = await runQuietCommand({
      label: 'missing-command',
      command: 'definitely-missing',
      spawnImpl,
      tempRoot,
      removeDirectory() { throw cleanupError; },
      stdout: { write() {} },
      stderr: { write(chunk) { stderrText += String(chunk); } },
    });

    assert.equal(result.ok, false);
    assert.equal(result.error, spawnError);
    assert.equal(result.cleanupError, cleanupError);
    assert.ok(result.logPath, 'failed cleanup must expose the retained diagnostic path');
    assert.match(stderrText, /spawn error: ENOENT/);
    assert.match(stderrText, /cleanup failed \(EIO\)/);
    assert.doesNotMatch(stderrText, /FAIL \(spawn error: EIO/);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
