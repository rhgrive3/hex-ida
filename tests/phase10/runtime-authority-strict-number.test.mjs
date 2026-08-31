import assert from 'node:assert/strict';
import { createRuntimeAuthorityBinding, createRuntimeObservation, RuntimeAuthorityTracker } from '../../js/runtime/authority.js';

const base = {
  providerIdentity:'provider-A',
  runtimeInstanceIdentity:'runtime-A',
  targetIdentity:'target-A',
  binaryIdentity:'binary-A',
  moduleIdentity:'module-A',
  loadMappingIdentity:'mapping-A',
  sessionIdentity:'session-A',
  capabilityVersion:'1',
};

assert.throws(() => createRuntimeAuthorityBinding({ ...base, epoch:'1' }), /runtime-epoch-invalid/);
assert.throws(() => createRuntimeAuthorityBinding({ ...base, epoch:['1'] }), /runtime-epoch-invalid/);
const binding = createRuntimeAuthorityBinding({ ...base, epoch:1 });
assert.equal(binding.epoch, 1);
assert.throws(() => createRuntimeObservation({ binding, sequence:'2', observedAt:'2026-08-31T00:00:00Z', kind:'call' }), /runtime-observation-sequence-invalid/);
assert.throws(() => createRuntimeObservation({ binding, sequence:['2'], observedAt:'2026-08-31T00:00:00Z', kind:'call' }), /runtime-observation-sequence-invalid/);
const observation = createRuntimeObservation({ binding, sequence:2, observedAt:'2026-08-31T00:00:00Z', kind:'call' });
assert.equal(observation.sequence, 2);
assert.throws(() => new RuntimeAuthorityTracker(binding, { maxObservations:'2' }), /runtime-max-observations-invalid/);
const tracker = new RuntimeAuthorityTracker(binding, { maxObservations:2 });
assert.equal(tracker.maxObservations, 2);
console.log('runtime authority strict number boundary: PASS');
