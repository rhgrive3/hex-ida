import assert from 'node:assert/strict';
import test from 'node:test';

import {
  RemoteCollaborationGate,
  REMOTE_COLLAB_SCHEMA,
} from '../../../js/collaboration/remote-authority.js';
import { CHANGELOG_SCHEMA_VERSION } from '../../../js/collaboration/index.js';

const PROJECT = 'project:8652-review';
const SESSION = 'session:8652-review';
const DEVICE = 'device:8652-review';

function hostileEnvelope(payload) {
  return {
    schemaVersion: REMOTE_COLLAB_SCHEMA,
    operationSchemaVersion: CHANGELOG_SCHEMA_VERSION,
    projectIdentity: PROJECT,
    binaryIdentity: null,
    sessionIdentity: SESSION,
    actorIdentity: 'alice',
    deviceIdentity: DEVICE,
    messageId: 'message:8652-review',
    sequence: 1,
    operations: [{
      operationId: 'op:8652-review',
      targetEntityId: 'entity:8652-review',
      factKind: 'name',
      action: 'set',
      payload,
    }],
    // Deliberately invalid: if preflight undercounts and reaches digest work the
    // rejection changes to remote-envelope-identity-mismatch.
    envelopeId: 'remote-envelope:not-computed',
    transportProof: { authenticated: false, confidentiality: 'unverified', integrity: 'unverified' },
    egress: { userAuthorized: false, rawBinaryBytes: false, derivedDataOnly: true },
  };
}

function gate(maxMessageBytes) {
  return new RemoteCollaborationGate({
    projectIdentity: PROJECT,
    sessionIdentity: SESSION,
    allowedActors: { alice: ['*'] },
    maxBatch: 1,
    maxMessageBytes,
    verifyTransportProof: () => {
      throw new Error('transport verifier must not run for an over-budget envelope');
    },
    transportVerifierIdentity: 'oracle:8652-review',
  });
}

test('#8652 review: JSON control-character expansion is charged before snapshot/digest work', () => {
  const payload = '\0'.repeat(300);
  const envelope = hostileEnvelope(payload);
  const canonicalBytes = new TextEncoder().encode(JSON.stringify(envelope)).length;
  assert.ok(canonicalBytes > 1024, `fixture must exceed the byte limit after JSON escaping (${canonicalBytes})`);
  // The old value.length+2 estimator saw only 300 payload code units and let
  // this shape reach structuredClone/digest despite the canonical wire size.
  const result = gate(1024).validate(envelope);
  assert.deepEqual(result, { ok: false, reason: 'remote-message-budget-exceeded' });
});

test('#8652 review: escaped/non-ASCII object keys use canonical UTF-8 sizing too', () => {
  const payload = { [`${'\0'.repeat(180)}😀`]: true };
  const envelope = hostileEnvelope(payload);
  const canonicalBytes = new TextEncoder().encode(JSON.stringify(envelope)).length;
  assert.ok(canonicalBytes > 1024, `fixture must exceed the byte limit after key escaping (${canonicalBytes})`);
  assert.deepEqual(gate(1024).validate(envelope), {
    ok: false,
    reason: 'remote-message-budget-exceeded',
  });
});
