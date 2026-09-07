import assert from 'node:assert/strict';
import test from 'node:test';

import { RuntimeEvidenceBridge } from '../../../js/runtime/evidence-bridge.js';

const baseEvent = Object.freeze({
  runtimeSessionId: 'session-A',
  providerId: 'provider-A',
  providerVersion: '1',
  sessionEpoch: 1,
  eventId: 'event-5973',
  kind: 'memory-write',
  payload: { address: '0x1000', value: 1 },
  completeness: 'complete',
});

const exactResolution = Object.freeze({
  runtimeSessionId: 'session-A',
  state: 'exact',
  method: 'test-exact',
  binaryId: 'binary-A',
  targetEntityIds: ['entity-A'],
  staticAddress: 0x2000n,
  evidenceIds: [],
});

function addIntervention(bridge, {
  interventionId,
  parentInterventionIds = [],
  sequence = 1,
  runtimeSessionId = 'session-A',
} = {}) {
  return bridge.interventions.add({
    interventionId,
    runtimeSessionId,
    providerId: 'provider-A',
    kind: 'memory-write',
    target: { address: '0x1000' },
    requestedChange: { value: 1 },
    sequence,
    parentInterventionIds,
  });
}

test('runtime evidence rejects an unknown top-level intervention id (#5973)', () => {
  const bridge = new RuntimeEvidenceBridge();

  assert.throws(
    () => bridge.eventToEvidence({ ...baseEvent, interventionIds: ['missing-intervention'] }, exactResolution),
    (error) => error?.code === 'runtime-intervention-not-found',
  );
});

test('runtime evidence rejects mixed known and unknown intervention ids (#5973)', () => {
  const bridge = new RuntimeEvidenceBridge();
  addIntervention(bridge, { interventionId: 'known-intervention' });

  assert.throws(
    () => bridge.eventToEvidence({
      ...baseEvent,
      interventionIds: ['known-intervention', 'missing-intervention'],
    }, exactResolution),
    (error) => error?.code === 'runtime-intervention-not-found',
  );
});

test('known intervention ancestry remains complete and exact evidence stays complete (#5973)', () => {
  const bridge = new RuntimeEvidenceBridge();
  addIntervention(bridge, { interventionId: 'parent-intervention', sequence: 1 });
  addIntervention(bridge, {
    interventionId: 'child-intervention',
    parentInterventionIds: ['parent-intervention'],
    sequence: 2,
  });

  const evidence = bridge.eventToEvidence({
    ...baseEvent,
    interventionIds: ['child-intervention'],
  }, exactResolution);

  assert.deepEqual(
    [...evidence.payload.interventionIds].sort(),
    ['child-intervention', 'parent-intervention'],
  );
  assert.equal(evidence.completeness, 'complete');
});

test('runtime evidence rejects a known intervention from another session (#5973)', () => {
  const bridge = new RuntimeEvidenceBridge();
  addIntervention(bridge, {
    interventionId: 'foreign-intervention',
    runtimeSessionId: 'session-B',
  });

  assert.throws(
    () => bridge.eventToEvidence({
      ...baseEvent,
      interventionIds: ['foreign-intervention'],
    }, exactResolution),
    (error) => error?.code === 'runtime-intervention-session-mismatch',
  );
});

test('runtime evidence rejects cross-session intervention ancestry (#5973)', () => {
  const bridge = new RuntimeEvidenceBridge();
  addIntervention(bridge, {
    interventionId: 'foreign-parent',
    runtimeSessionId: 'session-B',
  });
  addIntervention(bridge, {
    interventionId: 'session-a-child',
    runtimeSessionId: 'session-A',
    parentInterventionIds: ['foreign-parent'],
  });

  assert.throws(
    () => bridge.eventToEvidence({
      ...baseEvent,
      interventionIds: ['session-a-child'],
    }, exactResolution),
    (error) => error?.code === 'runtime-intervention-session-mismatch',
  );
});

test('events without interventions preserve existing evidence behavior (#5973)', () => {
  const bridge = new RuntimeEvidenceBridge();
  const evidence = bridge.eventToEvidence(baseEvent, exactResolution);

  assert.deepEqual(evidence.payload.interventionIds, []);
  assert.equal(evidence.completeness, 'complete');
});
