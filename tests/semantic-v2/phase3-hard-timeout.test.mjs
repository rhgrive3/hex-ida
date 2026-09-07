import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { runPhase3Corpus } from '../support/phase3-corpus-runner.mjs';

test('Phase 3 hard timeout settles after one grace period even with stubborn descendants', { timeout: 5_000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hex-phase3-hard-timeout-'));
  try {
    fs.writeFileSync(path.join(root, 'stubborn.mjs'), `
      import { spawn } from 'node:child_process';
      const stubborn = "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);";
      spawn(process.execPath, ['-e', stubborn], { stdio: 'ignore' });
      spawn(process.execPath, ['-e', stubborn], { stdio: 'ignore' });
      process.on('SIGTERM', () => {});
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
