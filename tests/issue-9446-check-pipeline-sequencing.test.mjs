import assert from 'node:assert/strict';
import test from 'node:test';

import { parseCheckSteps, runCheckParallel } from '../scripts/run-check-parallel.mjs';

function sink() {
  return { write() {} };
}

test('#9446 preserves top-level pipeline with && successor as one shell job', () => {
  assert.deepEqual(
    parseCheckSteps('producer | consumer && successor'),
    ['producer | consumer && successor'],
  );
  assert.deepEqual(
    parseCheckSteps('a | b | c && d'),
    ['a | b | c && d'],
  );
});

test('#9446 does not misclassify quoted or nested pipes', () => {
  assert.deepEqual(
    parseCheckSteps("echo 'a | b' && successor"),
    ["echo 'a | b'", 'successor'],
  );
  assert.deepEqual(
    parseCheckSteps('echo "a | b" && successor'),
    ['echo "a | b"', 'successor'],
  );
  assert.deepEqual(
    parseCheckSteps('(a | b) && successor'),
    ['(a | b)', 'successor'],
  );
});

test('#9446 orchestration cannot detach pipeline successor', async () => {
  const seen = [];
  const result = await runCheckParallel({
    checkScript: 'producer | consumer && successor',
    stdout: sink(),
    stderr: sink(),
    async runCommand({ rawCommand }) {
      seen.push(rawCommand);
      return { ok: false, status: 1, signal: null, error: null, logPath: null, durationMs: 0 };
    },
  });

  assert.deepEqual(seen, ['producer | consumer && successor']);
  assert.equal(result.failures.length, 1);
});

test('#9446 keeps pure && chains parallelizable and || on serial fallback', () => {
  assert.deepEqual(parseCheckSteps('a && b && c'), ['a', 'b', 'c']);
  assert.deepEqual(parseCheckSteps('a || b && c'), ['a || b && c']);
});
