// Regression for #4294: completenessOf() must treat `complete` as a primitive
// boolean authority. Non-boolean values ('false', [], {}) and envelopes whose
// own counts contradict a claimed-complete result fail closed instead of being
// promoted to `complete: true` through truthiness.
import assert from 'node:assert/strict';
import { completenessOf } from '../js/ai/tools/projections/index.js';

// 1. A schema-violating string 'false' never becomes complete: true.
{
  const envelope = completenessOf({ results: [{ id: 1 }], returned: 1, total: 2, complete: 'false' });
  assert.equal(envelope.complete, false, "complete:'false' must not be promoted to true");
  assert.equal(envelope.reason, 'malformed-completeness');
  for (const bad of ['true', 'yes', 1, 0]) {
    assert.equal(completenessOf({ results: [{ id: 1 }], complete: bad }).complete, false, `${JSON.stringify(bad)} is not a boolean authority`);
  }
}

// 2. Structured values are never promoted to true.
{
  for (const bad of [[], ['false'], {}, { value: false }]) {
    const envelope = completenessOf({ results: [{ id: 1 }], returned: 1, total: 2, complete: bad });
    assert.equal(envelope.complete, false, 'structured complete values must fail closed');
    assert.equal(envelope.reason, 'malformed-completeness');
  }
  const nested = completenessOf({ results: [{ id: 1 }], completeness: { complete: 'false', returned: 1, total: 2 } });
  assert.equal(nested.complete, false, 'nested completeness is validated the same way');
  assert.equal(nested.reason, 'malformed-completeness');
}

// 3. Legitimate boolean authorities are preserved.
{
  const full = completenessOf({ results: [{ id: 1 }], returned: 1, total: 1, complete: true });
  assert.equal(full.complete, true);
  assert.equal(full.coverage, 1);
  assert.equal(full.reason, null);
  const partial = completenessOf({ results: [{ id: 1 }], returned: 1, total: 2, complete: false });
  assert.equal(partial.complete, false);
  assert.equal(partial.coverage, 0.5);
  assert.equal(partial.reason, 'result-limit');
}

// 4. A partial result never reports complete.
{
  const inferred = completenessOf({ results: [{ id: 1 }], returned: 1, total: 2 });
  assert.equal(inferred.complete, false, 'returned < total is a partial result even without a flag');
  assert.notEqual(inferred.reason, null, 'an incomplete envelope carries a reason');
  assert.equal(inferred.coverage, 0.5);

  const rowMismatch = completenessOf({ results: [{ id: 1 }], total: 2 });
  assert.equal(rowMismatch.complete, false, 'rows.length < total is a partial result');

  const contradicted = completenessOf({ results: [{ id: 1 }], returned: 1, total: 2, complete: true });
  assert.equal(contradicted.complete, false, 'a complete claim contradicting returned < total fails closed');
  assert.equal(contradicted.reason, 'malformed-completeness');

  const truncatedFlag = completenessOf({ results: [{ id: 1 }], returned: 1, truncated: true });
  assert.equal(truncatedFlag.complete, false, 'truncated results stay incomplete');
}

// 5. Healthy continuation / completeness envelopes are not broken.
{
  const explicit = completenessOf({ results: [{ id: 1 }], completeness: { complete: true, returned: 1, total: 1, coverage: 1 } });
  assert.deepEqual(explicit, { complete: true, returned: 1, total: 1, coverage: 1, reason: null });

  const continued = completenessOf({ results: [{ id: 1 }], returned: 1, total: 2, complete: false, reason: 'cursor-pending' });
  assert.deepEqual(continued, { complete: false, returned: 1, total: 2, coverage: 0.5, reason: 'cursor-pending' });

  const coverageOnly = completenessOf({ results: [{ id: 1 }], returned: 1, total: 2, coverage: 0.5 });
  assert.equal(coverageOnly.complete, false);
  assert.equal(coverageOnly.coverage, 0.5);

  const uncounted = completenessOf({ results: [{ id: 1 }, { id: 2 }] });
  assert.deepEqual(uncounted, { complete: true, returned: 2, total: 2, coverage: 1, reason: null });

  const silent = completenessOf({ results: [] });
  assert.equal(silent.complete, true, 'an exhausted empty result stays complete');
}

console.log('issue #4294 completeness boolean authority regressions PASS');
