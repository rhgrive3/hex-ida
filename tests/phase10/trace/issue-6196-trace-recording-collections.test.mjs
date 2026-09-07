import assert from 'node:assert/strict';

import { TraceProvider } from '../../../js/runtime/trace-provider.js';

function recording(overrides = {}) {
  return {
    recordingId: 'recording:issue-6196',
    sourceProvider: 'fixture-tracer',
    sourceProviderVersion: '1',
    binaryId: 'bin:issue-6196',
    completeness: 'complete',
    ...overrides,
  };
}

// An omitted collection remains an empty collection, preserving the optional-field contract.
{
  const input = recording();
  const provider = new TraceProvider(input);
  assert.deepEqual(provider.recording.events, []);
  assert.deepEqual(provider.recording.modules, []);
  assert.deepEqual(provider.recording.interventions, []);
}

// A legacy nested event array remains valid when the top-level field is absent/null.
{
  const provider = new TraceProvider(recording({
    events: null,
    trace: { events: [{ type: 'call', payload: { target: '0x1000' } }] },
  }));
  assert.equal(provider.recording.events.length, 1);
}

for (const [field, value] of [
  ['events', { type: 'memory-write' }],
  ['events', 'call'],
  ['modules', { id: 'main', runtimeBase: 0x1000n, runtimeSize: 0x100n }],
  ['interventions', { interventionId: 'i1' }],
]) {
  assert.throws(
    () => new TraceProvider(recording({ [field]: value })),
    (error) => error?.code === 'trace-invalid-recording' && error.message.includes(field),
    `${field} must reject a non-array value`,
  );
}

// A malformed top-level event field must not silently fall through to a valid legacy field.
assert.throws(
  () => new TraceProvider(recording({
    events: { type: 'call' },
    trace: { events: [] },
  })),
  /trace events must be an array/,
);

console.log('issue-6196-trace-recording-collections: ok');
