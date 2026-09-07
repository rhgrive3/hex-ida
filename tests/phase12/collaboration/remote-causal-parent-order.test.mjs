import assert from 'node:assert/strict';
import {
  RemoteCollaborationGate,
  createRemoteCollaborationEnvelope,
} from '../../../js/collaboration/remote-authority.js';

const scope = {
  projectIdentity: 'project:mixed-case-order',
  binaryIdentity: 'binary:mixed-case-order',
  sessionIdentity: 'session:mixed-case-order',
};

const envelope = createRemoteCollaborationEnvelope({
  ...scope,
  actorIdentity: 'Alice',
  deviceIdentity: 'device:Alice',
  messageId: 'message:mixed-case-order',
  sequence: 1,
  operations: [{
    operationId: 'operation:mixed-case-order',
    targetEntityId: 'entity:1',
    factKind: 'name',
    action: 'set',
    payload: 'value',
    causalParents: ['parent:a', 'Parent:B'],
  }],
  transportProof: {
    authenticated: true,
    confidentiality: 'verified',
    integrity: 'verified',
    proofIdentity: 'proof:mixed-case-order',
  },
  egress: {
    userAuthorized: true,
    rawBinaryBytes: false,
    derivedDataOnly: true,
  },
});

assert.deepEqual(
  envelope.operations[0].causalParents,
  ['Parent:B', 'parent:a'],
  'factory canonicalization must retain code-unit ordering',
);

const gate = new RemoteCollaborationGate({
  ...scope,
  allowedActors: { Alice: ['*'] },
  verifyTransportProof: () => true,
  transportVerifierIdentity: 'transport:mixed-case-order',
});

assert.deepEqual(
  gate.validate(envelope),
  { ok: true },
  'remote ingress must accept the factory-canonical mixed-case causal-parent order',
);

console.log('[phase12] remote mixed-case causal-parent ordering regression passed');
