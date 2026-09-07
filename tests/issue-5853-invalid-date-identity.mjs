import assert from 'node:assert/strict';
import test from 'node:test';

import { jsonSafe } from '../js/core/identity/index.js';
import { serializable } from '../js/semantics/ir/common.js';

test('#5853 jsonSafe rejects an invalid Date with a canonical identity error', () => {
  assert.throws(() => jsonSafe(new Date(NaN)), (err) => err.message === 'identity-invalid-date');
  assert.equal(jsonSafe(new Date(0)), '1970-01-01T00:00:00.000Z', 'valid dates keep ISO conversion');
});

test('#5853 serializable boundary rejects invalid Dates before jsonSafe runs', () => {
  assert.throws(() => serializable(new Date(NaN), 'semantic-ir-invalid-metadata'), (err) => err.message === 'semantic-ir-invalid-metadata');
  assert.equal(serializable(new Date(0), 'x'), '1970-01-01T00:00:00.000Z');
});
