import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';

import { runQuietCommand } from '../scripts/run-quiet-command.mjs';

function captureSink() {
  let value = '';
  return {
    stream: { write(chunk) { value += String(chunk); } },
    text: () => value,
  };
}

function fakeLiveChild(onReady) {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.pid = undefined;
  child.exitCode = null;
  child.signalCode = null;
  child.kills = [];
  child.kill = (signal) => {
    child.kills.push(signal);
    queueMicrotask(() => {
      if (child.exitCode != null || child.signalCode != null) return;
      child.signalCode = signal;
      child.emit('close', null, signal);
      child.stdout.destroy();
      child.stderr.destroy();
    });
    return true;
  };
  queueMicrotask(() => onReady(child));
  return child;
}

for (const pipeName of ['stdout', 'stderr']) {
  test(`quiet runner contains ${pipeName} pipe EIO and terminates the live child`, async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), `quiet-9439-${pipeName}-`));
    const stderr = captureSink();
    const pipeError = Object.assign(new Error(`${pipeName} read failed`), { code: 'EIO' });
    let child;
    try {
      const result = await runQuietCommand({
        label: `pipe-${pipeName}`,
        command: 'fake',
        tempRoot,
        stderr: stderr.stream,
        stdout: captureSink().stream,
        terminationGraceMs: 0,
        forceSettleMs: 0,
        spawnImpl: () => {
          child = fakeLiveChild((spawned) => spawned[pipeName].emit('error', pipeError));
          return child;
        },
      });

      assert.equal(result.ok, false);
      assert.equal(result.error, pipeError);
      assert.equal(result.logPath, null);
      assert.ok(child.kills.includes('SIGTERM'));
      assert.match(stderr.text(), /FAIL \(pipe error: EIO,/);
      assert.match(stderr.text(), /Pipe failure log cleaned after diagnostic capture/);
      assert.deepEqual(fs.readdirSync(tempRoot), []);
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });
}

test('pipe error racing with child close settles once and preserves the pipe error', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'quiet-9439-close-race-'));
  const pipeError = Object.assign(new Error('stdout race failure'), { code: 'EIO' });
  try {
    const result = await runQuietCommand({
      label: 'pipe-close-race',
      command: 'fake',
      tempRoot,
      stderr: captureSink().stream,
      stdout: captureSink().stream,
      terminationGraceMs: 0,
      forceSettleMs: 0,
      spawnImpl: () => fakeLiveChild((child) => {
        child.stdout.emit('error', pipeError);
        child.exitCode = 1;
        child.emit('close', 1, null);
      }),
    });
    assert.equal(result.ok, false);
    assert.equal(result.error, pipeError);
    assert.deepEqual(fs.readdirSync(tempRoot), []);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('first pipe error remains primary when the log stream errors immediately after it', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'quiet-9439-log-race-'));
  const pipeError = Object.assign(new Error('stdout first'), { code: 'EIO' });
  const logError = Object.assign(new Error('log second'), { code: 'ENOSPC' });
  let logStream;
  try {
    const result = await runQuietCommand({
      label: 'pipe-log-race',
      command: 'fake',
      tempRoot,
      stderr: captureSink().stream,
      stdout: captureSink().stream,
      terminationGraceMs: 0,
      forceSettleMs: 0,
      createLogStream(filePath) {
        logStream = fs.createWriteStream(filePath, { flags: 'wx', mode: 0o600 });
        return logStream;
      },
      spawnImpl: () => fakeLiveChild((child) => {
        child.stdout.emit('error', pipeError);
        logStream.emit('error', logError);
      }),
    });
    assert.equal(result.ok, false);
    assert.equal(result.error, pipeError);
    assert.deepEqual(fs.readdirSync(tempRoot), []);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('multiple owned-pipe errors are handled and the first failure remains deterministic', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'quiet-9439-multiple-'));
  const first = Object.assign(new Error('stdout first'), { code: 'EIO' });
  const second = Object.assign(new Error('stderr second'), { code: 'EPIPE' });
  try {
    const result = await runQuietCommand({
      label: 'multiple-pipe-errors',
      command: 'fake',
      tempRoot,
      stderr: captureSink().stream,
      stdout: captureSink().stream,
      terminationGraceMs: 0,
      forceSettleMs: 0,
      spawnImpl: () => fakeLiveChild((child) => {
        child.stdout.emit('error', first);
        child.stderr.emit('error', second);
      }),
    });
    assert.equal(result.ok, false);
    assert.equal(result.error, first);
    assert.deepEqual(fs.readdirSync(tempRoot), []);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
