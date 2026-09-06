import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { stableStringify } from '../../../js/core/identity/index.js';
import {
  REMOTE_CANONICAL_RESPONSE_SCHEMA,
  RemoteCanonicalHttpTransport,
} from '../../../js/collaboration/remote-transport.js';

if (!globalThis.crypto) Object.defineProperty(globalThis, 'crypto', { value:webcrypto, configurable:true });

const encoder = new TextEncoder();
const { publicKey, privateKey } = await globalThis.crypto.subtle.generateKey({ name:'Ed25519' }, true, ['sign', 'verify']);
const sessionEncryptionKey = await globalThis.crypto.subtle.generateKey({ name:'AES-GCM', length:256 }, true, ['encrypt', 'decrypt']);

function input(sequence) {
  return {
    projectIdentity:'project:transport-identity',
    binaryIdentity:'binary:transport-identity',
    sessionIdentity:'session:transport-identity',
    actorIdentity:'alice',
    deviceIdentity:'device:alice',
    messageId:`message:${sequence}`,
    sequence,
    operations:[{ targetEntityId:'entity:1', factKind:'name', action:'set', payload:'value' }],
    egress:{ userAuthorized:true, rawBinaryBytes:false, derivedDataOnly:true },
  };
}

function base64(value) {
  return Buffer.from(value).toString('base64');
}

function signedFetch(mutate = (response) => response) {
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
    const response = mutate({ ...signed, signature:base64(signature) });
    return {
      ok:true,
      status:200,
      headers:{ get:() => null },
      body:null,
      text:async () => JSON.stringify(response),
    };
  };
}

function transport(overrides = {}) {
  return new RemoteCanonicalHttpTransport({
    endpoint:'https://collaboration.example.test/authorize',
    serverVerificationKey:publicKey,
    sessionEncryptionKey,
    serverKeyId:'server:key:1',
    fetchImpl:signedFetch(),
    ...overrides,
  });
}

assert.throws(
  () => transport({ endpoint:['https://collaboration.example.test/authorize'] }),
  /remote-transport-endpoint-required/,
);
assert.throws(
  () => transport({ serverKeyId:['server:key:1'] }),
  /remote-transport-server-key-id-required/,
);

let coercions = 0;
assert.throws(
  () => transport({ endpoint:{ toString() { coercions++; return 'https://collaboration.example.test/authorize'; } } }),
  /remote-transport-endpoint-required/,
);
assert.equal(coercions, 0, 'transport identity validation must not execute caller coercion hooks');

const trimmed = transport({
  endpoint:'  https://collaboration.example.test/authorize  ',
  serverKeyId:'  server:key:1  ',
});
assert.equal(trimmed.endpoint, 'https://collaboration.example.test/authorize');
assert.equal(trimmed.serverKeyId, 'server:key:1');

let sequence = 1;
for (const [field, code] of [
  ['requestId', 'remote-transport-response-request-id-required'],
  ['bindingDigest', 'remote-transport-response-binding-digest-required'],
  ['keyId', 'remote-transport-response-key-id-required'],
]) {
  const current = transport({
    fetchImpl:signedFetch((response) => ({ ...response, [field]:[response[field]] })),
  });
  await assert.rejects(
    () => current.authorizeEnvelope(input(sequence++)),
    new RegExp(code),
    `${field} must remain a primitive signed-response identity`,
  );
}

{
  const current = transport({
    fetchImpl:signedFetch((response) => ({ ...response, signature:[response.signature] })),
  });
  await assert.rejects(
    () => current.authorizeEnvelope(input(sequence++)),
    /remote-transport-response-signature-invalid/,
    'signature must not be coerced from a structured value',
  );
}

{
  const current = transport({ fetchImpl:signedFetch() });
  const envelope = await current.authorizeEnvelope(input(sequence++));
  assert.equal(current.verifyTransportProof(envelope.transportProof, envelope), true);
}

console.log('[phase12] remote transport identity boundary tests passed');
