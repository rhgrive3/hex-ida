import assert from 'node:assert/strict';
import test from 'node:test';

import { createClaimNode } from '../../../js/core/evidence/index.js';
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

function resolution({
  runtimeSessionId = 'session-A',
  runtimeAddress = 0x1000n,
  staticAddress = 0x2000n,
  binaryId = 'binary-A',
  targetEntityIds = ['function-A'],
  state = 'exact',
} = {}) {
  return createRuntimeAddressResolution({
    runtimeSessionId,
    runtimeAddress,
    staticAddress,
    binaryId,
    state,
    method: state === 'exact' ? 'verified-module-offset' : 'resolved-module-offset',
    targetEntityIds,
    evidenceIds: ['module-proof-A'],
  });
}

function addClaim(bridge, { id = 'claim-A', binaryId = 'binary-A', targetEntityIds = ['function-A'] } = {}) {
  const claim = createClaimNode({
    id,
    binaryId,
    targetEntityIds,
    semanticKind: 'call-target',
  });
  bridge.graph.addNode(claim);
  return claim;
}

test('claim link accepts the exact resolution bound into runtime evidence (#4411)', () => {
  const bridge = new RuntimeEvidenceBridge();
  const boundResolution = resolution();
  const evidence = bridge.eventToEvidence(event, boundResolution);
  const claim = addClaim(bridge);

  const result = bridge.linkClaim(claim.id, evidence.id, 'supports', boundResolution);

  assert.equal(result.linked, true);
  assert.equal(bridge.graph.allEdges().length, 1);
  assert.equal(bridge.graph.evaluateClaim(claim.id).verdict, 'supported');
});

test('plain exact-shaped object cannot authorize unresolved runtime evidence (#4411)', () => {
  const bridge = new RuntimeEvidenceBridge();
  const evidence = bridge.eventToEvidence(event);
  const claim = addClaim(bridge);

  const result = bridge.linkClaim(claim.id, evidence.id, 'supports', {
    state: 'exact',
    targetEntityIds: ['function-A'],
  });

  assert.equal(result.linked, false);
  assert.equal(result.reason, 'resolution-evidence-mismatch');
  assert.equal(bridge.graph.allEdges().length, 0);
});

test('claim link rejects a resolution from another runtime session (#4411)', () => {
  const bridge = new RuntimeEvidenceBridge();
  const boundResolution = resolution();
  const evidence = bridge.eventToEvidence(event, boundResolution);
  const claim = addClaim(bridge);
  const unrelated = resolution({ runtimeSessionId: 'session-B' });

  const result = bridge.linkClaim(claim.id, evidence.id, 'supports', unrelated);

  assert.equal(result.linked, false);
  assert.equal(result.reason, 'resolution-evidence-mismatch');
  assert.equal(bridge.graph.allEdges().length, 0);
});

test('claim link rejects binary and target identity substitutions (#4411)', () => {
  const bridge = new RuntimeEvidenceBridge();
  const boundResolution = resolution();
  const evidence = bridge.eventToEvidence(event, boundResolution);
  const claim = addClaim(bridge);

  const wrongBinary = bridge.linkClaim(
    claim.id,
    evidence.id,
    'supports',
    resolution({ binaryId: 'binary-B' }),
  );
  const wrongTarget = bridge.linkClaim(
    claim.id,
    evidence.id,
    'supports',
    resolution({ targetEntityIds: ['function-Z'] }),
  );

  assert.equal(wrongBinary.linked, false);
  assert.equal(wrongTarget.linked, false);
  assert.equal(bridge.graph.allEdges().length, 0);
});

test('claim link rejects a different address resolution with matching envelope identities (#4411)', () => {
  const bridge = new RuntimeEvidenceBridge();
  const boundResolution = resolution();
  const evidence = bridge.eventToEvidence(event, boundResolution);
  const claim = addClaim(bridge);
  const differentAddress = resolution({ runtimeAddress: 0x1001n, staticAddress: 0x2001n });

  const result = bridge.linkClaim(claim.id, evidence.id, 'refines', differentAddress);

  assert.equal(result.linked, false);
  assert.equal(result.reason, 'resolution-evidence-mismatch');
  assert.equal(bridge.graph.allEdges().length, 0);
});

test('claim link snapshots caller-owned resolution before checking its binding (#4411)', () => {
  const bridge = new RuntimeEvidenceBridge();
  const boundResolution = resolution();
  const evidence = bridge.eventToEvidence(event, boundResolution);
  const claim = addClaim(bridge);
  let sessionReads = 0;
  const drifting = {
    ...boundResolution,
    get runtimeSessionId() {
      sessionReads += 1;
      return sessionReads === 1 ? 'session-A' : 'session-B';
    },
  };

  const result = bridge.linkClaim(claim.id, evidence.id, 'contradicts', drifting);

  assert.equal(sessionReads, 1, 'resolution session authority must be snapshotted once');
  assert.equal(result.linked, true);
  assert.equal(bridge.graph.allEdges().length, 1);
});
