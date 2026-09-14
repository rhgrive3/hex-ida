import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

// Load worker-entry.js the same bounded, headless way the #6261 runtime-worker
// test does: stub `cloudflare:workers` (DurableObject) and the runtime secrets,
// so the ingress boundary can be exercised against a real Request without a
// Cloudflare runtime.
register('data:text/javascript,' + encodeURIComponent(`
const runtimeSecrets = ${JSON.stringify(`export const RUNTIME_BUILD = Object.freeze({
  manifest: Object.freeze({ buildId: 'phase9-test-build', assetPath: '/.runtime/runtime.test.bin', byteLength: 0 }),
  signingKey: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
});`)};
export function resolve(specifier, context, nextResolve) {
  if (specifier === 'cloudflare:workers') {
    return { url: 'data:text/javascript,export class DurableObject {}', shortCircuit: true };
  }
  if (specifier.endsWith('.runtime-build/runtime-secrets.js')) {
    return { url: 'data:text/javascript,' + encodeURIComponent(runtimeSecrets), shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
`));

const { default: worker } = await import('../../../worker-entry.js');

const WORKER_ORIGIN = 'https://ida.rhgrive.workers.dev';
const ALLOWED_ORIGIN = 'https://chatgpt.com';
const BOOTSTRAP_MAX_BYTES = 16 * 1024;

function post(path, { body, headers = {} } = {}) {
  return worker.fetch(new Request(`${WORKER_ORIGIN}${path}`, {
    method: 'POST',
    body,
    headers: { origin: ALLOWED_ORIGIN, ...headers },
    duplex: 'half',
  }), {});
}

// A lazily-produced streaming body that records how many bytes the consumer
// actually pulled. If the endpoint materializes the whole body before enforcing
// the cap, `producedBytes` reaches the full total; the #8703 fix must stop near
// the byte boundary.
function countingStream(totalBytes, chunkBytes = 1024) {
  const state = { producedBytes: 0, cancelCount: 0 };
  const stream = new ReadableStream({
    pull(controller) {
      const remaining = totalBytes - state.producedBytes;
      if (remaining <= 0) { controller.close(); return; }
      const size = Math.min(chunkBytes, remaining);
      state.producedBytes += size;
      controller.enqueue(new Uint8Array(size));
    },
    cancel() { state.cancelCount += 1; },
  });
  return { stream, state };
}

test('#8703 stage A: an oversized body with no Content-Length is bounded to a 413 at the cap', async () => {
  const total = 2 * 1024 * 1024; // 2 MiB, far above the 16 KiB policy cap
  const { stream, state } = countingStream(total);
  const response = await post('/runtime/bootstrap', { body: stream });
  assert.equal(response.status, 413, 'oversized streaming body must be rejected with 413, not post-buffer 400');
  assert.deepEqual(await response.json(), { error: 'request-too-large' });
  assert.ok(state.cancelCount >= 1, 'the oversized body must be cancelled, not drained');
  assert.ok(state.producedBytes < total / 4,
    `ingress must stop near the cap, not consume the body; produced ${state.producedBytes} of ${total}`);
});

test('#8703 stage A: an under-reported Content-Length is caught by the streaming cap', async () => {
  const { stream, state } = countingStream(512 * 1024);
  const response = await post('/runtime/bootstrap', { body: stream, headers: { 'content-length': '8' } });
  assert.equal(response.status, 413);
  assert.deepEqual(await response.json(), { error: 'request-too-large' });
  assert.ok(state.producedBytes < 512 * 1024, 'the false Content-Length must not be trusted as the size bound');
});

test('#8703 stage A: the declared Content-Length fast path still rejects oversized bodies at 413', async () => {
  const { stream } = countingStream(BOOTSTRAP_MAX_BYTES, 1024);
  const response = await post('/runtime/bootstrap', {
    body: stream, headers: { 'content-length': String(1024 * 1024) },
  });
  assert.equal(response.status, 413);
  assert.deepEqual(await response.json(), { error: 'request-too-large' });
});

test('#8703 stage A: in-budget malformed bodies keep the 400 contract (no regression)', async () => {
  for (const [label, body] of [
    ['not-json', 'this is not json'],
    ['empty', ''],
    ['non-utf8', new Uint8Array([0xff, 0xfe, 0xfd, 0x41, 0x42, 0x43])],
  ]) {
    const response = await post('/runtime/bootstrap', { body });
    assert.equal(response.status, 400, label);
    assert.deepEqual(await response.json(), { error: 'invalid-bootstrap-request' }, label);
  }
});

test('#8703 stage A: a well-formed in-budget request passes the body read (is never a 413)', async () => {
  // Shape-valid but wrong build: validation runs after the bounded read, so the
  // response must come from validateRuntimeBootstrap, not the size cap.
  const body = JSON.stringify({ nonce: 'n', requestId: 'r', buildId: 'phase9-test-build', clientPublicKey: {} });
  assert.ok(bootLength(body) <= BOOTSTRAP_MAX_BYTES);
  const response = await post('/runtime/bootstrap', { body });
  assert.notEqual(response.status, 413, 'in-budget valid JSON must not be size-rejected');
});

function bootLength(text) { return new TextEncoder().encode(text).length; }
