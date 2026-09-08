// Regression for #5620: the capability parity audit must not coerce
// structured humanOnlyReason metadata through String(). Only primitive
// strings may carry an approved human-only exemption prefix.
import assert from 'node:assert/strict';
import { auditCapabilityParity, assertCapabilityParity } from '../../../js/ai/capabilities/parity.js';

const valid = { id: 'human.ok', category: 'human-only', agentExposed: false, humanOnlyReason: 'browser-security-user-gesture: real' };

// The three approved prefixes still pass as primitive strings.
for (const prefix of ['browser-security-user-gesture:', 'external-os-facility-unavailable:', 'inherently-visual-only-setting:']) {
  const result = auditCapabilityParity([{ ...valid, humanOnlyReason: `${prefix} detail` }]);
  assert.equal(result.ok, true, `primitive string reason with approved prefix ${prefix} must pass`);
}

// Structured values must fail even when String() would produce an approved prefix.
const forgeries = [
  ['browser-security-user-gesture: forged'],
  { text: 'browser-security-user-gesture: forged' },
  42,
  true,
  null,
];
for (const reason of forgeries) {
  const result = auditCapabilityParity([{ ...valid, humanOnlyReason: reason }]);
  assert.equal(result.ok, false, `structured ${typeof reason} humanOnlyReason must fail the parity audit`);
  assert.deepEqual(result.failures.map((item) => item.reason), ['invalid-human-only-reason']);
  assert.throws(() => assertCapabilityParity([{ ...valid, humanOnlyReason: reason }]));
}

// Missing/empty reasons keep failing (never coerced into an approval).
assert.equal(auditCapabilityParity([{ id: 'human.missing', category: 'human-only', agentExposed: false }]).ok, false);
assert.equal(auditCapabilityParity([{ ...valid, humanOnlyReason: '' }]).ok, false);

// Unknown-prefix primitive strings keep failing.
assert.equal(auditCapabilityParity([{ ...valid, humanOnlyReason: 'not implemented' }]).ok, false);

console.log('issue #5620 human-only reason identity regressions PASS');
