import assert from 'node:assert/strict';
import test from 'node:test';

import { parseCheckSteps, runCheckParallel } from '../scripts/run-check-parallel.mjs';

function sink() { return { write() {} }; }

test('#9451 preserves top-level background list with && successor as one shell job', () => {
  assert.deepEqual(
    parseCheckSteps('helper & prerequisite && successor'),
    ['helper & prerequisite && successor'],
  );
  assert.deepEqual(
    parseCheckSteps('helper & prerequisite && successor && tail'),
    ['helper & prerequisite && successor && tail'],
  );
});

test('#9451 does not misclassify quoted, nested, or redirection ampersands', () => {
  assert.deepEqual(
    parseCheckSteps("echo 'a & b' && successor"),
    ["echo 'a & b'", 'successor'],
  );
  assert.deepEqual(
    parseCheckSteps('echo "a & b" && successor'),
    ['echo "a & b"', 'successor'],
  );
  assert.deepEqual(
    parseCheckSteps('(a & b) && successor'),
    ['(a & b)', 'successor'],
  );
  assert.deepEqual(
    parseCheckSteps('printf x >&2 && successor'),
    ['printf x >&2', 'successor'],
  );
});

test('#9451 orchestration cannot detach successor from background-list shell semantics', async () => {
  const seen = [];
  const result = await runCheckParallel({
    checkScript: 'helper & prerequisite && successor',
    stdout: sink(),
    stderr: sink(),
    async runCommand({ rawCommand }) {
      seen.push(rawCommand);
      return { ok: false, status: 1, signal: null, error: null, logPath: null, durationMs: 0 };
    },
  });
  assert.deepEqual(seen, ['helper & prerequisite && successor']);
  assert.equal(result.failures.length, 1);
});

test('#9451 keeps pure && chains parallelizable', () => {
  assert.deepEqual(parseCheckSteps('a && b && c'), ['a', 'b', 'c']);
});
