import assert from 'node:assert/strict';
import { ArtifactStore } from '../../../js/core/artifacts/index.js';
import { MemoryArtifactBackend } from '../../../js/core/artifacts/backends.js';
import { PersistentMemoryBackend, descriptor as fixtureDescriptor } from './support.mjs';
import { createArtifactDescriptor, createArtifactRecord, encodeArtifactPayload } from '../../../js/core/artifacts/contracts.js';

// #5770: upstream re-validation passed only the artifactId string, so a stored
// row whose artifactId matched the expected upstream but whose record body was
// produced by a different descriptor (corruption / legacy import / row swap)
// validated as a dependency and the dependent artifact was served as a hit.
// Upstream rows must prove their identity: a proven identity recorded by this
// store, or a storage envelope over the record bytes — a legacy row with
// neither fails closed.

function forgedUpstreamRow(upstream, other) {
  const bytes = encodeArtifactPayload({ value:'wrong-upstream' });
  const otherRecord = createArtifactRecord(other, bytes);
  return {
    row:{ record:{ ...otherRecord, artifactId: upstream.artifactId }, payload:bytes },
    bytes,
  };
}

{
  // The issue's minimal counterexample: a legacy row (no storage envelope)
  // whose artifactId equals the expected upstream id but whose identity
  // material (binary/producer/versions) belongs to another descriptor.
  const entries = new Map();
  const upstream = createArtifactDescriptor({
    binaryId:'bin-A',
    artifactKind:'symbols',
    producerId:'producer-A',
    producerVersion:'1',
    versions:{ loader:'1' },
    relevance:{ architectureSemantic:false, abiSemantic:false, semanticSchema:false },
  });
  const top = createArtifactDescriptor({
    binaryId:'bin-A',
    artifactKind:'analysis',
    producerId:'top',
    producerVersion:'1',
    versions:{ loader:'1' },
    relevance:{ architectureSemantic:false, abiSemantic:false, semanticSchema:false },
    upstreamArtifactIds:[upstream.artifactId],
  });
  const other = createArtifactDescriptor({
    binaryId:'bin-B',
    artifactKind:'symbols',
    producerId:'producer-B',
    producerVersion:'9',
    versions:{ loader:'9' },
    relevance:{ architectureSemantic:false, abiSemantic:false, semanticSchema:false },
  });

  const backend = new PersistentMemoryBackend({ entries });
  const store = new ArtifactStore({ backend });
  await store.publish(top, { value:'parent' });
  const forged = forgedUpstreamRow(upstream, other);
  entries.set(upstream.artifactId, forged.row);

  const result = await store.get(top);
  assert.equal(result.status, 'miss', 'a forged legacy upstream row must fail closed (#5770)');
  assert.equal(result.reason, 'missing-upstream');
  assert.equal((await store.get(top)).status, 'miss', 'the forged row stays rejected across reads');

  // Publishing the genuine upstream repairs the dependency. The forged row is
  // identity-incompatible, so it must be removed first (#6206 recovery path).
  // The dependent artifact itself was already deleted by the stale-dependency
  // path, so the producer re-publishes it over the repaired upstream.
  await store.delete(upstream.artifactId);
  await store.publish(upstream, { value:'upstream' });
  await store.publish(top, { value:'parent' });
  const repaired = await store.get(top);
  assert.equal(repaired.status, 'hit', 'the genuine upstream publication satisfies the dependency');
  assert.deepEqual(repaired.payload, { value:'parent' });
}

{
  // A row swapped after publication is caught even when this store proved the
  // original identity: the proven identity is authoritative.
  const entries = new Map();
  const upstreamA = fixtureDescriptor('upstream-identity-a');
  const upstreamB = fixtureDescriptor('upstream-identity-b');
  const top = fixtureDescriptor('upstream-identity-top', { upstreamArtifactIds:[upstreamA.artifactId] });
  const backend = new PersistentMemoryBackend({ entries });
  const store = new ArtifactStore({ backend });
  await store.publish(upstreamA, { value:'A' });
  await store.publish(upstreamB, { value:'B' });
  await store.publish(top, { value:'parent' });
  assert.equal((await store.get(top)).status, 'hit');

  // Swap the stored row for B's row under A's artifactId, keeping B's storage
  // envelope fields consistent with B's record (forged envelope).
  const rowB = entries.get(upstreamB.artifactId);
  entries.set(upstreamA.artifactId, rowB);
  const swapped = await store.get(top);
  assert.equal(swapped.status, 'miss', 'a swapped row must not pass upstream validation (#5770)');
  assert.equal(swapped.reason, 'missing-upstream');
}

{
  // Envelope rows that this store did not publish (persisted session 2) keep
  // working: the envelope self-proves the record bytes.
  const entries = new Map();
  const upstream = fixtureDescriptor('upstream-identity-persisted');
  const top = fixtureDescriptor('upstream-identity-persisted-top', { upstreamArtifactIds:[upstream.artifactId] });
  const first = new ArtifactStore({ backend:new PersistentMemoryBackend({ entries }) });
  await first.publish(upstream, { value:'persisted' });
  await first.publish(top, { value:'parent' });

  const second = new ArtifactStore({ backend:new PersistentMemoryBackend({ entries }) });
  const result = await second.get(top);
  assert.equal(result.status, 'hit', 'envelope rows from an earlier session remain valid upstreams');
  assert.deepEqual(result.payload, { value:'parent' });
}

{
  // Legitimate publishes and session-2 reads are unaffected without upstreams.
  const entries = new Map();
  const leaf = fixtureDescriptor('upstream-identity-leaf');
  const backend = new MemoryArtifactBackend({ entries });
  const store = new ArtifactStore({ backend });
  await store.publish(leaf, { value:'leaf' });
  const hit = await store.get(leaf);
  assert.equal(hit.status, 'hit');
  assert.deepEqual(hit.payload, { value:'leaf' });
}

console.log('issue-5770 upstream record identity regression: PASS');
