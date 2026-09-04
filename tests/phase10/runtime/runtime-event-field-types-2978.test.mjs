import assert from 'node:assert/strict';

import { createRuntimeEvent } from '../../../js/runtime/events.js';

const base = Object.freeze({
  runtimeSessionId: 'session:2978',
  providerId: 'provider:2978',
  kind: 'call',
});

function expectCode(field, value, code) {
  assert.throws(
    () => createRuntimeEvent({ ...base, [field]: value }),
    (error) => error?.code === code,
    `${field} must reject ${typeof value === 'string' ? JSON.stringify(value) : String(value)}`,
  );
}

for (const field of ['sessionEpoch', 'sequence', 'moduleGeneration']) {
  for (const value of ['3', ['3'], true, false, {}]) {
    expectCode(field, value, 'runtime-invalid-event-integer');
  }
}

for (const value of [['2'], 2, true, false, {}]) {
  expectCode('providerVersion', value, 'runtime-invalid-provider-version');
}

for (const value of [['complete'], 1, true, false, {}]) {
  expectCode('completeness', value, 'runtime-invalid-completeness');
}

for (const value of [['observed'], 1, true, false, {}]) {
  expectCode('observationMode', value, 'runtime-invalid-observation-mode');
}

// Existing nullish defaults remain canonical and unchanged.
{
  const event = createRuntimeEvent({
    ...base,
    providerVersion: null,
    sessionEpoch: null,
    sequence: null,
    moduleGeneration: null,
    observationMode: null,
    completeness: null,
  });
  assert.equal(event.providerVersion, '1');
  assert.equal(event.sessionEpoch, 1);
  assert.equal(event.sequence, null);
  assert.equal(event.moduleGeneration, null);
  assert.equal(event.observationMode, 'observed');
  assert.equal(event.completeness, 'partial');
}

// Canonical primitive values still pass through without coercion.
{
  const event = createRuntimeEvent({
    ...base,
    providerVersion: '2',
    sessionEpoch: 3,
    sequence: 7,
    moduleGeneration: 4,
    observationMode: 'intervened',
    completeness: 'complete',
  });
  assert.equal(event.providerVersion, '2');
  assert.equal(event.sessionEpoch, 3);
  assert.equal(event.sequence, 7);
  assert.equal(event.moduleGeneration, 4);
  assert.equal(event.observationMode, 'intervened');
  assert.equal(event.completeness, 'complete');
}

// Existing range and enum validation remains in force after raw-type validation.
expectCode('sessionEpoch', 0, 'runtime-invalid-event-integer');
expectCode('sequence', -1, 'runtime-invalid-event-integer');
expectCode('moduleGeneration', 0, 'runtime-invalid-event-integer');
expectCode('completeness', 'bogus', 'runtime-invalid-completeness');
expectCode('observationMode', 'bogus', 'runtime-invalid-observation-mode');

console.log('runtime-event-field-types-2978: ok');
