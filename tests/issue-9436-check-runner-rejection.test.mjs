import assert from 'node:assert/strict';
import test from 'node:test';

import { runCheckParallel } from '../scripts/run-check-parallel.mjs';

async function withPoolSize(size, fn) {
  const previous = process.env.HEX_CHECK_PARALLEL;
  process.env.HEX_CHECK_PARALLEL = String(size);
  try {
    return await fn();
  } finally {
    if (previous === undefined) delete process.env.HEX_CHECK_PARALLEL;
    else process.env.HEX_CHECK_PARALLEL = previous;
  }
}

function sink() {
  return { write() {} };
}

test('runner rejection does not stop later canonical checks at concurrency 1', async () => {
  await withPoolSize(1, async () => {
    const seen = [];
    const rejection = new Error('synthetic runner failure');
    const result = await runCheckParallel({
      checkScript: 'npm run first && npm run second && npm run third',
      stdout: sink(),
      stderr: sink(),
      async runCommand({ rawCommand }) {
        seen.push(rawCommand);
        if (rawCommand === 'npm run first') throw rejection;
        return { ok: true, status: 0, signal: null, logPath: null, durationMs: 0 };
      },
    });

    assert.deepEqual(seen, ['npm run first', 'npm run second', 'npm run third']);
    assert.equal(result.failures.length, 1);
    assert.equal(result.failures[0].job.rawCommand, 'npm run first');
    assert.equal(result.failures[0].result.error, rejection);
    assert.equal(result.results[1].ok, true);
    assert.equal(result.results[2].ok, true);
  });
});

test('runner rejection does not leave jobs unclaimed with multiple workers', async () => {
  await withPoolSize(2, async () => {
    const seen = [];
    const result = await runCheckParallel({
      checkScript: 'npm run first && npm run second && npm run third && npm run fourth',
      stdout: sink(),
      stderr: sink(),
      async runCommand({ rawCommand }) {
        seen.push(rawCommand);
        await Promise.resolve();
        if (rawCommand === 'npm run second') throw new Error('controlled rejection');
        return { ok: true, status: 0, signal: null, logPath: null, durationMs: 0 };
      },
    });

    assert.deepEqual([...seen].sort(), [
      'npm run first',
      'npm run fourth',
      'npm run second',
      'npm run third',
    ].sort());
    assert.equal(new Set(seen).size, 4);
    assert.equal(result.failures.length, 1);
    assert.equal(result.failures[0].job.rawCommand, 'npm run second');
  });
});

test('exclusive runner rejection is recorded and later checks still run', async () => {
  await withPoolSize(1, async () => {
    const seen = [];
    const result = await runCheckParallel({
      checkScript: 'npm run first && npm run phase7:test && npm run third',
      stdout: sink(),
      stderr: sink(),
      async runCommand({ rawCommand }) {
        seen.push(rawCommand);
        if (rawCommand === 'npm run phase7:test') throw new Error('exclusive rejection');
        return { ok: true, status: 0, signal: null, logPath: null, durationMs: 0 };
      },
    });

    assert.deepEqual(seen, ['npm run first', 'npm run phase7:test', 'npm run third']);
    assert.equal(result.failures.length, 1);
    assert.equal(result.failures[0].job.rawCommand, 'npm run phase7:test');
  });
});
