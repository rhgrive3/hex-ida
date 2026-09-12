import assert from 'node:assert/strict';
import test from 'node:test';

import { PHASE12_PROVIDER_OUTPUT_SCHEMA, validateProviderOutput } from '../../../js/phase12/package-envelope.js';

function base(overrides = {}) {
  return {
    schemaVersion: PHASE12_PROVIDER_OUTPUT_SCHEMA,
    provenance: { source: 'issue-4405' },
    completeness: 'complete',
    ...overrides,
  };
}

test('#4405 explicit non-array items/results fail closed instead of becoming empty results', () => {
  for (const field of ['items', 'results']) {
    for (const value of [{}, false, null, 'entry', 1, undefined]) {
      const checked = validateProviderOutput(base({ [field]: value }));
      assert.equal(checked.ok, false, `${field}=${String(value)} must be rejected`);
      assert.equal(checked.code, 'provider-output-schema-invalid');
    }
  }
});

test('#4405 missing collections remain the only implicit empty-result form', () => {
  const checked = validateProviderOutput(base());
  assert.equal(checked.ok, true);
  assert.equal(Object.hasOwn(checked.value, 'items'), false);
  assert.equal(Object.hasOwn(checked.value, 'results'), false);
});

test('#4405 valid collection selection and ambiguity rules remain unchanged', () => {
  const item = { id: 'entry-1', targetIdentity: 'target-1' };
  assert.equal(validateProviderOutput(base({ items: [item] })).ok, true);
  assert.equal(validateProviderOutput(base({ results: [item] })).ok, true);
  assert.equal(validateProviderOutput(base({ items: [], results: [] })).code, 'provider-output-entry-collection-ambiguous');
  assert.equal(validateProviderOutput(base({ items: [], results: {} })).code, 'provider-output-schema-invalid');
});
