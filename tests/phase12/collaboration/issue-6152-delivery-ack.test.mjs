import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash, generateKeyPairSync, sign, webcrypto } from 'node:crypto';

import { ChangeLog } from '../../../js/collaboration/index.js';
import { RemoteCollaborationChannel, RemoteCollaborationGate } from '../../../js/collaboration/remote-authority.js';
import {
  REMOTE_CANONICAL_DELIVERY_ACK_SCHEMA,
  REMOTE_CANONICAL_DELIVERY_SCHEMA,
  REMOTE_CANONICAL_RESPONSE_SCHEMA,
  REMOTE_CANONICAL_TRANSPORT_SCHEMA,
  RemoteCanonicalHttpTransport,
} from '../../../js/collaboration/remote-transport.js';
import { stableStringify } from '../../../js/core/identity/index.js';

if (!globalThis.crypto) Object.defineProperty(globalThis, 'crypto', { value:webcrypto, configurable:true });

const encoder = new TextEncoder();
const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const publicSpki = publicKey.export({ type:'spki', format:'der' });
const browserPublicKey = await webcrypto.subtle.importKey('spki', publicSpki, { name:'Ed25519' }, false, ['verify']);
const sessionEncryptionKey = await webcrypto.subtle.generateKey({ name:'AES-GCM', length:256 }, true, ['encrypt', 'decrypt']);
const serverKeyId = 'ed25519:' + createHash('sha256').update(publicSpki).digest('hex');
const INPUT = Object.freeze({
  projectIdentity:'project:6152',
  binaryIdentity:'binary:6152',
  sessionIdentity:'session:6152',
  actorIdentity:'alice',
  deviceIdentity:'device:6152',
  messageId:'message:6152',
  sequence:1,
  operations:[{ operationId:'operation:6152', targetEntityId:'entity:6152', factKind:'name', action:'set', payload:'main' }],
  egress:{ userAuthorized:true, rawBinaryBytes:false, derivedDataOnly:true },
});

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers:{ 'content-type':'application/json' } });
}

function signedAuthorization(body) {
  const signed = {
    schemaVersion:REMOTE_CANONICAL_RESPONSE_SCHEMA,
    requestId:body.requestId,
    bindingDigest:body.bindingDigest,
    keyId:serverKeyId,
  };
  const signature = sign(null, encoder.encode(stableStringify(signed)), privateKey).toString('base64');
  return { ...signed, signature };
}

function signedDeliveryAck(body, overrides = {}) {
  const signed = {
    schemaVersion:REMOTE_CANONICAL_DELIVERY_ACK_SCHEMA,
    requestId:body.requestId,
    envelopeId:body.envelopeId,
    bindingDigest:body.bindingDigest,
    status:'sent',
    keyId:serverKeyId,
    ...overrides,
  };
  const signature = sign(null, encoder.encode(stableStringify(signed)), privateKey).toString('base64');
  return { ...signed, signature };
}

function harness(deliveryHandler) {
  const calls = [];
  const fetchImpl = async (_url, init) => {
    const body = JSON.parse(init.body);
    calls.push(body);
    if (body.schemaVersion === REMOTE_CANONICAL_TRANSPORT_SCHEMA) return jsonResponse(signedAuthorization(body));
    if (body.schemaVersion === REMOTE_CANONICAL_DELIVERY_SCHEMA) return deliveryHandler(body, calls);
    throw new Error('unexpected-transport-schema:' + body.schemaVersion);
  };
  const transport = new RemoteCanonicalHttpTransport({
    endpoint:'https://collaboration.example.test/transport',
    serverVerificationKey:browserPublicKey,
    sessionEncryptionKey,
    serverKeyId,
    fetchImpl,
  });
  return { transport, calls };
}

function channelFor(transport) {
  const gate = new RemoteCollaborationGate({
    projectIdentity:INPUT.projectIdentity,
    binaryIdentity:INPUT.binaryIdentity,
    sessionIdentity:INPUT.sessionIdentity,
    allowedActors:{ alice:['*'] },
    verifyTransportProof:transport.verifyTransportProof,
    transportVerifierIdentity:transport.verifierIdentity,
  });
  const log = new ChangeLog({ projectIdentity:INPUT.projectIdentity });
  return new RemoteCollaborationChannel({ gate, log, transport });
}

function fakeChannel(transportResult) {
  const gate = new RemoteCollaborationGate({
    projectIdentity:'project:6152-fake',
    sessionIdentity:'session:6152-fake',
    allowedActors:{ actor:['write'] },
    verifyTransportProof:() => true,
  });
  const snapshot = Object.freeze({ envelopeId:'envelope:6152-fake' });
  gate.validate = () => ({ ok:true });
  gate.validatedSnapshot = () => snapshot;
  const log = new ChangeLog({ projectIdentity:'project:6152-fake' });
  const transport = {
    send:async (envelope) => {
      assert.equal(envelope, snapshot);
      return transportResult;
    },
  };
  return new RemoteCollaborationChannel({ gate, log, transport });
}

test('#6152: authorization alone is not delivery, and send performs delivery I/O', async () => {
  const { transport, calls } = harness(() => jsonResponse({ schemaVersion:REMOTE_CANONICAL_RESPONSE_SCHEMA }));
  const envelope = await transport.authorizeEnvelope(INPUT);
  assert.equal(calls.length, 1, 'authorization must be the only request before channel.send');
  const result = await channelFor(transport).send(envelope);
  assert.deepEqual(result, { status:'rejected', reason:'remote-transport-delivery-unconfirmed', envelopeId:envelope.envelopeId });
  assert.equal(calls[1].schemaVersion, REMOTE_CANONICAL_DELIVERY_SCHEMA);
  assert.equal(calls.length, 2, 'channel.send must invoke a second delivery operation');
  assert.equal(calls[1].schemaVersion, REMOTE_CANONICAL_DELIVERY_SCHEMA);
});

test('#6152: network or delivery failure never reports sent', async () => {
  const { transport, calls } = harness(() => { throw new Error('delivery-network-down'); });
  const envelope = await transport.authorizeEnvelope(INPUT);
  const result = await channelFor(transport).send(envelope);
  assert.deepEqual(result, { status:'rejected', reason:'remote-transport-delivery-unconfirmed', envelopeId:envelope.envelopeId });
  assert.equal(calls.length, 2);
});

test('#6152: HTTP delivery failure is normalized to delivery-unconfirmed rejection', async () => {
  const { transport, calls } = harness(() => jsonResponse({ error:'delivery-unavailable' }, 503));
  const envelope = await transport.authorizeEnvelope(INPUT);
  const result = await channelFor(transport).send(envelope);
  assert.deepEqual(result, { status:'rejected', reason:'remote-transport-delivery-unconfirmed', envelopeId:envelope.envelopeId });
  assert.equal(calls.length, 2);
  assert.notEqual(result.status, 'sent');
});

test('#6152: delivery acknowledgement identity mismatch is rejected', async () => {
  const { transport } = harness((body) => jsonResponse(signedDeliveryAck(body, { envelopeId:'envelope:other' })));
  const envelope = await transport.authorizeEnvelope(INPUT);
  const result = await channelFor(transport).send(envelope);
  assert.deepEqual(result, { status:'rejected', reason:'remote-transport-delivery-unconfirmed', envelopeId:envelope.envelopeId });
});

test('#6152: invalid delivery acknowledgement signature is normalized to rejection', async () => {
  const { transport, calls } = harness((body) => {
    const ack = signedDeliveryAck(body);
    return jsonResponse({ ...ack, signature:'AAAA' });
  });
  const envelope = await transport.authorizeEnvelope(INPUT);
  const result = await channelFor(transport).send(envelope);
  assert.deepEqual(result, { status:'rejected', reason:'remote-transport-delivery-unconfirmed', envelopeId:envelope.envelopeId });
  assert.equal(calls.length, 2);
  assert.notEqual(result.status, 'sent');
});

test('#6152: only a matching signed delivery acknowledgement reports sent', async () => {
  const { transport, calls } = harness((body) => jsonResponse(signedDeliveryAck(body)));
  const envelope = await transport.authorizeEnvelope(INPUT);
  const result = await channelFor(transport).send(envelope);
  assert.deepEqual(result, { status:'sent', envelopeId:envelope.envelopeId });
  assert.equal(calls.length, 2);
  assert.equal(calls[1].envelope.envelopeId, envelope.envelopeId);
});

test('#6152: verification-only transport result is never promoted to sent', async () => {
  const result = await fakeChannel({ status:'verified-and-authorized-for-channel-send', envelopeId:'envelope:6152-fake' }).send({ envelopeId:'caller-envelope' });
  assert.deepEqual(result, { status:'rejected', reason:'remote-transport-delivery-unconfirmed', envelopeId:'envelope:6152-fake' });
});
