// #9224: when the injected log-stream factory throws before returning a stream,
// runQuietCommand must release the temp directory it created, must not spawn
// the child, and must propagate the original initialization error.
// #9173's asynchronous sink-error cleanup path must keep working.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { runQuietCommand } from '../scripts/run-quiet-command.mjs';

function captureSink() {
  let value = '';
  return { stream: { write(chunk) { value += String(chunk); } }, text: () => value };
}

test('#9224 cleans up and does not spawn when the log stream factory throws synchronously', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hex-issue-9224-'));
  try {
    const failure = Object.assign(new Error('EMFILE: too many open files'), { code: 'EMFILE' });
    let spawnCalled = false;
    await assert.rejects(
      () => runQuietCommand({
        label: 'sync-init-failure',
        command: process.execPath,
        args: ['-e', 'process.exit(0)'],
        tempRoot,
        createLogStream() { throw failure; },
        spawnImpl() { spawnCalled = true; throw new Error('child must not spawn after init failure'); },
        stdout: captureSink().stream,
        stderr: captureSink().stream,
      }),
      (error) => error === failure,
    );
    assert.equal(spawnCalled, false, 'a synchronous log factory failure must not spawn the child');
    assert.deepEqual(fs.readdirSync(tempRoot), [], 'the run-owned temp directory must be removed');
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('#9224 preserves the initialization error when cleanup itself fails', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hex-issue-9224-cleanup-'));
  const originalRmSync = fs.rmSync;
  try {
    const failure = Object.assign(new Error('ENFILE: file table overflow'), { code: 'ENFILE' });
    fs.rmSync = () => { throw new Error('cleanup failed'); };
    await assert.rejects(
      () => runQuietCommand({
        label: 'cleanup-failure',
        command: process.execPath,
        args: ['-e', 'process.exit(0)'],
        tempRoot,
        createLogStream() { throw failure; },
        stdout: captureSink().stream,
        stderr: captureSink().stream,
      }),
      (error) => error === failure,
    );
  } finally {
    fs.rmSync = originalRmSync;
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('#9224 still cleans up on success and on the asynchronous sink-error path', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hex-issue-9224-regression-'));
  try {
    const success = await runQuietCommand({
      label: 'success',
      command: process.execPath,
      args: ['-e', 'process.exit(0)'],
      tempRoot,
      stdout: captureSink().stream,
      stderr: captureSink().stream,
    });
    assert.equal(success.ok, true);
    assert.equal(success.logPath, null);
    assert.deepEqual(fs.readdirSync(tempRoot), [], 'success path must remove the temp directory');

    const originalCreateWriteStream = fs.createWriteStream;
    const streamError = Object.assign(new Error('EIO: i/o error'), { code: 'EIO' });
    fs.createWriteStream = (filePath, opts) => {
      const stream = originalCreateWriteStream(filePath, opts);
      queueMicrotask(() => stream.emit('error', streamError));
      return stream;
    };
    try {
      await assert.rejects(
        () => runQuietCommand({
          label: 'async-sink-error',
          command: process.execPath,
          args: ['-e', 'process.exit(0)'],
          tempRoot,
          stdout: captureSink().stream,
          stderr: captureSink().stream,
        }),
        (error) => error === streamError,
      );
    } finally {
      fs.createWriteStream = originalCreateWriteStream;
    }
    assert.deepEqual(fs.readdirSync(tempRoot), [], 'asynchronous sink error must still remove the temp directory');
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
