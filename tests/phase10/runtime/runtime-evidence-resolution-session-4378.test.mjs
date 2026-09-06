import assert from 'node:assert/strict';
import test from 'node:test';

import { RuntimeEvidenceBridge } from '../../../js/runtime/evidence-bridge.js';
import { createRuntimeAddressResolution } from '../../../js/runtime/provider-identity.js';

const event = {
  runtimeSessionId: 'session-A',
  providerId: 'provider-A',
  providerVersion: '1',
  sessionEpoch: 1,
  kind: 'call',
  payload: { address: '0x1000' },
  completeness: 'partial',
};

function resolution(runtimeSessionId, state = 'exact') {
  return createRuntimeAddressResolution({
    runtimeSessionId,
    runtimeAddress: 0x1000n,
    binaryId: `binary-${runtimeSessionId}`,
    state,
    method: state === 'exact' ? 'verified-module-offset' : 'resolved-module-offset',
    targetEntityIds: [`function-${runtimeSessionId}`],
  });
}

test('runtime evidence rejects exact resolution from another runtime session (#4378)', () => {
  const bridge = new RuntimeEvidenceBridge();
  assert.throws(
    () => bridge.eventToEvidence(event, resolution('session-B')),
    (error) => error?.code === 'runtime-resolution-session-mismatch',
  );
});

test('runtime evidence rejects resolved resolution from another runtime session (#4378)', () => {
  const bridge = new RuntimeEvidenceBridge();
  assert.throws(
    () => bridge.eventToEvidence(event, resolution('session-B', 'resolved')),
    (error) => error?.code === 'runtime-resolution-session-mismatch',
  );
});

test('runtime evidence preserves same-session resolution provenance (#4378)', () => {
  const bridge = new RuntimeEvidenceBridge();
  const evidence = bridge.eventToEvidence(event, resolution('session-A'));

  assert.equal(evidence.binaryId, 'binary-session-A');
  assert.deepEqual(evidence.targetEntityIds, ['function-session-A']);
  assert.equal(evidence.payload.runtimeSessionId, 'session-A');
  assert.equal(evidence.payload.resolution.runtimeSessionId, 'session-A');
  assert.equal(evidence.payload.resolution.state, 'exact');
});

test('runtime evidence snapshots caller-owned resolution before authority use (#4378)', () => {
  const bridge = new RuntimeEvidenceBridge();
  let runtimeSessionReads = 0;
  const driftingResolution = {
    get runtimeSessionId() {
      runtimeSessionReads += 1;
      return runtimeSessionReads === 1 ? 'session-A' : 'session-B';
    },
    binaryId: 'binary-session-A',
    state: 'exact',
    method: 'verified-module-offset',
    staticAddress: 0x1000n,
    functionMatchId: 'match-session-A',
    targetEntityIds: ['function-session-A'],
    evidenceIds: ['evidence-session-A'],
  };

  const evidence = bridge.eventToEvidence(event, driftingResolution);

  assert.equal(runtimeSessionReads, 1, 'caller-owned session authority must be read once');
  assert.equal(evidence.binaryId, 'binary-session-A');
  assert.deepEqual(evidence.targetEntityIds, ['function-session-A']);
  assert.equal(evidence.payload.resolution.runtimeSessionId, 'session-A');
  assert.equal(evidence.payload.resolution.state, 'exact');
  assert.equal(evidence.payload.resolution.method, 'verified-module-offset');
  assert.equal(evidence.payload.resolution.staticAddress, 0x1000n);
  assert.equal(evidence.payload.resolution.functionMatchId, 'match-session-A');
  assert.deepEqual(evidence.payload.resolution.evidenceIds, ['evidence-session-A']);
});

test('runtime evidence without a resolution keeps the unresolved path (#4378)', () => {
  const bridge = new RuntimeEvidenceBridge();
  const evidence = bridge.eventToEvidence(event);

  assert.equal(evidence.payload.runtimeSessionId, 'session-A');
  assert.equal(evidence.payload.resolution.state, 'unresolved');
  assert.equal(evidence.payload.resolution.method, 'no-resolution');
});
