import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { stableStringify } from '../../../js/core/identity/index.js';
import {
  REMOTE_CANONICAL_RESPONSE_SCHEMA,
  RemoteCanonicalHttpTransport,
  remoteCanonicalTransportBinding,
} from '../../../js/collaboration/remote-transport.js';
import { createRemoteCollaborationEnvelope } from '../../../js/collaboration/remote-authority.js';

// #8819: the canonical transport proof bound a signature/cache to a *lossy*
// stableStringify() projection of the operation batch (bigint→"1", NaN→null,
// Date→ISO string, view→numeric array), so a proof authorized for one canonical
// envelope also verified a type-distinct envelope. The transport binding must use
// the same type-sensitive canonical identity the collaboration operation layer
// already uses, so every one of authorize / proof-cache / verify / delivery agree.

if (!globalThis.crypto) Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });

const encoder = new TextEncoder();
const base64 = (value) => Buffer.from(value).toString('base64');
const { publicKey, privateKey } = await globalThis.crypto.subtle.generateKey({ name:'Ed25519' }, true, ['sign', 'verify']);
const sessionEncryptionKey = await globalThis.crypto.subtle.generateKey({ name:'AES-GCM', length:256 }, true, ['encrypt', 'decrypt']);

const fetchImpl = async (_url, init) => {
  const request = JSON.parse(init.body);
  const signed = {
    schemaVersion:REMOTE_CANONICAL_RESPONSE_SCHEMA,
    requestId:request.requestId,
    bindingDigest:request.bindingDigest,
    keyId:request.keyId,
  };
  const signature = new Uint8Array(await globalThis.crypto.subtle.sign(
    { name:'Ed25519' }, privateKey, encoder.encode(stableStringify(signed)),
  ));
  const response = { ...signed, signature:base64(signature) };
  return { ok:true, status:200, headers:{ get:() => null }, body:null, text:async () => JSON.stringify(response) };
};

function transport() {
  return new RemoteCanonicalHttpTransport({
    endpoint:'https://collaboration.example.test/authorize',
    serverVerificationKey:publicKey,
    sessionEncryptionKey,
    serverKeyId:'server:key:1',
    fetchImpl,
  });
}

let sequence = 1;
const envelopeInput = (value) => ({
  projectIdentity:'project:type-alias',
  binaryIdentity:'binary:type-alias',
  sessionIdentity:'session:type-alias',
  actorIdentity:'alice',
  deviceIdentity:'device:alice',
  messageId:`message:${sequence}`,
  sequence:sequence,
  operations:[{ operationId:`op:${sequence}`, targetEntityId:'fn:1', factKind:'confirmation', action:'set', payload:{ value } }],
  egress:{ userAuthorized:true, rawBinaryBytes:false, derivedDataOnly:true },
});

// Helper: authorize an envelope carrying `authorizedValue`, then re-target the SAME
// transport proof onto a type-distinct `alteredValue` payload and report whether the
// transport still accepts it. Also returns whether the *legacy* lossy projection
// still collapses them, to bind the assertion to the exact root cause.
async function retarget(authorizedValue, alteredValue) {
  const current = transport();
  const authorized = await current.authorizeEnvelope(envelopeInput(authorizedValue));
  const altered = createRemoteCollaborationEnvelope({
    ...envelopeInput(alteredValue),
    transportProof:authorized.transportProof,
  });
  sequence += 1;
  return {
    legacyCollapse: stableStringify(remoteCanonicalTransportBinding(authorized))
      === stableStringify(remoteCanonicalTransportBinding(altered)),
    envelopeIdsDiffer: authorized.envelopeId !== altered.envelopeId,
    accepted: current.verifyTransportProof(altered.transportProof, altered),
    validStillVerifies: current.verifyTransportProof(authorized.transportProof, authorized),
  };
}

// 1. BigInt vs string (the reported counterexample).
{
  const r = await retarget(1n, '1');
  assert.equal(r.legacyCollapse, true, 'root cause: the bare projection must still collapse 1n and "1"');
  assert.equal(r.envelopeIdsDiffer, true, 'the operation identity layer already distinguishes them');
  assert.equal(r.accepted, false, 'the transport proof must NOT authorize the type-distinct envelope');
  assert.equal(r.validStillVerifies, true, 'the legitimately authorized envelope still verifies');
}

// 2. Non-finite number vs null (jsonSafe collapses both to null).
{
  const r = await retarget(Number.NaN, null);
  assert.equal(r.accepted, false, 'NaN-authorized proof must not bind a null payload');
  assert.equal(r.validStillVerifies, true);
}

// 3. Date vs its own ISO string (jsonSafe canonicalizes both to the ISO text).
{
  const iso = '2026-09-14T00:00:00.000Z';
  const r = await retarget(new Date(iso), iso);
  assert.equal(r.accepted, false, 'a Date-authorized proof must not bind an equal-looking ISO string');
  assert.equal(r.validStillVerifies, true);
}

// 4. Regression safety: an all-plain (no lossy type) payload still binds and
//    verifies (the type witness is only added when a distinction exists), and the
//    binding is stable across repeated verification of the same envelope.
{
  const current = transport();
  const authorized = await current.authorizeEnvelope(envelopeInput({ text:'hello', count:3, flag:true }));
  sequence += 1;
  assert.equal(current.verifyTransportProof(authorized.transportProof, authorized), true);
  assert.equal(current.verifyTransportProof(authorized.transportProof, authorized), true, 'verification must be idempotent for the same canonical identity');
}

process.stdout.write('[phase12] issue-8819 remote transport type-sensitive binding tests passed\n');
