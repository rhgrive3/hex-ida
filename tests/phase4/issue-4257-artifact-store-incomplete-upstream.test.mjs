import assert from 'node:assert/strict';
import {
  ArtifactStore,
  MemoryArtifactBackend,
  createArtifactDescriptor,
} from '../../js/core/artifacts/index.js';

function descriptor(kind, upstreamArtifactIds = []) {
  return createArtifactDescriptor({
    binaryId:'bin_issue_4257',
    artifactKind:kind,
    producerId:`issue-4257-${kind}`,
    producerVersion:'1',
    versions:{
      loader:'1',
      architectureSemantic:'1',
      abiSemantic:'1',
      semanticSchema:'1',
    },
    upstreamArtifactIds,
  });
}

function fixture() {
  const entries = new Map();
  const backend = new MemoryArtifactBackend({ entries });
  const store = new ArtifactStore({ backend, corruptionPolicy:'retain' });
  return { entries, backend, store };
}

// A caller that explicitly accepts incomplete artifacts must carry that read
// contract through the dependency DAG on both hot-root and backend-root paths.
{
  const { store } = fixture();
  const upstream = descriptor('partial-upstream');
  const parent = descriptor('partial-parent', [upstream.artifactId]);

  await store.publish(upstream, { value:'upstream' }, { completeness:'partial' });
  await store.publish(parent, { value:'parent' }, { completeness:'partial' });

  const hot = await store.get(parent, { allowIncomplete:true });
  assert.equal(hot.status, 'hit');
  assert.equal(hot.source, 'hot');

  store.evictHot(parent.artifactId);
  const backend = await store.get(parent, { allowIncomplete:true });
  assert.equal(backend.status, 'hit');
  assert.equal(backend.source, 'memory');

  store.evictHot(parent.artifactId);
  const strict = await store.get(parent);
  assert.equal(strict.status, 'corrupt');
  assert.equal(strict.reason, 'artifact-incomplete');

  await store.close();
}

// The direct counterexample: a complete parent may be read under an explicit
// incomplete-accepting policy, while the default policy still rejects its
// incomplete dependency as missing-upstream.
{
  const { store } = fixture();
  const upstream = descriptor('complete-parent-partial-upstream');
  const parent = descriptor('complete-parent', [upstream.artifactId]);

  await store.publish(upstream, { value:'upstream' }, { completeness:'partial' });
  await store.publish(parent, { value:'parent' });

  store.evictHot(parent.artifactId);
  const strict = await store.get(parent);
  assert.equal(strict.status, 'miss');
  assert.equal(strict.reason, 'missing-upstream');

  const permissive = await store.get(parent, { allowIncomplete:true });
  assert.equal(permissive.status, 'hit');
  assert.equal(permissive.record.completeness, 'complete');

  await store.close();
}

// Missing dependencies remain fail-closed even under the permissive read
// contract; allowIncomplete changes completeness acceptance only.
{
  const { store } = fixture();
  const parent = descriptor('missing-upstream-parent', ['artifact_issue_4257_missing']);
  await store.publish(parent, { value:'parent' });

  const result = await store.get(parent, { allowIncomplete:true });
  assert.equal(result.status, 'miss');
  assert.equal(result.reason, 'missing-upstream');

  await store.close();
}

// Corrupt incomplete upstreams remain invalid; the propagated option must not
// weaken payload/envelope/identity validation.
{
  const { entries, store } = fixture();
  const upstream = descriptor('corrupt-partial-upstream');
  const parent = descriptor('corrupt-upstream-parent', [upstream.artifactId]);

  await store.publish(upstream, { value:'upstream' }, { completeness:'partial' });
  await store.publish(parent, { value:'parent' });

  const raw = entries.get(upstream.artifactId);
  assert.ok(raw, 'published upstream must exist in backend');
  new Uint8Array(raw.payload)[0] ^= 0xff;

  store.evictHot(parent.artifactId);
  const result = await store.get(parent, { allowIncomplete:true });
  assert.equal(result.status, 'miss');
  assert.equal(result.reason, 'missing-upstream');

  await store.close();
}

console.log('issue 4257 artifact incomplete upstream read policy: PASS');
