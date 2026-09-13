// Regression for #4964: egress.rawBinaryBytes:false / derivedDataOnly:true were
// caller self-declarations only, so Uint8Array/ArrayBuffer/DataView payloads
// were serialized as byte arrays into the canonical transport request while the
// policy still claimed "derived data only". Raw-byte-bearing outbound
// operations must now be classified from the real payload content and rejected
// fail-closed by the envelope factory, RemoteCollaborationGate.validate(), and
// RemoteCanonicalHttpTransport.authorizeEnvelope() with one contract.
import assert from 'node:assert/strict';
import { generateKeyPairSync, webcrypto } from 'node:crypto';
import { stableStringify } from '../js/core/identity/index.js';
import { CHANGELOG_SCHEMA_VERSION, createProjectOperation } from '../js/collaboration/index.js';
import {
  REMOTE_COLLAB_SCHEMA,
  RemoteCollaborationGate,
  createRemoteCollaborationEnvelope,
  envelopeIdentity,
} from '../js/collaboration/remote-authority.js';
import {
  REMOTE_CANONICAL_RESPONSE_SCHEMA,
  RemoteCanonicalHttpTransport,
} from '../js/collaboration/remote-transport.js';

const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const serverVerificationKey = await webcrypto.subtle.importKey('spki', publicKey.export({ type: 'spki', format: 'der' }), { name: 'Ed25519' }, false, ['verify']);
const serverSigningKey = await webcrypto.subtle.importKey('pkcs8', privateKey.export({ type: 'pkcs8', format: 'der' }), { name: 'Ed25519' }, false, ['sign']);
const sessionEncryptionKey = await webcrypto.subtle.importKey('raw', new Uint8Array(32).fill(7), { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
const serverKeyId = 'ed25519:test';

const base = {
  projectIdentity: 'project:1', binaryIdentity: 'binary:1', sessionIdentity: 'session:1',
  actorIdentity: 'alice', deviceIdentity: 'device:1',
};

function inputWith(payload, { messageId = 'message:1', sequence = 1, egress } = {}) {
  return {
    ...base, messageId, sequence,
    transportProof: { authenticated: true, confidentiality: 'verified', integrity: 'verified', proofIdentity: 'proof:1' },
    operations: [{ targetEntityId: 'finding:1', factKind: 'confirmation', action: 'set', payload, causalParents: [] }],
    egress: egress ?? { userAuthorized: true, rawBinaryBytes: false, derivedDataOnly: true },
  };
}

const rawBytePayloads = {
  'uint8array': () => Uint8Array.from([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01, 0x00]),
  'arraybuffer': () => new ArrayBuffer(8),
  'dataview': () => new DataView(new ArrayBuffer(8)),
  'int16array': () => new Int16Array([1, 2, 3]),
  'float64array': () => new Float64Array([0.5]),
  'buffer': () => Buffer.from('deadbeef', 'hex'),
  'nested-deep': () => ({ note: 'derived', list: [1, 'two', { deeper: [{ ok: true }, new Uint8Array([7, 8]) ] }] }),
  'wrapped-field': () => ({ capturedBytes: Uint8Array.from([0x7f, 0x45]) }),
  'map-entry': () => new Map([['bytes', new Uint8Array([1, 2])]]),
  'set-entry': () => new Set([new Uint8Array([3])]),
  'byte-backing': () => ({ __binaryByteBacking: true, size: 4 }),
};

const cleanPayloads = {
  'string': 'main',
  'number': 42,
  'boolean': true,
  'null': null,
  'structured-metadata': { name: 'parse', confidence: 0.9, offsets: [16, 32, 48], tags: ['entry', 'leaf'] },
  'nested-plain': { a: { b: [{ c: 'd' }] } },
};

function forgeEnvelope(payload, { messageId = 'message:9', sequence = 9, egress } = {}) {
  const operation = createProjectOperation({
    targetEntityId: 'finding:1', factKind: 'confirmation', action: 'set', payload, causalParents: [],
    projectIdentity: base.projectIdentity, binaryIdentity: base.binaryIdentity,
    authorIdentity: base.actorIdentity, deviceIdentity: base.deviceIdentity,
    provenance: { source: 'collaborator', transport: 'remote', actorIdentity: base.actorIdentity, deviceIdentity: base.deviceIdentity },
  });
  const envelope = {
    schemaVersion: REMOTE_COLLAB_SCHEMA,
    operationSchemaVersion: CHANGELOG_SCHEMA_VERSION,
    ...base,
    messageId, sequence,
    operations: [operation],
    transportProof: { authenticated: true, confidentiality: 'verified', integrity: 'verified', proofIdentity: 'proof:1' },
    egress: egress ?? { userAuthorized: true, rawBinaryBytes: false, derivedDataOnly: true },
  };
  return Object.freeze({ ...envelope, envelopeId: envelopeIdentity(envelope) });
}

function gate() {
  return new RemoteCollaborationGate({
    projectIdentity: base.projectIdentity, binaryIdentity: base.binaryIdentity, sessionIdentity: base.sessionIdentity,
    allowedActors: { [base.actorIdentity]: ['*'] },
    verifyTransportProof: () => true,
    transportVerifierIdentity: 'oracle:test',
  });
}

async function signedResponse(init) {
  const request = JSON.parse(init.body);
  const signed = {
    schemaVersion: REMOTE_CANONICAL_RESPONSE_SCHEMA,
    requestId: request.requestId,
    bindingDigest: request.bindingDigest,
    keyId: request.keyId,
  };
  const signature = await webcrypto.subtle.sign({ name: 'Ed25519' }, serverSigningKey, new TextEncoder().encode(stableStringify(signed)));
  return {
    ok: true, status: 200,
    headers: { get() { return null; } },
    text: async () => JSON.stringify({ ...signed, signature: Buffer.from(signature).toString('base64') }),
  };
}

function transportWith(recorder) {
  return new RemoteCanonicalHttpTransport({
    endpoint: 'http://127.0.0.1:9/collab', serverVerificationKey, sessionEncryptionKey, serverKeyId,
    fetchImpl: async (endpoint, init) => { recorder.push(init); return signedResponse(init); },
  });
}

for (const [name, make] of Object.entries(rawBytePayloads)) {
  assert.throws(
    () => createRemoteCollaborationEnvelope(inputWith(make())),
    (error) => error instanceof TypeError && error.message.includes('remote-raw-binary-egress-forbidden'),
    `envelope factory must reject raw-byte payload (${name})`,
  );
  assert.equal(
    gate().validate(forgeEnvelope(make())).reason,
    'remote-raw-binary-egress-forbidden',
    `gate must reject forged raw-byte payload envelope (${name})`,
  );
}

for (const [name, payload] of Object.entries(cleanPayloads)) {
  const envelope = createRemoteCollaborationEnvelope(inputWith(payload, { messageId: `message:clean:${name}`, sequence: 2 }));
  assert.equal(envelope.egress.rawBinaryBytes, false);
  assert.equal(gate().validate(envelope).ok, true, `gate must keep accepting derived payload (${name})`);
}

assert.equal(gate().validate(forgeEnvelope('main', { egress: { userAuthorized: true, rawBinaryBytes: true, derivedDataOnly: false } })).reason, 'remote-raw-binary-egress-forbidden');
assert.equal(gate().validate(forgeEnvelope(Uint8Array.from([1, 2]), { egress: { userAuthorized: true, rawBinaryBytes: true, derivedDataOnly: false } })).reason, 'remote-raw-binary-egress-forbidden');

{
  const sent = [];
  const transport = transportWith(sent);
  for (const [name, make] of Object.entries(rawBytePayloads)) {
    await assert.rejects(
      () => transport.authorizeEnvelope(inputWith(make(), { messageId: `message:bytes:${name}`, sequence: 3 })),
      (error) => String(error.message).includes('raw-binary-egress-forbidden'),
      `transport must reject raw-byte payload (${name})`,
    );
  }
  assert.equal(sent.length, 0, 'raw-byte payloads must never reach the remote endpoint request');
  const clean = await transport.authorizeEnvelope(inputWith({ name: 'parse', offsets: [16, 32] }, { messageId: 'message:transport:clean', sequence: 4 }));
  assert.equal(clean.egress.derivedDataOnly, true);
  assert.equal(sent.length, 1, 'genuine derived payload must still be transportable');
  const body = JSON.parse(sent[0].body);
  assert.equal(typeof body.ciphertext, 'string');
  assert.ok(!Buffer.from(body.ciphertext, 'base64').includes(Buffer.from([0x7f, 0x45])), 'ciphertext must not carry raw bytes in the clear');
}

console.log('issue-4964 raw-binary-egress classification regression passed');
