import assert from 'node:assert/strict';
import test from 'node:test';

import { parseCheckSteps, runCheckParallel } from '../scripts/run-check-parallel.mjs';

function sink() { return { write() {} }; }

test('#9453 preserves top-level semicolon list with && successor as one shell job', () => {
  assert.deepEqual(
    parseCheckSteps('setup; prerequisite && successor'),
    ['setup; prerequisite && successor'],
  );
  assert.deepEqual(
    parseCheckSteps('a; b; c && d'),
    ['a; b; c && d'],
  );
});

test('#9453 does not misclassify quoted or nested semicolons', () => {
  assert.deepEqual(
    parseCheckSteps("echo 'a; b' && successor"),
    ["echo 'a; b'", 'successor'],
  );
  assert.deepEqual(
    parseCheckSteps('echo "a; b" && successor'),
    ['echo "a; b"', 'successor'],
  );
  assert.deepEqual(
    parseCheckSteps('(a; b) && successor'),
    ['(a; b)', 'successor'],
  );
});

test('#9453 orchestration cannot detach successor from semicolon-list shell semantics', async () => {
  const seen = [];
  const result = await runCheckParallel({
    checkScript: 'setup; prerequisite && successor',
    stdout: sink(),
    stderr: sink(),
    async runCommand({ rawCommand }) {
      seen.push(rawCommand);
      return { ok: false, status: 1, signal: null, error: null, logPath: null, durationMs: 0 };
    },
  });

  assert.deepEqual(seen, ['setup; prerequisite && successor']);
  assert.equal(result.failures.length, 1);
});

test('#9453 keeps pure && chains parallelizable', () => {
  assert.deepEqual(parseCheckSteps('a && b && c'), ['a', 'b', 'c']);
});
