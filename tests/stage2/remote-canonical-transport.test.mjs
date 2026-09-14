import assert from 'node:assert/strict';
import http from 'node:http';
import { createDecipheriv, createHash, generateKeyPairSync, randomBytes, sign, webcrypto } from 'node:crypto';

import { stableStringify } from '../../js/core/identity/index.js';
import { RemoteCollaborationGate } from '../../js/collaboration/remote-authority.js';
import {
  REMOTE_CANONICAL_RESPONSE_SCHEMA,
  REMOTE_CANONICAL_TRANSPORT_SCHEMA,
  REMOTE_CANONICAL_TRANSPORT_VERIFIER_IDENTITY,
  RemoteCanonicalHttpTransport,
} from '../../js/collaboration/remote-transport.js';

const encoder = new TextEncoder();
const aesBytes = randomBytes(32);
const aesKey = await webcrypto.subtle.importKey('raw', aesBytes, { name:'AES-GCM' }, false, ['encrypt','decrypt']);
const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const publicSpki = publicKey.export({ type:'spki', format:'der' });
const browserPublicKey = await webcrypto.subtle.importKey('spki', publicSpki, { name:'Ed25519' }, false, ['verify']);
const serverKeyId = `ed25519:${createHash('sha256').update(publicSpki).digest('hex')}`;
const observedBindings = [];

function decode(value) { return Buffer.from(String(value), 'base64'); }
const server = http.createServer((request, response) => {
  const chunks = [];
  request.on('data', (chunk) => chunks.push(chunk));
  request.on('end', () => {
    try {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      assert.equal(body.schemaVersion, REMOTE_CANONICAL_TRANSPORT_SCHEMA);
      assert.equal(body.keyId, serverKeyId);
      const iv = decode(body.iv);
      const encrypted = decode(body.ciphertext);
      const tag = encrypted.subarray(encrypted.length - 16);
      const ciphertext = encrypted.subarray(0, encrypted.length - 16);
      const aes = createDecipheriv('aes-256-gcm', aesBytes, iv);
      aes.setAAD(Buffer.from(`${REMOTE_CANONICAL_TRANSPORT_SCHEMA}:${serverKeyId}`));
      aes.setAuthTag(tag);
      const plaintext = Buffer.concat([aes.update(ciphertext), aes.final()]);
      assert.equal(createHash('sha256').update(plaintext).digest('hex'), body.bindingDigest);
      const binding = JSON.parse(plaintext.toString('utf8'));
      assert.equal(binding.projectIdentity, 'project:canonical');
      assert.equal(binding.binaryIdentity, 'binary:canonical');
      assert.equal(binding.sessionIdentity, 'session:canonical');
      assert.equal(binding.actorIdentity, 'alice');
      observedBindings.push(binding);
      const signed = { schemaVersion:REMOTE_CANONICAL_RESPONSE_SCHEMA, requestId:body.requestId, bindingDigest:body.bindingDigest, keyId:serverKeyId };
      const signature = sign(null, encoder.encode(stableStringify(signed)), privateKey).toString('base64');
      response.writeHead(200, { 'content-type':'application/json' });
      response.end(JSON.stringify({ ...signed, signature }));
    } catch (error) {
      response.writeHead(400, { 'content-type':'application/json' });
      response.end(JSON.stringify({ error:String(error?.message || error) }));
    }
  });
});
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
const address = server.address();
assert.equal(typeof address, 'object');

try {
  const transport = new RemoteCanonicalHttpTransport({ endpoint:`http://127.0.0.1:${address.port}/collaboration`, serverVerificationKey:browserPublicKey, sessionEncryptionKey:aesKey, serverKeyId });
  assert.equal(transport.verifierIdentity, REMOTE_CANONICAL_TRANSPORT_VERIFIER_IDENTITY);
  const input = {
    projectIdentity:'project:canonical', binaryIdentity:'binary:canonical', sessionIdentity:'session:canonical',
    actorIdentity:'alice', deviceIdentity:'device:ipad', messageId:'message:1', sequence:1,
    operations:[{ operationId:'operation:1', targetEntityId:'function:1', factKind:'name', action:'set', payload:'main' }],
    egress:{ userAuthorized:true, rawBinaryBytes:false, derivedDataOnly:true },
  };
  const envelope = await transport.authorizeEnvelope(input);
  assert.equal(observedBindings.length, 1, 'real HTTP server decrypted exactly one bound request');
  assert.equal(transport.verifyTransportProof(envelope.transportProof, envelope), true);
  const gate = new RemoteCollaborationGate({
    projectIdentity:input.projectIdentity, binaryIdentity:input.binaryIdentity, sessionIdentity:input.sessionIdentity,
    allowedActors:{ alice:['*'] }, verifyTransportProof:transport.verifyTransportProof,
    transportVerifierIdentity:transport.verifierIdentity,
  });
  assert.deepEqual(gate.validate(envelope), { ok:true });
  assert.equal(gate.accept(envelope).status, 'accepted');
  assert.equal(gate.validate(envelope).reason, 'remote-replay-or-duplicate');
  assert.equal(transport.verifyTransportProof(envelope.transportProof, { ...envelope, actorIdentity:'mallory' }), false, 'verified proof cannot move to another actor');
  assert.equal(transport.verifyTransportProof(envelope.transportProof, { ...envelope, projectIdentity:'project:other' }), false, 'verified proof cannot move to another project');
  assert.equal(transport.verifyTransportProof({ ...envelope.transportProof, proofIdentity:'remote-transport-proof:forged' }, envelope), false);
  await assert.rejects(() => transport.send({ ...envelope, transportProof:{ ...envelope.transportProof, integrity:'unverified' } }), /remote-transport-unverified-envelope/);
  await assert.rejects(() => transport.authorizeEnvelope({ ...input, messageId:'message:raw', sequence:2, egress:{ ...input.egress, rawBinaryBytes:true, derivedDataOnly:false } }), /remote-transport-raw-binary-egress-forbidden/);
  await assert.rejects(() => transport.authorizeEnvelope({ ...input, messageId:'message:unauthorized', sequence:3, egress:{ ...input.egress, userAuthorized:false } }), /remote-transport-egress-authorization-required/);
  assert.equal(observedBindings.length, 1, 'forbidden egress never reaches the network transport');

  const wrongKeyPair = generateKeyPairSync('ed25519');
  const wrongPublic = await webcrypto.subtle.importKey('spki', wrongKeyPair.publicKey.export({ type:'spki', format:'der' }), { name:'Ed25519' }, false, ['verify']);
  const wrongTrust = new RemoteCanonicalHttpTransport({ endpoint:`http://127.0.0.1:${address.port}/collaboration`, serverVerificationKey:wrongPublic, sessionEncryptionKey:aesKey, serverKeyId });
  await assert.rejects(() => wrongTrust.authorizeEnvelope({ ...input, messageId:'message:wrong-key', sequence:2 }), /remote-transport-response-signature-rejected/);
} finally {
  await new Promise((resolve) => server.close(resolve));
}

console.log('[stage2] canonical encrypted remote transport and independent Ed25519 oracle passed');
