import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  PHASE12_PROVIDER_OUTPUT_SCHEMA,
  validateProviderOutput,
} from '../../../js/phase12/package-envelope.js';

function base(overrides = {}) {
  return {
    schemaVersion: PHASE12_PROVIDER_OUTPUT_SCHEMA,
    provenance: { source: 'test' },
    targetIdentity: 'target-1',
    completeness: 'complete',
    ...overrides,
  };
}

test('provider output rejects simultaneous items/results collections', () => {
  const checked = validateProviderOutput(base({
    items: [],
    results: [
      { id: 'a', targetIdentity: 'target-1' },
      { id: 'b', targetIdentity: 'target-1' },
    ],
  }), { maxEntries: 1 });

  assert.equal(checked.ok, false);
  assert.equal(checked.code, 'provider-output-entry-collection-ambiguous');
});

test('provider output still accepts either canonical entry collection independently', () => {
  for (const field of ['items', 'results']) {
    const checked = validateProviderOutput(base({
      [field]: [{ id: 'entry-1', targetIdentity: 'target-1' }],
    }), { maxEntries: 1 });
    assert.equal(checked.ok, true, field);
  }
});

test('provider output requires stable non-empty string item ids', () => {
  for (const id of ['', '   ', 1, {}, [], null]) {
    const checked = validateProviderOutput(base({
      items: [{ id, targetIdentity: 'target-1' }],
    }));
    assert.equal(checked.ok, false, `id=${JSON.stringify(id)}`);
    assert.equal(checked.code, 'provider-output-item-identity-required');
  }

  const valid = validateProviderOutput(base({
    items: [{ id: 'stable-entry-id', targetIdentity: 'target-1' }],
  }));
  assert.equal(valid.ok, true);
});
