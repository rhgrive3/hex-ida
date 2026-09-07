import assert from 'node:assert/strict';
import {
  ArtifactStore,
  MemoryArtifactBackend,
  createArtifactDescriptor,
} from '../../js/core/artifacts/index.js';

function descriptor(kind, upstreamArtifactIds = []) {
  return createArtifactDescriptor({
    binaryId:'bin_issue_4220',
    artifactKind:kind,
    producerId:`issue-4220-${kind}`,
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
  return {
    entries,
    backend:new MemoryArtifactBackend({ entries }),
  };
}

// A valid one-edge dependency graph must fail closed without destructive stale handling
// when the caller's verification budget is exactly zero.
{
  const { entries, backend } = fixture();
  const store = new ArtifactStore({ backend });
  const upstream = descriptor('upstream');
  const parent = descriptor('parent', [upstream.artifactId]);
  await store.publish(upstream, { value:'upstream' });
  await store.publish(parent, { value:'parent' });

  const before = store.stats();
  const limited = await store.get(parent, { maxNodes:0 });
  assert.equal(limited.status, 'miss');
  assert.equal(limited.reason, 'verification-budget-exhausted');
  assert.equal(entries.has(parent.artifactId), true, 'budget exhaustion must not delete the valid parent');
  const after = store.stats();
  assert.equal(after.staleDependencyMisses, before.staleDependencyMisses);
  assert.equal(after.deletes, before.deletes);

  const recovered = await store.get(parent, { maxNodes:1 });
  assert.equal(recovered.status, 'hit');
  assert.deepEqual(recovered.payload, { value:'parent' });
}

// Budget exhaustion from a nested dependency must propagate without being collapsed
// into missing-upstream for the root artifact.
{
  const { entries, backend } = fixture();
  const store = new ArtifactStore({ backend });
  const leaf = descriptor('leaf');
  const middle = descriptor('middle', [leaf.artifactId]);
  const root = descriptor('root', [middle.artifactId]);
  await store.publish(leaf, { value:'leaf' });
  await store.publish(middle, { value:'middle' });
  await store.publish(root, { value:'root' });

  const limited = await store.get(root, { maxNodes:1 });
  assert.equal(limited.status, 'miss');
  assert.equal(limited.reason, 'verification-budget-exhausted');
  assert.equal(entries.has(root.artifactId), true);

  const recovered = await store.get(root, { maxNodes:2 });
  assert.equal(recovered.status, 'hit');
}

// A zero budget is sufficient when there are no upstream nodes to inspect.
{
  const { backend } = fixture();
  const store = new ArtifactStore({ backend });
  const standalone = descriptor('standalone');
  await store.publish(standalone, { value:'standalone' });
  const result = await store.get(standalone, { maxNodes:0 });
  assert.equal(result.status, 'hit');
}

// Proven missing dependencies remain stale and retain the existing destructive policy.
{
  const { entries, backend } = fixture();
  const store = new ArtifactStore({ backend });
  const parent = descriptor('missing-parent', ['artifact_missing_issue_4220']);
  await store.publish(parent, { value:'parent' });
  const result = await store.get(parent, { maxNodes:1 });
  assert.equal(result.status, 'miss');
  assert.equal(result.reason, 'missing-upstream');
  assert.equal(entries.has(parent.artifactId), false, 'actual missing upstream must retain destructive stale policy');
}

// Proven corrupt dependencies remain fail-closed and stale for their parent.
{
  const { entries, backend } = fixture();
  const store = new ArtifactStore({ backend });
  const upstream = descriptor('corrupt-upstream');
  const parent = descriptor('corrupt-parent', [upstream.artifactId]);
  await store.publish(upstream, { value:'upstream' });
  await store.publish(parent, { value:'parent' });
  const raw = entries.get(upstream.artifactId);
  new Uint8Array(raw.payload)[0] ^= 0xff;

  const result = await store.get(parent, { maxNodes:1 });
  assert.equal(result.status, 'miss');
  assert.equal(result.reason, 'missing-upstream');
  assert.equal(entries.has(parent.artifactId), false);
}

console.log('issue 4220 artifact upstream verification budget: PASS');
