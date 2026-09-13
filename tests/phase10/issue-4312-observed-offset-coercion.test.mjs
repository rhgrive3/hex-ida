import assert from 'node:assert/strict';
import { test } from 'node:test';

// #4312: observedFieldValue() matched runtime observation memory offsets with a
// bare BigInt(...) coercion, so a structured offset such as ['8'] aliased onto
// the canonical expected 8n. A schema-violating observation could therefore be
// reported as an observation of the expected field and, if the value lined up,
// yield a `supported` (or `contradicted`) verdict. Observation offsets must be
// canonical machine integers; malformed offsets must never produce the strong
// verdicts on their own.
import { compareExpected } from '../../js/dynamic/experiments.js';

const caseSpec = {
  expected: { field: { offset: 8n, value: 5n, bits: 64, signed: false } },
};

const MALFORMED_OFFSETS = [['8'], { valueOf: () => 8 }, true, 8.5, {}, ['8n']];

test('#4312 structured memoryAfter offset cannot produce supported', () => {
  for (const offset of MALFORMED_OFFSETS) {
    const result = compareExpected(caseSpec, {
      stop: { kind: 'return' },
      memoryAfter: [{ offset, size: 8, value: 5n }],
      memoryDelta: [],
    });
    assert.notEqual(result.status, 'supported', `offset ${String(offset)} aliased to expected field`);
    assert.notEqual(result.status, 'contradicted');
    assert.equal(result.status, 'inconclusive');
  }
});

test('#4312 structured memoryDelta offset cannot produce supported', () => {
  for (const offset of MALFORMED_OFFSETS) {
    const result = compareExpected(caseSpec, {
      stop: { kind: 'return' },
      memoryAfter: [],
      memoryDelta: [{ offset, size: 8, after: 5n }],
    });
    assert.notEqual(result.status, 'supported');
    assert.notEqual(result.status, 'contradicted');
    assert.equal(result.status, 'inconclusive');
  }
});

test('#4312 a canonical bigint offset still supports and contradicts', () => {
  const supported = compareExpected(caseSpec, {
    stop: { kind: 'return' },
    memoryAfter: [{ offset: 8n, size: 8, value: 5n }],
    memoryDelta: [],
  });
  assert.equal(supported.status, 'supported');

  const contradicted = compareExpected(caseSpec, {
    stop: { kind: 'return' },
    memoryAfter: [{ offset: 8n, size: 8, value: 9n }],
    memoryDelta: [],
  });
  assert.equal(contradicted.status, 'contradicted');
});

test('#4312 malformed offset does not shadow a later canonical match (final-state priority kept)', () => {
  const result = compareExpected(caseSpec, {
    stop: { kind: 'return' },
    memoryAfter: [{ offset: ['8'], size: 8, value: 999n }, { offset: 8n, size: 8, value: 5n }],
    memoryDelta: [],
  });
  assert.equal(result.status, 'supported');
  assert.equal(result.source, 'final-state');
});

test('#4312 malformed offset alone is treated as unobserved', () => {
  const result = compareExpected(caseSpec, {
    stop: { kind: 'return' },
    memoryAfter: [{ offset: ['8'], size: 8, value: 5n }],
    memoryDelta: [],
  });
  assert.equal(result.reason, 'expected-field-final-state-not-observed');
});
