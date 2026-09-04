import assert from 'node:assert/strict';
import test from 'node:test';

import {
  RuntimeProviderRegistry,
  RuntimeProviderSession,
} from '../../../js/runtime/provider.js';

function descriptor(id, version = '1') {
  return { id, version, kind: 'test', facets: [] };
}

test('RuntimeProviderSession snapshots provider id and version from one descriptor read', () => {
  let generation = 0;
  const provider = {
    descriptor() {
      generation++;
      return descriptor(`provider-${generation}`, `version-${generation}`);
    },
  };

  const session = new RuntimeProviderSession({
    provider,
    request: { binaryId: 'binary-3966', sessionNonce: 'session-3966' },
  });

  assert.equal(generation, 1);
  assert.equal(session.providerId, 'provider-1');
  assert.equal(session.providerVersion, 'version-1');
  assert.equal(session.target.providerId, 'provider-1');
  assert.equal(session.target.providerVersion, 'version-1');
});

test('RuntimeProviderRegistry keeps the registration descriptor snapshot stable', () => {
  let descriptorCalls = 0;
  const provider = {
    descriptor() {
      descriptorCalls++;
      return descriptor(descriptorCalls === 1 ? 'registered' : `drift-${descriptorCalls}`, `v${descriptorCalls}`);
    },
    async openSession() { throw new Error('not used'); },
  };
  const registry = new RuntimeProviderRegistry();

  registry.register(provider);

  assert.equal(registry.get('registered'), provider);
  assert.deepEqual(registry.list().map(({ id, version }) => [id, version]), [['registered', 'v1']]);
  assert.deepEqual(registry.list().map(({ id, version }) => [id, version]), [['registered', 'v1']]);
  assert.equal(descriptorCalls, 1);
});

test('RuntimeProviderRegistry rejects and closes sessions whose provider identity drifted', async () => {
  let descriptorCalls = 0;
  let closeCalls = 0;
  const provider = {
    descriptor() {
      descriptorCalls++;
      return descriptor(descriptorCalls === 1 ? 'registered' : `drift-${descriptorCalls}`, `v${descriptorCalls}`);
    },
    async openSession(request) {
      return new RuntimeProviderSession({
        provider: this,
        request,
        close: async () => { closeCalls++; },
      });
    },
  };
  const registry = new RuntimeProviderRegistry();
  registry.register(provider);

  await assert.rejects(
    () => registry.openSession('registered', { binaryId: 'binary-3966', sessionNonce: 'drift-3966' }),
    (error) => error?.code === 'runtime-provider-descriptor-drift',
  );

  assert.equal(closeCalls, 1);
  assert.equal(registry.get('registered'), provider);
  assert.deepEqual(registry.list().map(({ id, version }) => [id, version]), [['registered', 'v1']]);
});

test('RuntimeProviderRegistry preserves stable provider session identity', async () => {
  const fixedDescriptor = descriptor('stable-provider', '7');
  const provider = {
    descriptor() { return fixedDescriptor; },
    async openSession(request) {
      return new RuntimeProviderSession({ provider: this, request });
    },
  };
  const registry = new RuntimeProviderRegistry();
  registry.register(provider);

  const session = await registry.openSession('stable-provider', {
    binaryId: 'binary-3966',
    sessionNonce: 'stable-3966',
  });

  assert.equal(session.providerId, 'stable-provider');
  assert.equal(session.providerVersion, '7');
  assert.equal(session.target.providerId, 'stable-provider');
  assert.equal(session.target.providerVersion, '7');
  assert.deepEqual(registry.list().map(({ id, version }) => [id, version]), [['stable-provider', '7']]);
});
