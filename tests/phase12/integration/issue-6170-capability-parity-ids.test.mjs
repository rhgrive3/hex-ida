import assert from 'node:assert/strict';
import { CapabilityCatalog } from '../../../js/ai/capabilities/catalog.js';
import { auditCapabilityParity } from '../../../js/ai/capabilities/parity.js';

const valid = {
  id: 'custom.valid',
  category: 'human-only',
  agentExposed: false,
  humanOnlyReason: 'browser-security-user-gesture:fixture',
};

assert.equal(auditCapabilityParity([valid]).ok, true);
assert.equal(auditCapabilityParity([valid]).checked, 1);

for (const id of [1, true, {}, [], '']) {
  const result = auditCapabilityParity([{ ...valid, id }]);
  assert.equal(result.ok, false);
  assert.equal(result.failures[0].reason, 'invalid-id');
}

const semanticDuplicate = auditCapabilityParity([
  { ...valid, id: 1 },
  { ...valid, id: '1' },
]);
assert.equal(semanticDuplicate.ok, false);
assert.ok(semanticDuplicate.failures.some((failure) => failure.reason === 'invalid-id'));

const duplicate = auditCapabilityParity([valid, { ...valid, humanOnlyReason: `${valid.humanOnlyReason}:again` }]);
assert.equal(duplicate.ok, false);
assert.equal(duplicate.failures[0].reason, 'missing-or-duplicate-id');

const catalog = new CapabilityCatalog([valid, { ...valid, id: ' custom.trimmed ' }]);
assert.equal(catalog.get('custom.valid'), valid);
assert.equal(catalog.get('custom.trimmed').id, 'custom.trimmed');
assert.equal(catalog.get(1), null);
assert.equal(catalog.has({ toString:() => 'custom.valid' }), false);
assert.throws(() => new CapabilityCatalog([{ ...valid, id: 1 }]), /invalid capability id/);
assert.throws(() => new CapabilityCatalog([valid, { ...valid }]), /duplicate capability id/);

console.log('issue #6170 capability parity ID validation: PASS');
