import assert from 'node:assert/strict';
import test from 'node:test';

import { planAnalysisGoal } from '../js/query/planner.js';

const emptyQuery = Object.freeze({
  action: 'read',
  entity: Object.freeze({ terms: Object.freeze([]) }),
  context: Object.freeze({ terms: Object.freeze([]) }),
  event: Object.freeze({ terms: Object.freeze([]) }),
});

test('#3389 ignores a truthy non-callable cancellation option', async () => {
  const result = await planAnalysisGoal(emptyQuery, {}, {
    isCancelled: true,
    timeoutMs: 1_000,
    tools: {},
  });

  assert.ok(result && typeof result === 'object');
  assert.ok(!result.missingEvidence.includes('cancelled'),
    'a malformed non-callable value must not acquire cancellation authority');
});

test('#3389 preserves callable cancellation authority', async () => {
  const result = await planAnalysisGoal(emptyQuery, {}, {
    isCancelled: () => true,
    timeoutMs: 1_000,
    tools: {},
  });

  assert.ok(result.missingEvidence.includes('cancelled'));
  assert.equal(result.exhausted, true);
});
