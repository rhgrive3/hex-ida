import assert from 'node:assert/strict';
import { createRuntimeEvent, createRuntimeEventBatch } from '../js/runtime/events.js';
import { createInstrumentationProvider } from '../js/runtime/instrumentation-provider.js';
import { createRuntimeAddressResolution } from '../js/runtime/provider-identity.js';
import { validateProviderPacket } from '../js/runtime/provider-protocol.js';
import { createInterventionRecord } from '../js/runtime/evidence-bridge.js';

// --- Test 1: CodeRabbit - throwing toString() in completeness and mode ---
{
  const throwingToString = {
    toString() { throw new Error('evil toString'); },
  };

  assert.throws(
    () => createRuntimeEvent({
      runtimeSessionId: 's1',
      providerId: 'p1',
      kind: 'trace-marker',
      completeness: throwingToString,
    }),
    (err) => err.code === 'runtime-invalid-completeness' && err.name === 'DebugAdapterError'
  );

  assert.throws(
    () => createRuntimeEvent({
      runtimeSessionId: 's1',
      providerId: 'p1',
      kind: 'trace-marker',
      observationMode: throwingToString,
    }),
    (err) => err.code === 'runtime-invalid-observation-mode' && err.name === 'DebugAdapterError'
  );
  console.log('✔ CodeRabbit throwing toString validation errors passed');
}

// --- Test 2: CodeRabbit - synchronous re-entrant setEpoch in instrumentation provider ---
{
  let reentrantFailedAsExpected = false;
  let providerSession;
  const backend = {
    setEpoch(next) {
      // attempt synchronous re-entrant call
      try {
        providerSession.newProviderEpoch();
      } catch (err) {
        if (err.code === 'runtime-epoch-transition-active') {
          reentrantFailedAsExpected = true;
        }
      }
      return Promise.resolve();
    },
  };
  const provider = createInstrumentationProvider(backend);
  providerSession = await provider.openSession({
    runtimeSessionId: 's1',
    binaryId: 'b1',
  });
  await providerSession.newProviderEpoch();
  assert.equal(reentrantFailedAsExpected, true, 'synchronous reentrant newProviderEpoch must be rejected');
  console.log('✔ CodeRabbit instrumentation provider synchronous reentrancy guard passed');
}

// --- Test 3: #4364 whitespace-only event identity rejection ---
{
  const base = {
    runtimeSessionId: 's1',
    providerId: 'p1',
    kind: 'trace-marker',
  };

  assert.throws(
    () => createRuntimeEvent({ ...base, streamId: '   ' }),
    (err) => err.code === 'runtime-invalid-event-identity'
  );

  assert.throws(
    () => createRuntimeEvent({ ...base, providerEventId: '\t' }),
    (err) => err.code === 'runtime-invalid-event-identity'
  );

  assert.throws(
    () => createRuntimeEvent({ ...base, predecessorIds: [' '] }),
    (err) => err.code === 'runtime-invalid-event-array'
  );

  assert.throws(
    () => createRuntimeEvent({ ...base, interventionIds: ['\n'] }),
    (err) => err.code === 'runtime-invalid-event-array'
  );

  const valid = createRuntimeEvent({
    ...base,
    streamId: 'stream-1',
    predecessorIds: ['event-1'],
    interventionIds: ['int-1'],
  });
  assert.equal(valid.streamId, 'stream-1');
  assert.deepEqual(valid.predecessorIds, ['event-1']);
  console.log('✔ #4364 whitespace-only event identity rejection passed');
}

// --- Test 4: #4262 whitespace-only provider identity evidence IDs rejection ---
{
  assert.throws(
    () => createRuntimeAddressResolution({
      runtimeSessionId: 'runtime-1',
      runtimeAddress: 0x1000n,
      state: 'unresolved',
      evidenceIds: ['   '],
    }),
    (err) => err.code === 'invalid-evidence-ids'
  );

  assert.throws(
    () => createRuntimeAddressResolution({
      runtimeSessionId: 'runtime-1',
      runtimeAddress: 0x1000n,
      state: 'unresolved',
      targetEntityIds: ['\t'],
    }),
    (err) => err.code === 'invalid-target-entity-ids'
  );

  const valid = createRuntimeAddressResolution({
    runtimeSessionId: 'runtime-1',
    runtimeAddress: 0x1000n,
    state: 'unresolved',
    evidenceIds: ['ev1'],
    targetEntityIds: ['ent1'],
  });
  assert.deepEqual(valid.evidenceIds, ['ev1']);
  assert.deepEqual(valid.targetEntityIds, ['ent1']);
  console.log('✔ #4262 whitespace-only provider identity rejection passed');
}

// --- Test 5: #4330 numeric string packet id and epoch rejection ---
{
  assert.throws(
    () => validateProviderPacket({
      protocol: 'hex-runtime-provider',
      version: 1,
      type: 'request',
      id: '01',
      epoch: 1,
      facet: null,
      method: 'runtime.session.test',
      payload: null,
    }),
    (err) => err.code === 'malformed-provider-data'
  );

  assert.throws(
    () => validateProviderPacket({
      protocol: 'hex-runtime-provider',
      version: 1,
      type: 'request',
      id: 1,
      epoch: ' 1 ',
      facet: null,
      method: 'runtime.session.test',
      payload: null,
    }),
    (err) => err.code === 'malformed-provider-data'
  );

  const valid = validateProviderPacket({
    protocol: 'hex-runtime-provider',
    version: 1,
    type: 'request',
    id: 1,
    epoch: 1,
    facet: null,
    method: 'runtime.session.test',
    payload: null,
  });
  assert.equal(valid.id, 1);
  assert.equal(valid.epoch, 1);
  console.log('✔ #4330 strict numeric integer packet id and epoch passed');
}

// --- Test 6: #4334 strict integer intervention sequence ---
{
  const base = {
    runtimeSessionId: 's1',
    providerId: 'p1',
    kind: 'memory-write',
    target: { address: 0x1000n },
    requestedChange: { bytes: [1] },
  };

  assert.throws(
    () => createInterventionRecord({ ...base, sequence: '01' }),
    (err) => err.code === 'runtime-invalid-intervention-sequence'
  );

  assert.throws(
    () => createInterventionRecord({ ...base, sequence: 1n }),
    (err) => err.code === 'runtime-invalid-intervention-sequence'
  );

  const valid = createInterventionRecord({ ...base, sequence: 1 });
  assert.equal(valid.sequence, 1);

  const validNull = createInterventionRecord({ ...base, sequence: null });
  assert.equal(validNull.sequence, null);
  console.log('✔ #4334 strict integer intervention sequence passed');
}

// --- Test 7: #3503 non-Array events in createRuntimeEventBatch ---
{
  assert.throws(
    () => createRuntimeEventBatch({
      runtimeSessionId: 's1',
      providerId: 'p1',
      sessionEpoch: 1,
      events: 'not-an-array',
    }),
    (err) => err.code === 'runtime-invalid-event-array'
  );

  const validEmpty = createRuntimeEventBatch({
    runtimeSessionId: 's1',
    providerId: 'p1',
    sessionEpoch: 1,
    events: null,
  });
  assert.deepEqual(validEmpty.events, []);
  console.log('✔ #3503 non-Array events fail-closed passed');
}

console.log('\nAll runtime-debug consolidated regression tests PASSED!');
