// Regression for #6006: RemoteCanonicalHttpTransport.authorizeEnvelope()
// awaited its fetchImpl without a timeout or abort path, so a custom fetch
// implementation (or network stack) that never settled kept this public
// operation pending forever. The transport now bounds the authorization
// request with its own timeout and rejects fail-closed.
import assert from 'node:assert/strict';
import { generateKeyPairSync, webcrypto } from 'node:crypto';
import { RemoteCanonicalHttpTransport } from '../js/collaboration/remote-transport.js';

const { publicKey } = generateKeyPairSync('ed25519');
const serverVerificationKey = await webcrypto.subtle.importKey('spki', publicKey.export({ type: 'spki', format: 'der' }), { name: 'Ed25519' }, false, ['verify']);
const sessionEncryptionKey = await webcrypto.subtle.importKey('raw', new Uint8Array(32).fill(7), { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
const serverKeyId = 'ed25519:test';

const input = {
  projectIdentity: 'project:1', binaryIdentity: 'binary:1', sessionIdentity: 'session:1',
  actorIdentity: 'alice', deviceIdentity: 'device:1', messageId: 'message:1', sequence: 1,
  operations: [{ operationId: 'operation:1', targetEntityId: 'function:1', factKind: 'name', action: 'set', payload: 'main' }],
  egress: { userAuthorized: true, rawBinaryBytes: false, derivedDataOnly: true },
};

{
  // The issue's repro shape: a fetchImpl that never settles must not keep
  // authorization pending forever — the transport's own timeout rejects.
  const transport = new RemoteCanonicalHttpTransport({
    endpoint: 'https://collab.example/transport',
    serverVerificationKey, sessionEncryptionKey, serverKeyId,
    authorizationTimeoutMs: 50,
    fetchImpl() { return new Promise(() => {}); },
  });
  const started = Date.now();
  await assert.rejects(
    transport.authorizeEnvelope(input),
    (error) => /remote-transport-authorization-timeout/.test(error?.message || ''),
    'a never-settling fetchImpl must not keep authorization pending forever',
  );
  assert.ok(Date.now() - started < 5000, 'the timeout fires promptly instead of hanging');
}

{
  // The timeout option is validated at construction.
  assert.throws(
    () => new RemoteCanonicalHttpTransport({
      endpoint: 'https://collab.example/transport',
      serverVerificationKey, sessionEncryptionKey, serverKeyId,
      authorizationTimeoutMs: 0,
      fetchImpl: () => new Promise(() => {}),
    }),
    /remote-transport-authorization-timeout-invalid/,
  );
}


{
  // A resolved fetch is not sufficient: the authorization deadline must also
  // cover a response body reader that never settles, and cancel that reader.
  let cancelled = 0;
  let unhandledRejections = 0;
  const onUnhandledRejection = () => { unhandledRejections += 1; };
  const response = {
    ok: true,
    status: 200,
    headers: { get() { return null; } },
    body: {
      getReader() {
        return {
          read() { return new Promise(() => {}); },
          cancel() {
            cancelled += 1;
            return Promise.reject(new Error('reader-cancel-failed'));
          },
        };
      },
    },
  };
  const transport = new RemoteCanonicalHttpTransport({
    endpoint: 'https://collab.example/transport',
    serverVerificationKey, sessionEncryptionKey, serverKeyId,
    authorizationTimeoutMs: 50,
    fetchImpl: async () => response,
  });
  process.on('unhandledRejection', onUnhandledRejection);
  try {
    await assert.rejects(
      transport.authorizeEnvelope(input),
      (error) => /remote-transport-authorization-timeout/.test(error?.message || ''),
      'a non-settling response body must not keep authorization pending',
    );
    await new Promise((resolve) => setImmediate(resolve));
  } finally {
    process.off('unhandledRejection', onUnhandledRejection);
  }
  assert.equal(cancelled, 1, 'authorization timeout must cancel the response reader');
  assert.equal(unhandledRejections, 0, 'reader cancellation rejection must be absorbed');
}

// A response that already exceeds the body budget must return the budget error
// even when reader.cancel() itself never settles.
{
  let cancelled = 0;
  const response = {
    ok: true,
    status: 200,
    headers: { get() { return null; } },
    body: {
      getReader() {
        return {
          read() { return Promise.resolve({ done: false, value: new Uint8Array(1024) }); },
          cancel() { cancelled += 1; return new Promise(() => {}); },
        };
      },
    },
  };
  const transport = new RemoteCanonicalHttpTransport({
    endpoint: 'https://collab.example/transport',
    serverVerificationKey, sessionEncryptionKey, serverKeyId,
    maxResponseBytes: 32,
    authorizationTimeoutMs: 1000,
    fetchImpl: async () => response,
  });
  const started = Date.now();
  await assert.rejects(
    transport.authorizeEnvelope(input),
    /remote-transport-response-budget-exceeded/,
    'body-budget rejection must not wait for reader cancellation',
  );
  assert.equal(cancelled, 1, 'body-budget rejection must attempt to cancel the reader');
  assert.ok(Date.now() - started < 200, 'body-budget rejection must remain prompt');
}
