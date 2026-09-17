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

function mockChild({ code = 0, signal = null, error = null, stdoutChunks = [], stderrChunks = [] } = {}) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  queueMicrotask(() => {
    for (const chunk of stdoutChunks) child.stdout.emit('data', Buffer.from(chunk));
    for (const chunk of stderrChunks) child.stderr.emit('data', Buffer.from(chunk));
    if (error) child.emit('error', error);
    else child.emit('close', code, signal);
  });
  return child;
}

test('#9173 cleans up temporary directory when log stream encounters I/O failure (ENOSPC / EIO)', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hex-issue-9173-'));

  try {
    // 1. Child exits 0, log stream encounters ENOSPC: error is propagated, temp dir cleaned up
    {
      const originalCreateWriteStream = fs.createWriteStream;
      const enospcError = Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
      fs.createWriteStream = (filePath, opts) => {
        const stream = originalCreateWriteStream(filePath, opts);
        queueMicrotask(() => {
          stream.emit('error', enospcError);
        });
        return stream;
      };

      try {
        await assert.rejects(
          () => runQuietCommand({
            label: 'test-enospc',
            command: 'echo',
            args: ['hello'],
            spawnImpl: () => mockChild({ code: 0 }),
            stdout: captureSink().stream,
            stderr: captureSink().stream,
            tempRoot,
          }),
          (err) => err === enospcError,
        );
      } finally {
        fs.createWriteStream = originalCreateWriteStream;
      }
      assert.deepEqual(fs.readdirSync(tempRoot), [], 'temp directory must be cleaned up after ENOSPC');
    }

    // 2. Child exits non-zero, log stream encounters EIO: error is propagated, partial log dir cleaned up
    {
      const originalCreateWriteStream = fs.createWriteStream;
      const eioError = Object.assign(new Error('EIO: i/o error'), { code: 'EIO' });
      fs.createWriteStream = (filePath, opts) => {
        const stream = originalCreateWriteStream(filePath, opts);
        queueMicrotask(() => {
          stream.emit('error', eioError);
        });
        return stream;
      };

      try {
        await assert.rejects(
          () => runQuietCommand({
            label: 'test-eio',
            command: 'false',
            spawnImpl: () => mockChild({ code: 1 }),
            stdout: captureSink().stream,
            stderr: captureSink().stream,
            tempRoot,
          }),
          (err) => err === eioError,
        );
      } finally {
        fs.createWriteStream = originalCreateWriteStream;
      }
      assert.deepEqual(fs.readdirSync(tempRoot), [], 'temp directory must be cleaned up after EIO');
    }

    // 3. Child exits 0 and log normal: temp directory is cleaned up
    {
      const result = await runQuietCommand({
        label: 'test-success',
        command: 'echo',
        args: ['ok'],
        spawnImpl: () => mockChild({ code: 0, stdoutChunks: ['ok\n'] }),
        stdout: captureSink().stream,
        stderr: captureSink().stream,
        tempRoot,
      });
      assert.equal(result.ok, true);
      assert.equal(result.status, 0);
      assert.equal(result.logPath, null);
      assert.deepEqual(fs.readdirSync(tempRoot), [], 'temp directory must be cleaned up on success');
    }

    // 4. Child exits non-zero and log normal: temp directory and full.log are retained for diagnosis
    {
      const result = await runQuietCommand({
        label: 'test-nonzero',
        command: 'false',
        spawnImpl: () => mockChild({ code: 1, stderrChunks: ['failure reason\n'] }),
        stdout: captureSink().stream,
        stderr: captureSink().stream,
        tempRoot,
      });
      assert.equal(result.ok, false);
      assert.equal(result.status, 1);
      assert.ok(result.logPath, 'logPath must be present');
      assert.ok(fs.existsSync(result.logPath), 'full.log must be retained on normal command failure');
      // Clean up the retained diagnostic log
      fs.rmSync(path.dirname(result.logPath), { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
