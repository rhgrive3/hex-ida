import assert from 'node:assert/strict';
import test from 'node:test';

import { parseCheckSteps, runCheckParallel } from '../scripts/run-check-parallel.mjs';

function sink() {
  return { write() {} };
}

test('#9270 unquoted command substitutions keep internal && inside the canonical step', () => {
  const script = 'node tool.mjs $(printf x && printf y) && npm test';
  assert.deepEqual(parseCheckSteps(script), [
    'node tool.mjs $(printf x && printf y)',
    'npm test',
  ]);
});

test('#9270 nested command substitutions do not create extra jobs', () => {
  const script = 'node tool.mjs $(printf x && printf $(printf y && printf z)) && npm test';
  assert.deepEqual(parseCheckSteps(script), [
    'node tool.mjs $(printf x && printf $(printf y && printf z))',
    'npm test',
  ]);
});

test('#9270 malformed command substitutions fail closed', () => {
  assert.throws(
    () => parseCheckSteps('node tool.mjs $(printf x && printf y && npm test'),
    /malformed shell syntax/,
  );
});

test('#9270 runCheckParallel executes substitution through one shell job', async () => {
  const script = [
    `node -e "if (process.argv[1] !== 'xy') process.exit(7)" $(printf x && printf y)`,
    `node -e "process.exit(0)"`,
  ].join(' && ');
  const result = await runCheckParallel({ checkScript: script, stdout: sink(), stderr: sink() });
  assert.equal(result.results.length, 2);
  assert.equal(result.failures.length, 0);
  assert.equal(result.results.every((entry) => entry?.ok === true), true);
});
