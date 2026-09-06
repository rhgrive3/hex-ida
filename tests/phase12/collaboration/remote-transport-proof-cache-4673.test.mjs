import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { stableStringify } from '../../../js/core/identity/index.js';
import { RemoteCollaborationGate, createRemoteCollaborationEnvelope } from '../../../js/collaboration/remote-authority.js';
import {
  REMOTE_CANONICAL_RESPONSE_SCHEMA,
  RemoteCanonicalHttpTransport,
  remoteCanonicalTransportBinding,
} from '../../../js/collaboration/remote-transport.js';

if (!globalThis.crypto) Object.defineProperty(globalThis, 'crypto', { value:webcrypto, configurable:true });

const encoder = new TextEncoder();
const proofIdentityBytes = encoder.encode(`remote-transport-proof:${'0'.repeat(64)}`).byteLength;
const { publicKey, privateKey } = await globalThis.crypto.subtle.generateKey({ name:'Ed25519' }, true, ['sign', 'verify']);
const sessionEncryptionKey = await globalThis.crypto.subtle.generateKey({ name:'AES-GCM', length:256 }, true, ['encrypt', 'decrypt']);

function input(sequence, payload = 'value') {
  return {
    projectIdentity:'project:proof-cache',
    binaryIdentity:'binary:proof-cache',
    sessionIdentity:'session:proof-cache',
    actorIdentity:'alice',
    deviceIdentity:'device:alice',
    messageId:`message:${sequence}`,
    sequence,
    operations:[{ targetEntityId:'entity:1', factKind:'name', action:'set', payload }],
    egress:{ userAuthorized:true, rawBinaryBytes:false, derivedDataOnly:true },
  };
}

function retainedBindingBytes(value) {
  const provisional = createRemoteCollaborationEnvelope({
    ...value,
    transportProof:{ authenticated:false, confidentiality:'unverified', integrity:'unverified' },
  });
  return proofIdentityBytes + encoder.encode(stableStringify(remoteCanonicalTransportBinding(provisional))).byteLength;
}

function base64(value) {
  return Buffer.from(value).toString('base64');
}

function fetchImpl() {
  return async (_url, init) => {
    const request = JSON.parse(init.body);
    const signed = {
      schemaVersion:REMOTE_CANONICAL_RESPONSE_SCHEMA,
      requestId:request.requestId,
      bindingDigest:request.bindingDigest,
      keyId:request.keyId,
    };
    const signature = new Uint8Array(await globalThis.crypto.subtle.sign(
      { name:'Ed25519' },
      privateKey,
      encoder.encode(stableStringify(signed)),
    ));
    return {
      ok:true,
      status:200,
      headers:{ get:() => null },
      body:null,
      text:async () => JSON.stringify({ ...signed, signature:base64(signature) }),
    };
  };
}

function transport(overrides = {}) {
  return new RemoteCanonicalHttpTransport({
    endpoint:'https://collaboration.example.test/authorize',
    serverVerificationKey:publicKey,
    sessionEncryptionKey,
    serverKeyId:'server:key:1',
    fetchImpl:fetchImpl(),
    ...overrides,
  });
}

{
  const current = transport({ maxVerifiedBindings:2, maxVerifiedBindingBytes:1024 * 1024 });
  const first = await current.authorizeEnvelope(input(1));
  const second = await current.authorizeEnvelope(input(2));
  assert.equal(current.verifyTransportProof(first.transportProof, first), true);
  const third = await current.authorizeEnvelope(input(3));

  assert.equal(current.verifyTransportProof(first.transportProof, first), false, 'least-recently-used proof must be evicted at the count bound');
  assert.equal(current.verifyTransportProof(second.transportProof, second), true);
  assert.equal(current.verifyTransportProof(third.transportProof, third), true);

  const gate = new RemoteCollaborationGate({
    projectIdentity:'project:proof-cache',
    binaryIdentity:'binary:proof-cache',
    sessionIdentity:'session:proof-cache',
    allowedActors:{ alice:['*'] },
    verifyTransportProof:current.verifyTransportProof,
    transportVerifierIdentity:current.verifierIdentity,
  });
  assert.deepEqual(gate.validate(third), { ok:true });
  assert.equal(gate.accept(third).status, 'accepted', 'validate -> accept must survive repeated proof verification');

  current.dispose();
  assert.equal(current.verifyTransportProof(third.transportProof, third), false, 'dispose must release retained proof authority');
}

{
  const firstInput = input(10, 'x'.repeat(256));
  const secondInput = input(11, 'x'.repeat(256));
  const byteBudget = Math.max(retainedBindingBytes(firstInput), retainedBindingBytes(secondInput));
  const current = transport({ maxVerifiedBindings:32, maxVerifiedBindingBytes:byteBudget });
  const first = await current.authorizeEnvelope(firstInput);
  const second = await current.authorizeEnvelope(secondInput);
  assert.equal(current.verifyTransportProof(first.transportProof, first), false, 'byte budget must evict an older retained binding');
  assert.equal(current.verifyTransportProof(second.transportProof, second), true);

  const oversized = input(12, 'y'.repeat(2048));
  const tooSmall = transport({ maxVerifiedBindings:32, maxVerifiedBindingBytes:retainedBindingBytes(oversized) - 1 });
  await assert.rejects(() => tooSmall.authorizeEnvelope(oversized), /remote-transport-proof-binding-budget-exceeded/);
}

for (const [key, value, code] of [
  ['maxVerifiedBindings', 0, 'remote-transport-proof-cache-count-invalid'],
  ['maxVerifiedBindings', 1.5, 'remote-transport-proof-cache-count-invalid'],
  ['maxVerifiedBindingBytes', 0, 'remote-transport-proof-cache-bytes-invalid'],
  ['maxVerifiedBindingBytes', '1024', 'remote-transport-proof-cache-bytes-invalid'],
]) {
  assert.throws(() => transport({ [key]:value }), new RegExp(code));
}

console.log('[phase12] remote transport verified proof cache tests passed');
