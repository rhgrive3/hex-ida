import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { webcrypto } from 'node:crypto';

import {
  RemoteCollaborationGate,
  createRemoteCollaborationEnvelope,
  envelopeIdentity,
} from '../../../js/collaboration/remote-authority.js';
import {
  REMOTE_CANONICAL_RESPONSE_SCHEMA,
  RemoteCanonicalHttpTransport,
} from '../../../js/collaboration/remote-transport.js';
import { stableStringify } from '../../../js/core/identity/index.js';

if (!globalThis.crypto) Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });

const base = {
  projectIdentity: 'project:4446',
  binaryIdentity: 'binary:4446',
  sessionIdentity: 'session:4446',
  actorIdentity: 'alice',
  deviceIdentity: 'device:alice',
  egress: { userAuthorized: true, rawBinaryBytes: false, derivedDataOnly: true },
};

function input(payload, sequence = 1) {
  return {
    ...base,
    messageId: `message:${sequence}`,
    sequence,
    operations: [{ targetEntityId: 'entity:1', factKind: 'name', action: 'set', payload }],
  };
}

for (const payload of [
  new Map([['role', 'reader']]),
  new Set(['reader']),
  { nested: { entries: new Map([['role', 'reader']]) } },
]) {
  assert.throws(
    () => createRemoteCollaborationEnvelope(input(payload)),
    (error) => error instanceof TypeError && error.message === 'remote-operation-mutable-collection-forbidden',
    'remote operation creation must reject mutable Map/Set payloads before authentication',
  );
}

const canonical = createRemoteCollaborationEnvelope({
  ...input('reader'),
  transportProof: {
    authenticated: true,
    confidentiality: 'verified',
    integrity: 'verified',
    proofIdentity: 'proof:4446',
  },
});
const gate = new RemoteCollaborationGate({
  projectIdentity: base.projectIdentity,
  binaryIdentity: base.binaryIdentity,
  sessionIdentity: base.sessionIdentity,
  allowedActors: { alice: ['*'] },
  verifyTransportProof: () => true,
  transportVerifierIdentity: 'transport:4446',
});

for (const [label, payload] of [
  ['map', new Map([['role', 'reader']])],
  ['set', new Set(['reader'])],
]) {
  const raw = {
    ...canonical,
    messageId: `raw:${label}`,
    operations: [{ ...canonical.operations[0], operationId: `operation:raw:${label}`, payload }],
  };
  raw.envelopeId = envelopeIdentity(raw);
  assert.deepEqual(
    gate.validate(raw),
    { ok: false, reason: 'remote-envelope-shape-invalid' },
    `raw ${label} payload must be rejected before transport proof validation`,
  );
}

const encoder = new TextEncoder();
const { publicKey, privateKey } = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
const sessionEncryptionKey = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
let authorizationRequests = 0;
const transport = new RemoteCanonicalHttpTransport({
  endpoint: 'https://collaboration.example.test/authorize',
  serverVerificationKey: publicKey,
  sessionEncryptionKey,
  serverKeyId: 'server:key:4446',
  fetchImpl: async (_url, init) => {
    authorizationRequests += 1;
    const request = JSON.parse(init.body);
    const signed = {
      schemaVersion: REMOTE_CANONICAL_RESPONSE_SCHEMA,
      requestId: request.requestId,
      bindingDigest: request.bindingDigest,
      keyId: request.keyId,
    };
    const signature = await crypto.subtle.sign(
      { name: 'Ed25519' },
      privateKey,
      encoder.encode(stableStringify(signed)),
    );
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ ...signed, signature: Buffer.from(signature).toString('base64') }),
    };
  },
});

await assert.rejects(
  () => transport.authorizeEnvelope(input(new Map([['role', 'reader']]), 2)),
  /remote-operation-mutable-collection-forbidden/,
);
await assert.rejects(
  () => transport.authorizeEnvelope(input(new Set(['reader']), 3)),
  /remote-operation-mutable-collection-forbidden/,
);
assert.equal(authorizationRequests, 0, 'mutable collections must not reach the authorization transport');

const plain = await transport.authorizeEnvelope(input({ role: 'reader' }, 4));
assert.equal(transport.verifyTransportProof(plain.transportProof, plain), true, 'plain JSON payloads retain transport proof semantics');

console.log('issue-4446 remote Map/Set binding rejection tests passed');
