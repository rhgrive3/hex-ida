import assert from 'node:assert/strict';
import { register } from 'node:module';

register('data:text/javascript,' + encodeURIComponent(`
export function resolve(specifier, context, nextResolve) {
  if (specifier === 'cloudflare:workers') {
    return { url: 'data:text/javascript,export class DurableObject {}', shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
`));

const { default: worker } = await import('../worker-entry.js');
const { RUNTIME_BUILD } = await import('../.runtime-build/runtime-secrets.js');

const allowedOrigin = 'https://chatgpt.com';
const workerOrigin = 'https://ida.rhgrive.workers.dev';

// 1. Malformed percent encoding in runtime path returns 400 invalid-runtime-path
for (const malformed of ['%', '%2', '%GG', '%E0%A4%A', '%c0%af']) {
  const req = new Request(`${workerOrigin}/_runtime/${malformed}`, {
    headers: { origin: allowedOrigin },
  });
  const res = await worker.fetch(req, {});
  assert.equal(res.status, 400, `Path /_runtime/${malformed} must return 400`);
  const body = await res.json();
  assert.deepEqual(body, { error: 'invalid-runtime-path' });
}

// 2. Disallowed request origin fails closed with 403 origin-not-allowed before path decoding
{
  const req = new Request(`${workerOrigin}/_runtime/%`, {
    headers: { origin: 'https://evil.example' },
  });
  const res = await worker.fetch(req, {});
  assert.equal(res.status, 403);
  const body = await res.json();
  assert.deepEqual(body, { error: 'origin-not-allowed' });
}

// 3. Disallowed method returns 405 Method Not Allowed
{
  const req = new Request(`${workerOrigin}/_runtime/%`, {
    method: 'POST',
    headers: { origin: allowedOrigin },
  });
  const res = await worker.fetch(req, {});
  assert.equal(res.status, 405);
}

// 4. OPTIONS preflight proceeds cleanly
{
  const req = new Request(`${workerOrigin}/_runtime/%`, {
    method: 'OPTIONS',
    headers: {
      origin: allowedOrigin,
      'access-control-request-method': 'GET',
    },
  });
  const res = await worker.fetch(req, {});
  assert.equal(res.status, 204);
}

// 5. Validly decoded but wrong build ID returns 403 wrong-build
{
  const req = new Request(`${workerOrigin}/_runtime/some-wrong-build-id`, {
    headers: { origin: allowedOrigin },
  });
  const res = await worker.fetch(req, {});
  assert.equal(res.status, 403);
  const body = await res.json();
  assert.deepEqual(body, { error: 'wrong-build' });
}

// 6. Correct build ID with invalid token returns 403 invalid-or-expired-session
{
  const req = new Request(`${workerOrigin}/_runtime/${RUNTIME_BUILD.manifest.buildId}`, {
    headers: {
      origin: allowedOrigin,
      authorization: 'Bearer invalid-token',
    },
  });
  const res = await worker.fetch(req, {});
  assert.equal(res.status, 403);
  const body = await res.json();
  assert.deepEqual(body, { error: 'invalid-or-expired-session' });
}

console.log('issue #6261 runtime malformed percent-encoding regressions PASS');
