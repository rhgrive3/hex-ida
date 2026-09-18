import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable, Writable } from 'node:stream';
import test from 'node:test';
import { runQuietCommand } from '../scripts/run-quiet-command.mjs';

function captureSink() {
  let value = '';
  return {
    stream: { write(chunk) { value += String(chunk); } },
    text: () => value,
  };
}

class MockReadable extends Readable {
  constructor() {
    super();
    this.pauseCalls = 0;
    this.resumeCalls = 0;
  }

  _read() {}

  pause() {
    this.pauseCalls++;
    return super.pause();
  }

  resume() {
    this.resumeCalls++;
    return super.resume();
  }
}

class ControllableWritable extends Writable {
  constructor({ shouldAccept = () => true } = {}) {
    super();
    this.shouldAccept = shouldAccept;
    this.writtenChunks = [];
  }

  _write(chunk, encoding, callback) {
    this.writtenChunks.push(chunk);
    callback();
  }

  write(chunk, encoding, cb) {
    const accepted = this.shouldAccept(chunk);
    super.write(chunk, encoding, cb);
    return accepted;
  }
}

test('#9208 pauses child stdout/stderr on log backpressure and resumes on drain', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hex-issue-9208-'));

  try {
    const stdout = new MockReadable();
    const stderr = new MockReadable();
    const child = new EventEmitter();
    child.stdout = stdout;
    child.stderr = stderr;
    child.exitCode = null;
    child.signalCode = null;
    child.kill = () => {
      child.emit('close', 0, null);
    };

    let acceptWrites = true;
    let logStream;

    const commandPromise = runQuietCommand({
      label: 'test-backpressure',
      command: 'echo',
      spawnImpl: () => child,
      stdout: captureSink().stream,
      stderr: captureSink().stream,
      tempRoot,
      createLogStream: (filePath) => {
        logStream = new ControllableWritable({
          shouldAccept: () => acceptWrites,
        });
        // ensure close event is emitted when finished
        logStream.on('finish', () => logStream.emit('close'));
        return logStream;
      },
    });

    // 1. Initial write accepted
    stdout.push('first line\n');
    await new Promise((r) => setImmediate(r));
    assert.equal(stdout.isPaused(), false);
    assert.equal(stdout.pauseCalls, 0);

    // 2. Saturate the sink
    acceptWrites = false;
    stdout.push('second line\n');
    await new Promise((r) => setImmediate(r));

    // Backpressure triggered: stdout and stderr must both be paused
    assert.equal(stdout.isPaused(), true, 'stdout must be paused when sink returns false');
    assert.equal(stderr.isPaused(), true, 'stderr must be paused when shared sink returns false');
    assert.equal(stdout.pauseCalls >= 1, true);
    assert.equal(stderr.pauseCalls >= 1, true);

    // 3. Additional data while paused stays buffered in readable, not forwarded to sink
    const writesBefore = logStream.writtenChunks.length;
    stdout.push('third line (buffered)\n');
    await new Promise((r) => setImmediate(r));
    assert.equal(logStream.writtenChunks.length, writesBefore, 'chunks must not be forwarded while paused');

    // 4. Drain the sink
    acceptWrites = true;
    logStream.emit('drain');
    await new Promise((r) => setImmediate(r));

    // Both streams must resume
    assert.equal(stdout.isPaused(), false, 'stdout must resume on drain');
    assert.equal(stderr.isPaused(), false, 'stderr must resume on drain');
    assert.equal(stdout.resumeCalls >= 1, true);

    // Now the buffered chunk is forwarded
    assert.equal(logStream.writtenChunks.length, writesBefore + 1);

    // Close child and finish command
    stdout.push(null);
    stderr.push(null);
    child.emit('close', 0, null);

    const result = await commandPromise;
    assert.equal(result.ok, true);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('#9208 interleaved stdout and stderr coordinate shared sink backpressure', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hex-issue-9208-'));

  try {
    const stdout = new MockReadable();
    const stderr = new MockReadable();
    const child = new EventEmitter();
    child.stdout = stdout;
    child.stderr = stderr;
    child.exitCode = null;
    child.signalCode = null;
    child.kill = () => { child.emit('close', 0, null); };

    let acceptWrites = true;
    let logStream;

    const commandPromise = runQuietCommand({
      label: 'test-interleaved',
      command: 'echo',
      spawnImpl: () => child,
      stdout: captureSink().stream,
      stderr: captureSink().stream,
      tempRoot,
      createLogStream: () => {
        logStream = new ControllableWritable({ shouldAccept: () => acceptWrites });
        logStream.on('finish', () => logStream.emit('close'));
        return logStream;
      },
    });

    // Stderr triggers backpressure
    acceptWrites = false;
    stderr.push('stderr error chunk\n');
    await new Promise((r) => setImmediate(r));

    assert.equal(stderr.isPaused(), true, 'stderr should be paused');
    assert.equal(stdout.isPaused(), true, 'stdout should also be paused when stderr saturates shared sink');

    // Drain
    acceptWrites = true;
    logStream.emit('drain');
    await new Promise((r) => setImmediate(r));

    assert.equal(stderr.isPaused(), false, 'stderr should resume');
    assert.equal(stdout.isPaused(), false, 'stdout should resume');

    stdout.push(null);
    stderr.push(null);
    child.emit('close', 0, null);

    const result = await commandPromise;
    assert.equal(result.ok, true);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('#9208 sink error does not deadlock paused child sources', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hex-issue-9208-'));

  try {
    const stdout = new MockReadable();
    const stderr = new MockReadable();
    const child = new EventEmitter();
    child.stdout = stdout;
    child.stderr = stderr;
    child.exitCode = null;
    child.signalCode = null;
    let killed = false;
    child.kill = () => {
      killed = true;
      child.emit('close', null, 'SIGTERM');
    };

    let logStream;
    const sinkError = new Error('EIO: i/o error on log sink');

    const commandPromise = runQuietCommand({
      label: 'test-sink-error',
      command: 'echo',
      spawnImpl: () => child,
      stdout: captureSink().stream,
      stderr: captureSink().stream,
      tempRoot,
      createLogStream: () => {
        logStream = new ControllableWritable({ shouldAccept: () => false });
        logStream.on('finish', () => logStream.emit('close'));
        return logStream;
      },
    });

    // Saturate and pause
    stdout.push('chunk\n');
    await new Promise((r) => setImmediate(r));
    assert.equal(stdout.isPaused(), true);

    const rejectPromise = assert.rejects(commandPromise, (err) => err === sinkError);

    // Error on log sink
    logStream.emit('error', sinkError);
    await new Promise((r) => setImmediate(r));

    assert.equal(killed, true, 'child must be killed on sink error to prevent deadlock');
    await rejectPromise;
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('#9208 quiet runner completes real high-volume child process without error', async () => {
  const stdout = captureSink();
  const stderr = captureSink();
  const result = await runQuietCommand({
    label: 'real-high-volume',
    command: process.execPath,
    args: ['-e', 'for (let i = 0; i < 5000; i++) { console.log("line " + i); console.error("err " + i); }'],
    stdout: stdout.stream,
    stderr: stderr.stream,
  });

  assert.equal(result.ok, true);
  assert.equal(result.status, 0);
  assert.match(stdout.text(), /real-high-volume: PASS/);
});

