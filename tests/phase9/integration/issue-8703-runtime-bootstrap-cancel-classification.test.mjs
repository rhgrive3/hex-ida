import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

register('data:text/javascript,' + encodeURIComponent(`
const runtimeSecrets = ${JSON.stringify(`export const RUNTIME_BUILD = Object.freeze({
  manifest: Object.freeze({ buildId: 'phase9-test-build', assetPath: '/.runtime/runtime.test.bin', byteLength: 0 }),
  signingKey: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  contentKey: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
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

const { __runtimeTest } = await import('../../../worker-entry.js');

const LIMIT = 16 * 1024;

test('#8703 stage A: rejecting stream cancellation cannot replace the deterministic 413 classification', async () => {
  let cancelCalls = 0;
  const stream = new ReadableStream({
    pull(controller) {
      controller.enqueue(new Uint8Array(LIMIT + 1));
    },
    cancel() {
      cancelCalls += 1;
      return Promise.reject(new Error('transport cancellation failed'));
    },
  });

  const request = new Request('https://ida.rhgrive.workers.dev/runtime/bootstrap', {
    method: 'POST',
    body: stream,
    duplex: 'half',
  });

  await assert.rejects(
    __runtimeTest.readBoundedBootstrapText(request, LIMIT),
    (error) => error?.bootstrapRequestTooLarge === true && error.message === 'bootstrap-request-too-large',
    'once the byte cap is crossed, the overflow sentinel must survive cancellation failure',
  );
  assert.equal(cancelCalls, 1, 'the oversized stream must still receive best-effort cancellation');
});


test('#8703 stage A: runtimeBootstrap converts the preserved overflow classification to HTTP 413', async () => {
  const stream = new ReadableStream({
    pull(controller) {
      controller.enqueue(new Uint8Array(LIMIT + 1));
    },
    cancel() {
      return Promise.reject(new Error('transport cancellation failed'));
    },
  });

  const request = new Request('https://ida.rhgrive.workers.dev/runtime/bootstrap', {
    method: 'POST',
    body: stream,
    headers: { origin: 'https://chatgpt.com' },
    duplex: 'half',
  });

  const response = await __runtimeTest.runtimeBootstrap(request, {}, new URL(request.url));
  assert.equal(response.status, 413);
  assert.deepEqual(await response.json(), { error: 'request-too-large' });
});
