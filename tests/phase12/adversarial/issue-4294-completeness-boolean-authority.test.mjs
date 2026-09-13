// Regression for #4294: completenessOf() must treat `complete` as a primitive
// boolean authority. Non-boolean values and envelopes whose own counts
// contradict a claimed-complete result fail closed.
import assert from 'node:assert/strict';
import { completenessOf } from '../../../js/ai/tools/projections/index.js';

{
  const envelope = completenessOf({ results: [{ id: 1 }], returned: 1, total: 2, complete: 'false' });
  assert.equal(envelope.complete, false);
  assert.equal(envelope.reason, 'malformed-completeness');
  for (const bad of ['true', 'yes', 1, 0]) {
    assert.equal(completenessOf({ results: [{ id: 1 }], complete: bad }).complete, false);
  }
}

{
  for (const bad of [[], ['false'], {}, { value: false }]) {
    const envelope = completenessOf({ results: [{ id: 1 }], returned: 1, total: 2, complete: bad });
    assert.equal(envelope.complete, false);
    assert.equal(envelope.reason, 'malformed-completeness');
  }
  const nested = completenessOf({ results: [{ id: 1 }], completeness: { complete: 'false', returned: 1, total: 2 } });
  assert.equal(nested.complete, false);
  assert.equal(nested.reason, 'malformed-completeness');
}

{
  const full = completenessOf({ results: [{ id: 1 }], returned: 1, total: 1, complete: true });
  assert.deepEqual(full, { complete: true, returned: 1, total: 1, coverage: 1, reason: null });
  const partial = completenessOf({ results: [{ id: 1 }], returned: 1, total: 2, complete: false });
  assert.deepEqual(partial, { complete: false, returned: 1, total: 2, coverage: 0.5, reason: 'result-limit' });
}

{
  const inferred = completenessOf({ results: [{ id: 1 }], returned: 1, total: 2 });
  assert.equal(inferred.complete, false);
  assert.equal(inferred.coverage, 0.5);
  const rowMismatch = completenessOf({ results: [{ id: 1 }], total: 2 });
  assert.equal(rowMismatch.complete, false);
  const contradicted = completenessOf({ results: [{ id: 1 }], returned: 1, total: 2, complete: true });
  assert.equal(contradicted.complete, false);
  assert.equal(contradicted.reason, 'malformed-completeness');
  const truncatedFlag = completenessOf({ results: [{ id: 1 }], returned: 1, truncated: true });
  assert.equal(truncatedFlag.complete, false);
}

{
  const explicit = completenessOf({ results: [{ id: 1 }], completeness: { complete: true, returned: 1, total: 1, coverage: 1 } });
  assert.deepEqual(explicit, { complete: true, returned: 1, total: 1, coverage: 1, reason: null });
  const continued = completenessOf({ results: [{ id: 1 }], returned: 1, total: 2, complete: false, reason: 'cursor-pending' });
  assert.deepEqual(continued, { complete: false, returned: 1, total: 2, coverage: 0.5, reason: 'cursor-pending' });
  const uncounted = completenessOf({ results: [{ id: 1 }, { id: 2 }] });
  assert.deepEqual(uncounted, { complete: true, returned: 2, total: 2, coverage: 1, reason: null });
  const silent = completenessOf({ results: [] });
  assert.equal(silent.complete, true);
}

console.log('issue #4294 completeness boolean authority regressions PASS');

