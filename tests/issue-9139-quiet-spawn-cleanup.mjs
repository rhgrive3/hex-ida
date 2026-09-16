import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { runQuietCommand } from '../scripts/run-quiet-command.mjs';

function captureSink() {
  let value = '';
  return {
    stream: { write(chunk) { value += String(chunk); } },
    text: () => value,
  };
}

function asynchronousSpawnFailure(attempt) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  queueMicrotask(() => {
    const error = Object.assign(new Error(`async-spawn-${attempt}`), { code: 'ENOENT' });
    child.emit('error', error);
  });
  return child;
}

test('#9139 cleans every asynchronous spawn-failure directory after capturing diagnostics', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hex-issue-9139-'));
  try {
    for (let attempt = 0; attempt < 16; attempt += 1) {
      const stdout = captureSink();
      const stderr = captureSink();
      const result = await runQuietCommand({
        label: `issue-9139-${attempt}`,
        command: 'missing-command',
        env: { HEX_TEST_OUTPUT: 'quiet' },
        spawnImpl: () => asynchronousSpawnFailure(attempt),
        stdout: stdout.stream,
        stderr: stderr.stream,
        tempRoot,
      });
      assert.equal(result.ok, false);
      assert.equal(result.status, null);
      assert.equal(result.error?.code, 'ENOENT');
      assert.equal(result.logPath, null);
      assert.equal(stdout.text(), '');
      assert.match(stderr.text(), new RegExp(`issue-9139-${attempt}: FAIL \\(spawn error: ENOENT,`));
      assert.match(stderr.text(), /async-spawn-/);
      assert.doesNotMatch(stderr.text(), /Full log:/);
      assert.match(stderr.text(), /Spawn failure log cleaned after diagnostic capture/);
    }
    assert.deepEqual(fs.readdirSync(tempRoot), []);

    const synchronousError = new Error('synchronous-spawn-failure');
    await assert.rejects(
      () => runQuietCommand({
        label: 'issue-9139-sync',
        command: 'missing-command',
        env: { HEX_TEST_OUTPUT: 'quiet' },
        spawnImpl() { throw synchronousError; },
        stdout: captureSink().stream,
        stderr: captureSink().stream,
        tempRoot,
      }),
      (error) => error === synchronousError,
    );
    assert.deepEqual(fs.readdirSync(tempRoot), []);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
