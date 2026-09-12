import assert from 'node:assert/strict';
import { createArtifactDescriptor, createArtifactStore } from '../../../js/core/artifacts/index.js';

function baseInput() {
  return {
    binaryId: 'bin_issue5469',
    artifactKind: 'demo',
    producerId: 'producer-A',
    producerVersion: '1',
    loaderVersion: '1',
    architectureSemanticVersion: '1',
    abiSemanticVersion: '1',
    semanticSchemaVersion: '1',
  };
}

// #5469: a forged lookalike descriptor with a valid artifactId must fail the
// canonical-descriptor authority boundary instead of driving the stored healthy
// artifact into the delete-on-mismatch path.
{
  const descriptor = createArtifactDescriptor(baseInput());
  const store = createArtifactStore({});
  await store.publish(descriptor, { ok: true });

  const forged = { ...descriptor, producerId: 'producer-B' };
  await assert.rejects(
    () => store.get(forged),
    (error) => error.code === 'artifact-descriptor-noncanonical',
    'forged lookalike descriptor must fail the canonical authority boundary',
  );

  // The healthy artifact must survive the forged read: both descriptor reads
  // and artifactId reads still hit.
  assert.equal((await store.get(descriptor)).status, 'hit');
  assert.equal((await store.get(descriptor.artifactId)).status, 'hit');
}

// A byte-equal plain-object copy of a canonical descriptor is still not mint
// authority and must fail closed rather than silently act as one.
{
  const descriptor = createArtifactDescriptor(baseInput());
  const store = createArtifactStore({});
  await store.publish(descriptor, { ok: true });
  await assert.rejects(
    () => store.get({ ...descriptor }),
    (error) => error.code === 'artifact-descriptor-noncanonical',
  );
  assert.equal((await store.get(descriptor)).status, 'hit');
}

// The forged read must not evict the hot-cache entry either.
{
  const descriptor = createArtifactDescriptor(baseInput());
  const store = createArtifactStore({});
  await store.publish(descriptor, { ok: true });
  const hot = await store.get(descriptor);
  assert.equal(hot.source, 'hot');
  const forged = { ...descriptor, artifactKind: 'other-kind' };
  await assert.rejects(() => store.get(forged), /artifact-descriptor-noncanonical/);
  assert.equal((await store.get(descriptor)).source, 'hot', 'hot entry must survive a forged descriptor read');
}

// corruptionPolicy:'retain' fails closed on the same boundary (input authority,
// not storage corruption, so policy never enters the picture).
{
  const descriptor = createArtifactDescriptor(baseInput());
  const store = createArtifactStore({ corruptionPolicy: 'retain' });
  await store.publish(descriptor, { ok: true });
  await assert.rejects(() => store.get({ ...descriptor, producerId: 'producer-B' }), /artifact-descriptor-noncanonical/);
  assert.equal((await store.get(descriptor)).status, 'hit');
}

// Non-descriptor malformed inputs keep their artifact-id-required boundary.
{
  const store = createArtifactStore({});
  await assert.rejects(() => store.get(['artifact-A']), /artifact-id-required/);
  await assert.rejects(() => store.get(1), /artifact-id-required/);
  await assert.rejects(() => store.get({ toString() { return 'artifact-A'; } }), /artifact-id-required/);
  await assert.rejects(() => store.get(null), /artifact-id-required/);
}

console.log('phase4 issue-5469 noncanonical get descriptor: PASS');
