import assert from 'node:assert/strict';
import { ArtifactStore, ArtifactHotCache, MemoryArtifactBackend, createArtifactDescriptor } from '../../../js/core/artifacts/index.js';

function descriptorInput(overrides = {}) {
  return {
    binaryId: 'bin_issue5298',
    artifactKind: 'demo',
    producerId: 'producer-A',
    producerVersion: '1',
    loaderVersion: '1',
    architectureSemanticVersion: '1',
    abiSemanticVersion: '1',
    semanticSchemaVersion: '1',
    ...overrides,
  };
}

// #5298: a publish validator that returns an explicit `false` verdict must
// reject the publication instead of having its return value ignored.
{
  const descriptor = createArtifactDescriptor(descriptorInput());
  const store = new ArtifactStore({ backend: new MemoryArtifactBackend(), hotCache: new ArtifactHotCache() });

  await assert.rejects(
    () => store.publish(descriptor, { route: 'wrong-route' }, {
      validate: async (payload) => payload.route === 'phase5-shadow-v2',
    }),
    (error) => error.code === 'artifact-publish-validator-rejected',
  );

  // The rejected artifact must not be cached or stored.
  assert.equal((await store.get(descriptor)).status, 'miss');
  assert.ok(store.metrics.validationFailures >= 1);
}

// The same predicate shape that production uses must still accept a payload
// that satisfies the postconditions.
{
  const descriptor = createArtifactDescriptor(descriptorInput({ binaryId: 'bin_issue5298b' }));
  const store = new ArtifactStore({ backend: new MemoryArtifactBackend(), hotCache: new ArtifactHotCache() });
  const result = await store.publish(descriptor, { route: 'phase5-shadow-v2' }, {
    validate: async (payload) => payload.route === 'phase5-shadow-v2',
  });
  assert.equal(result.status, 'published');
  assert.equal((await store.get(descriptor)).status, 'hit');
}

// Void-style validators (undefined return) keep their contract — they signal
// failure by throwing, and are used as abort gates.
{
  const descriptor = createArtifactDescriptor(descriptorInput({ binaryId: 'bin_issue5298c' }));
  const store = new ArtifactStore({ backend: new MemoryArtifactBackend(), hotCache: new ArtifactHotCache() });
  const result = await store.publish(descriptor, { ok: true }, { validate: async () => undefined });
  assert.equal(result.status, 'published');
  await assert.rejects(
    () => store.publish(descriptor, { ok: false }, { validate: async () => { throw new Error('fixture-validation-failed'); } }),
    /fixture-validation-failed/,
  );
}

// A sync validator returning false rejects too (predicate need not be async).
{
  const descriptor = createArtifactDescriptor(descriptorInput({ binaryId: 'bin_issue5298d' }));
  const store = new ArtifactStore({ backend: new MemoryArtifactBackend(), hotCache: new ArtifactHotCache() });
  await assert.rejects(
    () => store.publish(descriptor, { ok: 0 }, { validate: (payload) => payload.ok === 1 }),
    /artifact-publish-validator-rejected/,
  );
  assert.equal((await store.get(descriptor)).status, 'miss');
}

console.log('phase4 store issue-5298 publish validator verdict: PASS');
