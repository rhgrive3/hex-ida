import assert from 'node:assert/strict';

import {
  PHASE12_PROVIDER_OUTPUT_SCHEMA,
  validateProviderOutput,
} from '../../../js/phase12/package-envelope.js';
import { validatePhase12ProviderResult } from '../../../js/phase12/provider-boundary.js';

function base(overrides = {}) {
  return {
    schemaVersion: PHASE12_PROVIDER_OUTPUT_SCHEMA,
    provenance: { source: 'provider' },
    completeness: 'complete',
    ...overrides,
  };
}

const structured = [
  ['array', ['hex-entity:real']],
  ['object', { scheme: 'hex-entity' }],
  ['number', 7],
  ['boolean', true],
  ['empty string', ''],
  ['whitespace string', '   '],
];

for (const [label, identity] of structured) {
  const item = validateProviderOutput(base({
    items: [{ id: 'item-1', targetIdentity: identity, value: { matched: true } }],
  }));
  assert.equal(item.ok, false, `item ${label} targetIdentity must be rejected`);
  assert.equal(item.code, 'provider-output-item-target-identity-invalid');

  const topLevel = validateProviderOutput(base({
    targetIdentity: identity,
    items: [{ id: 'item-1', targetIdentity: identity, value: { matched: true } }],
  }));
  assert.equal(topLevel.ok, false, `top-level ${label} targetIdentity must be rejected`);
  assert.equal(topLevel.code, 'provider-output-target-identity-invalid');
}

const forged = validatePhase12ProviderResult(base({
  items: [{ id: 'item-1', targetIdentity: ['hex-entity:real'], value: { matched: true } }],
}));
assert.equal(forged.ok, false, 'structured item identity must not reach the L1 evidence boundary');
assert.equal(forged.value?.authority, undefined);

const canonical = validatePhase12ProviderResult(base({
  targetIdentity: 'hex-entity:real',
  items: [{ id: 'item-1', targetIdentity: 'hex-entity:real', value: { matched: true } }],
}));
assert.equal(canonical.ok, true, 'canonical string identity keeps existing provider ingress');
assert.equal(canonical.value.authority, 'L1-external-evidence');

const itemMismatch = validateProviderOutput(base({
  targetIdentity: 'hex-entity:real',
  items: [{ id: 'item-1', targetIdentity: 'hex-entity:other', value: {} }],
}));
assert.equal(itemMismatch.ok, false);
assert.equal(itemMismatch.code, 'provider-output-item-target-mismatch');

const optionMismatch = validateProviderOutput(base({
  targetIdentity: 'hex-entity:real',
  items: [{ id: 'item-1', targetIdentity: 'hex-entity:real', value: {} }],
}), { targetIdentity: 'hex-entity:other' });
assert.equal(optionMismatch.ok, false);
assert.equal(optionMismatch.code, 'provider-output-target-mismatch');

for (const label of ['array', 'object', 'number', 'boolean', 'empty', 'whitespace']) {
  const identity = { array: ['x'], object: { x: 1 }, number: 3, boolean: false, empty: '', whitespace: ' ' }[label];
  const optionGuard = validateProviderOutput(base({
    items: [{ id: 'item-1', targetIdentity: 'hex-entity:real', value: {} }],
  }), { targetIdentity: identity });
  assert.equal(optionGuard.ok, false, `options ${label} targetIdentity must fail closed on the same typed contract`);
  assert.equal(optionGuard.code, 'provider-output-target-identity-invalid');
}

const budget = validateProviderOutput(base({
  items: [{ id: 'item-1', targetIdentity: 'hex-entity:real', value: {} }],
}), { maxEntries: 0 });
assert.equal(budget.ok, false, 'entry budget gate stays enforced');
const incomplete = validateProviderOutput(base({
  completeness: 'partial',
  unique: true,
  items: [{ id: 'item-1', targetIdentity: 'hex-entity:real', value: {} }],
}));
assert.equal(incomplete.ok, false, 'completeness gate stays enforced');
assert.equal(incomplete.code, 'provider-output-incomplete-unique-invalid');

console.log('[phase12] #3843 provider output targetIdentity regressions passed');
