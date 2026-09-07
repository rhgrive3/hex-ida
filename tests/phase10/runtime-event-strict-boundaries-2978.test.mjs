import assert from 'node:assert/strict';
import { createRuntimeEvent } from '../../js/runtime/events.js';
import { DebugAdapterError } from '../../js/debug/adapter.js';

const base = {
  runtimeSessionId: 'session-1',
  providerId: 'provider-1',
  kind: 'call',
};

const valid = createRuntimeEvent({
  ...base,
  providerVersion: '2',
  sessionEpoch: 3,
  sequence: 7,
  moduleGeneration: 4,
  observationMode: 'observed',
  completeness: 'complete',
});
assert.equal(valid.providerVersion, '2');
assert.equal(valid.sessionEpoch, 3);
assert.equal(valid.sequence, 7);
assert.equal(valid.moduleGeneration, 4);
assert.equal(valid.observationMode, 'observed');
assert.equal(valid.completeness, 'complete');

for (const field of ['sessionEpoch', 'sequence', 'moduleGeneration']) {
  for (const value of ['3', true, [3], { value:3 }]) {
    assert.throws(() => createRuntimeEvent({ ...base, [field]:value }), /runtime-invalid-event-integer|safe integer/);
  }
}
for (const [field, value] of [
  ['providerVersion', ['2']],
  ['providerVersion', 2],
  ['observationMode', ['observed']],
  ['observationMode', { toString:() => 'observed' }],
  ['completeness', ['complete']],
  ['completeness', { toString:() => 'complete' }],
]) {
  assert.throws(() => createRuntimeEvent({ ...base, [field]:value }), DebugAdapterError);
}

console.log('runtime event strict boundaries #2978: PASS');
