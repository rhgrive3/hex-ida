// Issue #8925 regression: delivery send() must share the bounded lifetime
// authority of authorizeEnvelope(). A stalled fetch or stalled ACK body must
// deterministically reject as delivery-unconfirmed, never pend forever.
import assert from 'node:assert/strict';
import test from 'node:test';
import { Buffer } from 'node:buffer';
import { createHash, generateKeyPairSync, sign, webcrypto } from 'node:crypto';

import { ChangeLog } from '../js/collaboration/index.js';
import { RemoteCollaborationChannel, RemoteCollaborationGate } from '../js/collaboration/remote-authority.js';
import {
  REMOTE_CANONICAL_DELIVERY_ACK_SCHEMA,
  REMOTE_CANONICAL_DELIVERY_SCHEMA,
  REMOTE_CANONICAL_RESPONSE_SCHEMA,
  REMOTE_CANONICAL_TRANSPORT_SCHEMA,
  RemoteCanonicalHttpTransport,
} from '../js/collaboration/remote-transport.js';
import { stableStringify } from '../js/core/identity/index.js';

if (!globalThis.crypto) Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });

const encoder = new TextEncoder();
const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const publicSpki = publicKey.export({ type: 'spki', format: 'der' });
const browserPublicKey = await webcrypto.subtle.importKey('spki', publicSpki, { name: 'Ed25519' }, false, ['verify']);
const sessionEncryptionKey = await webcrypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
const serverKeyId = 'ed25519:' + createHash('sha256').update(publicSpki).digest('hex');
const INPUT = Object.freeze({
  projectIdentity: 'project:8925',
  binaryIdentity: 'binary:8925',
  sessionIdentity: 'session:8925',
  actorIdentity: 'alice',
  deviceIdentity: 'device:8925',
  messageId: 'message:8925',
  sequence: 1,
  operations: [{ operationId: 'operation:8925', targetEntityId: 'entity:8925', factKind: 'name', action: 'set', payload: 'main' }],
  egress: { userAuthorized: true, rawBinaryBytes: false, derivedDataOnly: true },
});

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
}

function signedAuthorization(body) {
  const signed = {
    schemaVersion: REMOTE_CANONICAL_RESPONSE_SCHEMA,
    requestId: body.requestId,
    bindingDigest: body.bindingDigest,
    keyId: serverKeyId,
  };
  return { ...signed, signature: sign(null, encoder.encode(stableStringify(signed)), privateKey).toString('base64') };
}

function harness(deliveryHandler, transportOptions = {}) {
  const seen = [];
  const fetchImpl = async (_url, init) => {
    const body = JSON.parse(init.body);
    seen.push({ schema: body.schemaVersion, signal: init?.signal ?? null });
    if (body.schemaVersion === REMOTE_CANONICAL_TRANSPORT_SCHEMA) return jsonResponse(signedAuthorization(body));
    if (body.schemaVersion === REMOTE_CANONICAL_DELIVERY_SCHEMA) return deliveryHandler(body, init);
    throw new Error('unexpected-transport-schema:' + body.schemaVersion);
  };
  const transport = new RemoteCanonicalHttpTransport({
    endpoint: 'https://collaboration.example.test/transport',
    serverVerificationKey: browserPublicKey,
    sessionEncryptionKey,
    serverKeyId,
    fetchImpl,
    ...transportOptions,
  });
  return { transport, seen };
}

function channelFor(transport) {
  const gate = new RemoteCollaborationGate({
    projectIdentity: INPUT.projectIdentity,
    binaryIdentity: INPUT.binaryIdentity,
    sessionIdentity: INPUT.sessionIdentity,
    allowedActors: { alice: ['*'] },
    verifyTransportProof: transport.verifyTransportProof,
    transportVerifierIdentity: transport.verifierIdentity,
  });
  return new RemoteCollaborationChannel({ gate, log: new ChangeLog({ projectIdentity: INPUT.projectIdentity }), transport });
}

test('#8925 stalled delivery fetch rejects via timeout instead of pending', async () => {
  const { transport, seen } = harness(() => new Promise(() => {}));
  const envelope = await transport.authorizeEnvelope(INPUT);
  await assert.rejects(
    () => transport.send(envelope, { timeoutMs: 50 }),
    (error) => error?.code === 'remote-transport-authorization-timeout',
  );
  const delivery = seen.find((entry) => entry.schema === REMOTE_CANONICAL_DELIVERY_SCHEMA);
  assert.ok(delivery?.signal instanceof AbortSignal, 'delivery fetch must receive an abort signal');
});

test('#8925 stalled delivery normalizes to delivery-unconfirmed, never sent', async () => {
  const { transport } = harness(() => new Promise(() => {}), { authorizationTimeoutMs: 300 });
  const envelope = await transport.authorizeEnvelope(INPUT);
  const result = await channelFor(transport).send(envelope);
  assert.deepEqual(result, { status: 'rejected', reason: 'remote-transport-delivery-unconfirmed', envelopeId: envelope.envelopeId });
});

test('#8925 pre-aborted caller signal rejects delivery immediately', async () => {
  let fetchEntered = false;
  const { transport } = harness(() => { fetchEntered = true; return new Promise(() => {}); });
  const envelope = await transport.authorizeEnvelope(INPUT);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(() => transport.send(envelope, { signal: controller.signal, timeoutMs: 5000 }));
  assert.equal(fetchEntered, false, 'aborted delivery must not issue network I/O');
});

test('#8925 stalled ACK body stream is bounded by the same deadline', async () => {
  const { transport } = harness(() => {
    const stream = new ReadableStream({ start() {} });
    return new Response(stream, { status: 200, headers: { 'content-type': 'application/json' } });
  });
  const envelope = await transport.authorizeEnvelope(INPUT);
  await assert.rejects(
    () => transport.send(envelope, { timeoutMs: 50 }),
    (error) => error?.code === 'remote-transport-authorization-timeout',
  );
});

test('#8925 delivery options contract rejects non-object options', async () => {
  const { transport } = harness(() => { throw new Error('must-not-run'); });
  const envelope = await transport.authorizeEnvelope(INPUT);
  await assert.rejects(() => transport.send(envelope, 'x'), /remote-transport-delivery-options-invalid/);
});
