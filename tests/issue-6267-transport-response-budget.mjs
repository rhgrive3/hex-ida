import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, webcrypto } from 'node:crypto';

import {
  REMOTE_CANONICAL_RESPONSE_SCHEMA,
  RemoteCanonicalHttpTransport,
} from '../js/collaboration/remote-transport.js';

const { publicKey } = generateKeyPairSync('ed25519');
const browserPublicKey = await webcrypto.subtle.importKey('spki', publicKey.export({ type: 'spki', format: 'der' }), { name: 'Ed25519' }, false, ['verify']);
const aesKey = await webcrypto.subtle.importKey('raw', new Uint8Array(32).fill(7), { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
const serverKeyId = 'ed25519:test';

function transport(overrides = {}) {
  return new RemoteCanonicalHttpTransport({
    endpoint: 'https://collab.example/transport',
    serverVerificationKey: browserPublicKey,
    sessionEncryptionKey: aesKey,
    serverKeyId,
    fetchImpl: async () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }),
    ...overrides,
  });
}

const input = {
  projectIdentity: 'project:1', binaryIdentity: 'binary:1', sessionIdentity: 'session:1',
  actorIdentity: 'alice', deviceIdentity: 'device:1', messageId: 'message:1', sequence: 1,
  operations: [{ operationId: 'operation:1', targetEntityId: 'function:1', factKind: 'name', action: 'set', payload: 'main' }],
  egress: { userAuthorized: true, rawBinaryBytes: false, derivedDataOnly: true },
};

test('#6267 oversized Content-Length response is rejected before body read', async () => {
  let bodyRead = false;
  const huge = new Response('x'.repeat(16), {
    status: 200,
    headers: { 'content-type': 'application/json', 'content-length': String(512 * 1024 * 1024) },
  });
  const original = huge.text.bind(huge);
  huge.text = async () => { bodyRead = true; return original(); };
  const bounded = transport({ fetchImpl: async () => huge });
  await assert.rejects(() => bounded.authorizeEnvelope(input), /remote-transport-response-budget-exceeded/);
  assert.equal(bodyRead, false, 'body must not be materialized when Content-Length exceeds the budget');
});

test('#6267 streamed oversized response is cancelled at the byte budget without full materialization', async () => {
  const chunk = new Uint8Array(1024).fill(0x78);
  let delivered = 0;
  let cancelled = false;
  const stream = new ReadableStream({
    pull(controller) {
      if (cancelled) return;
      if (delivered >= 256 * 1024) { controller.close(); return; }
      delivered += chunk.byteLength;
      controller.enqueue(chunk);
    },
    cancel() { cancelled = true; },
  });
  const response = new Response(stream, { status: 200, headers: { 'content-type': 'application/json' } });
  const bounded = transport({ maxResponseBytes: 64 * 1024, fetchImpl: async () => response });
  await assert.rejects(() => bounded.authorizeEnvelope(input), /remote-transport-response-budget-exceeded/);
  assert.equal(delivered <= 128 * 1024, true, 'reader must stop close to the budget instead of draining the stream');
  assert.equal(cancelled, true, 'stream must be cancelled once the budget is exceeded');
});

test('#6267 compact valid-schema response still parses and reaches signature validation', async () => {
  const response = new Response(JSON.stringify({ schemaVersion: REMOTE_CANONICAL_RESPONSE_SCHEMA, requestId: 'r', bindingDigest: 'd', keyId: serverKeyId, signature: 'AAAA' }), {
    status: 200,
    headers: { 'content-type': 'application/json', 'content-length': '128' },
  });
  const bounded = transport({ fetchImpl: async () => response });
  await assert.rejects(() => bounded.authorizeEnvelope(input), /remote-transport-response-(identity-mismatch|signature-invalid|signature-rejected)/);
});

test('#6267 malformed JSON within budget fails closed as remote-transport-response-json-invalid', async () => {
  const response = new Response('not-json', { status: 200, headers: { 'content-type': 'application/json' } });
  const bounded = transport({ fetchImpl: async () => response });
  await assert.rejects(() => bounded.authorizeEnvelope(input), /remote-transport-response-json-invalid/);
});

test('#6267 invalid maxResponseBytes config is rejected', () => {
  assert.throws(() => transport({ maxResponseBytes: 0 }), /remote-transport-response-budget-invalid/);
  assert.throws(() => transport({ maxResponseBytes: -5 }), /remote-transport-response-budget-invalid/);
  assert.throws(() => transport({ maxResponseBytes: 1.5 }), /remote-transport-response-budget-invalid/);
});
