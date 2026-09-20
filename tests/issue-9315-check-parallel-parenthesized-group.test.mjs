import assert from 'node:assert/strict';
import test from 'node:test';

import { parseCheckSteps, runCheckParallel } from '../scripts/run-check-parallel.mjs';

function sink() { return { write() {} }; }

test('#9315 parenthesized group keeps internal && inside one canonical step', () => {
  assert.deepEqual(parseCheckSteps('(printf a && printf b) && npm test'), [
    '(printf a && printf b)',
    'npm test',
  ]);
  assert.deepEqual(parseCheckSteps('((printf a && printf b) && printf c) && npm test'), [
    '((printf a && printf b) && printf c)',
    'npm test',
  ]);
});

test('#9315 unmatched grouping fails closed', () => {
  assert.throws(() => parseCheckSteps('(printf a && printf b && npm test'), /unclosed parenthesized group/);
  assert.throws(() => parseCheckSteps('printf a) && npm test'), /unmatched closing parenthesis/);
});

test('#9315 runCheckParallel executes a grouped operand as one shell job', async () => {
  const result = await runCheckParallel({
    checkScript:'(true && true) && true',
    stdout:sink(), stderr:sink(),
  });
  assert.equal(result.results.length, 2);
  assert.equal(result.failures.length, 0);
});

test('#9315 plain top-level conjunctions still split normally', () => {
  assert.deepEqual(parseCheckSteps('npm run a && npm run b && npm run c'), ['npm run a', 'npm run b', 'npm run c']);
});
