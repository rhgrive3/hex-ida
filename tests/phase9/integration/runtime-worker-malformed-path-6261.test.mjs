import test from 'node:test';
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

const { default: worker } = await import('../../../worker-entry.js');
const { RUNTIME_BUILD } = await import('../../../.runtime-build/runtime-secrets.js');

const allowedOrigin = 'https://chatgpt.com';
const workerOrigin = 'https://ida.rhgrive.workers.dev';

async function request(path, options = {}) {
  return worker.fetch(new Request(`${workerOrigin}${path}`, {
    ...options,
    headers: {
      origin: allowedOrigin,
      ...options.headers,
    },
  }), {});
}

test('#6261 malformed runtime percent encoding returns a stable 400 response', async () => {
  for (const malformed of ['%', '%2', '%GG', '%E0%A4%A', '%c0%af']) {
    const response = await request(`/_runtime/${malformed}`);
    assert.equal(response.status, 400, `/_runtime/${malformed}`);
    assert.deepEqual(await response.json(), { error: 'invalid-runtime-path' });
  }
});

test('#6261 authorization and method boundaries still precede path decoding', async () => {
  const disallowedOrigin = await request('/_runtime/%', {
    headers: { origin: 'https://evil.example' },
  });
  assert.equal(disallowedOrigin.status, 403);
  assert.deepEqual(await disallowedOrigin.json(), { error: 'origin-not-allowed' });

  const disallowedMethod = await request('/_runtime/%', { method: 'POST' });
  assert.equal(disallowedMethod.status, 405);

  const preflight = await request('/_runtime/%', {
    method: 'OPTIONS',
    headers: { 'access-control-request-method': 'GET' },
  });
  assert.equal(preflight.status, 204);
});

test('#6261 valid runtime paths retain existing authorization behavior', async () => {
  const wrongBuild = await request('/_runtime/some-wrong-build-id');
  assert.equal(wrongBuild.status, 403);
  assert.deepEqual(await wrongBuild.json(), { error: 'wrong-build' });

  const invalidToken = await request(`/_runtime/${RUNTIME_BUILD.manifest.buildId}`, {
    headers: { authorization: 'Bearer invalid-token' },
  });
  assert.equal(invalidToken.status, 403);
  assert.deepEqual(await invalidToken.json(), { error: 'invalid-or-expired-session' });
});
