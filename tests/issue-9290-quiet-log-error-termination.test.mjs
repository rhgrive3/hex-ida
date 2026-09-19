import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { runQuietCommand } from '../scripts/run-quiet-command.mjs';

function captureSink() {
  return { write() {} };
}

class MockLog extends EventEmitter {
  write() { return true; }
  end() { queueMicrotask(() => this.emit('close')); }
}

function stubbornChild({ closeOn = 'SIGKILL' } = {}) {
  const child = new EventEmitter();
  child.exitCode = null;
  child.signalCode = null;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.signals = [];
  child.kill = (signal = 'SIGTERM') => {
    child.signals.push(signal);
    if (signal === closeOn) queueMicrotask(() => child.emit('close', null, signal));
    return true;
  };
  return child;
}

async function runSinkFailure({ child, tempRoot, sinkError }) {
  let log;
  const promise = runQuietCommand({
    label: 'issue-9290',
    command: 'ignored',
    spawnImpl: () => child,
    createLogStream: () => {
      log = new MockLog();
      return log;
    },
    stdout: captureSink(),
    stderr: captureSink(),
    tempRoot,
    terminationGraceMs: 5,
    forceSettleMs: 5,
  });
  queueMicrotask(() => log.emit('error', sinkError));
  return promise;
}

test('#9290 escalates a sink failure past a child that ignores SIGTERM', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hex-issue-9290-'));
  try {
    const sinkError = Object.assign(new Error('EIO: log sink failed'), { code: 'EIO' });
    const child = stubbornChild();
    await assert.rejects(
      () => runSinkFailure({ child, tempRoot, sinkError }),
      (error) => error === sinkError,
    );
    assert.deepEqual(child.signals, ['SIGTERM', 'SIGKILL']);
    assert.deepEqual(fs.readdirSync(tempRoot), [], 'sink failure must release the temporary log directory');
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('#9290 remains bounded even if the child never emits close after SIGKILL', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hex-issue-9290-hard-'));
  try {
    const sinkError = Object.assign(new Error('ENOSPC: log sink failed'), { code: 'ENOSPC' });
    const child = stubbornChild({ closeOn: 'never' });
    const started = Date.now();
    await assert.rejects(
      () => runSinkFailure({ child, tempRoot, sinkError }),
      (error) => error === sinkError,
    );
    assert.deepEqual(child.signals, ['SIGTERM', 'SIGKILL']);
    assert.ok(Date.now() - started < 250, 'runner must not depend on a hostile child close event');
    assert.deepEqual(fs.readdirSync(tempRoot), [], 'bounded fallback must still release the temp directory');
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('#9290 does not escalate when the child cooperates with SIGTERM', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hex-issue-9290-coop-'));
  try {
    const sinkError = Object.assign(new Error('EIO: log sink failed'), { code: 'EIO' });
    const child = stubbornChild({ closeOn: 'SIGTERM' });
    await assert.rejects(
      () => runSinkFailure({ child, tempRoot, sinkError }),
      (error) => error === sinkError,
    );
    assert.deepEqual(child.signals, ['SIGTERM']);
    assert.deepEqual(fs.readdirSync(tempRoot), []);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
