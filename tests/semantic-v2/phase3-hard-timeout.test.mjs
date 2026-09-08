import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { runPhase3Corpus } from '../support/phase3-corpus-runner.mjs';

test('Phase 3 hard timeout settles after one grace period even with stubborn descendants', { timeout: 5_000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hex-phase3-hard-timeout-'));
  try {
    const readinessSignal = 'PHASE3_STUBBORN_READY\n';
    const descendantReadinessSignal = 'PHASE3_DESCENDANT_READY\n';
    const stubborn = `
      process.on('SIGTERM', () => {});
      process.stdout.write(${JSON.stringify(descendantReadinessSignal)});
      setInterval(() => {}, 1000);
    `;
    fs.writeFileSync(path.join(root, 'stubborn.mjs'), `
      import { spawn } from 'node:child_process';
      process.on('SIGTERM', () => {});
      const stubborn = ${JSON.stringify(stubborn)};
      const descendants = [
        spawn(process.execPath, ['-e', stubborn], { stdio: ['ignore', 'pipe', 'ignore'] }),
        spawn(process.execPath, ['-e', stubborn], { stdio: ['ignore', 'pipe', 'ignore'] }),
      ];
      await Promise.all(descendants.map((child) => new Promise((resolve) => child.stdout.once('data', resolve))));
      process.stdout.write(${JSON.stringify(readinessSignal)});
      setInterval(() => {}, 1000);
    `);

    const timeoutMs = 100;
    const killGraceMs = 150;
    const started = process.hrtime.bigint();
    const { results, concurrency } = await runPhase3Corpus({
      suite: 'hard-timeout-contract',
      files: ['stubborn.mjs'],
      root,
      env: { ...process.env, HEX_PHASE3_CORPUS_CONCURRENCY: '1' },
      timeoutMs,
      killGraceMs,
      readinessSignal,
      readinessTimeoutMs: 2_000,
      availableParallelism: 1,
    });
    const wallMs = Number(process.hrtime.bigint() - started) / 1e6;

    assert.equal(concurrency, 1);
    assert.equal(results.length, 1);
    assert.equal(results[0].passed, false);
    assert.equal(results[0].timedOut, true);
    assert.equal(results[0].signal, 'SIGKILL');
    assert.match(results[0].error || '', /timed out/);
    assert.ok(
      wallMs < 1_500,
      `timeout settlement must remain bounded by one global grace period; observed ${wallMs.toFixed(1)}ms`,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Phase 3 readiness timeout kills stubborn descendants when the marker is absent', { timeout: 5_000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hex-phase3-readiness-timeout-'));
  const pidFile = path.join(root, 'descendant-pids.txt');
  try {
    fs.writeFileSync(path.join(root, 'never-ready.mjs'), `
      import { spawn } from 'node:child_process';
      import fs from 'node:fs';
      process.on('SIGTERM', () => {});
      const stubborn = "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);";
      const descendants = [
        spawn(process.execPath, ['-e', stubborn], { stdio: 'ignore' }),
        spawn(process.execPath, ['-e', stubborn], { stdio: 'ignore' }),
      ];
      fs.writeFileSync(process.env.PHASE3_DESCENDANT_PID_FILE, descendants.map((child) => child.pid).join('\\n'));
      setInterval(() => {}, 1000);
    `);

    const started = process.hrtime.bigint();
    const { results, concurrency } = await runPhase3Corpus({
      suite: 'readiness-timeout-contract',
      files: ['never-ready.mjs'],
      root,
      env: {
        ...process.env,
        HEX_PHASE3_CORPUS_CONCURRENCY: '1',
        PHASE3_DESCENDANT_PID_FILE: pidFile,
      },
      timeoutMs: 100,
      killGraceMs: 150,
      readinessSignal: 'PHASE3_NEVER_EMITTED_READY\n',
      readinessTimeoutMs: 1_000,
      availableParallelism: 1,
    });
    const wallMs = Number(process.hrtime.bigint() - started) / 1e6;

    assert.equal(concurrency, 1);
    assert.equal(results.length, 1);
    assert.equal(results[0].passed, false);
    assert.equal(results[0].timedOut, true);
    assert.equal(results[0].readinessTimedOut, true);
    assert.equal(results[0].signal, 'SIGKILL');
    assert.match(results[0].error || '', /readiness timed out/);
    assert.ok(
      wallMs < 2_500,
      `readiness timeout settlement must remain bounded; observed ${wallMs.toFixed(1)}ms`,
    );

    const descendantPids = fs.readFileSync(pidFile, 'utf8').trim().split(/\s+/).filter(Boolean).map(Number);
    assert.equal(descendantPids.length, 2);
    const deadline = Date.now() + 1_000;
    let lingering = descendantPids;
    while (lingering.length && Date.now() < deadline) {
      lingering = descendantPids.filter((pid) => {
        try {
          process.kill(pid, 0);
          return true;
        } catch (error) {
          return error?.code !== 'ESRCH';
        }
      });
      if (lingering.length) await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.deepEqual(lingering, [], 'readiness cleanup must remove stubborn descendants');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
