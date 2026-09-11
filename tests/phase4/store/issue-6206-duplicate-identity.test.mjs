import assert from 'node:assert/strict';
import { ArtifactStore } from '../../../js/core/artifacts/index.js';
import { MemoryArtifactBackend } from '../../../js/core/artifacts/index.js';
import { createArtifactRecord, encodeArtifactPayload } from '../../../js/core/artifacts/contracts.js';
import { compatiblePublishedArtifact, sameObservedArtifact } from '../../../js/core/artifacts/storage/integrity.js';
import { descriptor } from './support.mjs';

// #6206 — duplicate determination must compare record identity, not just the
// payload envelope. A row whose artifactId and payload bytes match but whose
// producer/binary/upstream metadata is corrupted must never be accepted as a
// duplicate: the post-publication validation would reject it, the duplicate
// path would refuse to delete it, and every correct publication of that id
// would fail forever.

const d = descriptor('duplicate-identity');
const payloadBytes = encodeArtifactPayload({ value: 'duplicate-identity' });
const good = createArtifactRecord(d, payloadBytes);

// Unit level: compatiblePublishedArtifact accepts the identical record and
// rejects each poisoned identity field, while creation/originRefs stay
// explicitly out of the comparison (pinned CAS-duplicate semantics).
{
  assert.equal(compatiblePublishedArtifact(good, createArtifactRecord(d, payloadBytes, { creation: { producerRun: 'other' } }), payloadBytes, payloadBytes),
    true, 'a creation-metadata-only difference stays a duplicate');
  const differentProvenanceDescriptor = descriptor('duplicate-identity', { originRefs: ['evidence_other'] });
  assert.equal(differentProvenanceDescriptor.artifactId, d.artifactId,
    'originRefs are non-key provenance: same artifactId expected');
  assert.equal(compatiblePublishedArtifact(good, createArtifactRecord(differentProvenanceDescriptor, payloadBytes), payloadBytes, payloadBytes),
    true, 'an originRefs-only difference stays a duplicate');
}

for (const [field, value] of [
  ['producerId', 'wrong-producer'],
  ['producerVersion', '999'],
  ['binaryId', 'bin_other'],
  ['sliceId', 'slice_other'],
  ['entityId', 'entity_other'],
  ['runtimeSnapshotId', 'snapshot_other'],
  ['canonicalConfigHash', 'hash_other'],
  ['versions', { ...good.versions, loader: 'loader_other' }],
  ['upstreamArtifactIds', ['artifact_other']],
  ['artifactKind', 'other-kind'],
  ['completeness', 'partial'],
]) {
  const poisoned = { ...good, [field]: value };
  assert.equal(
    compatiblePublishedArtifact(poisoned, good, payloadBytes, payloadBytes),
    false, `a poisoned ${field} must not be accepted as the same publication`,
  );
  assert.equal(
    compatiblePublishedArtifact(good, poisoned, payloadBytes, payloadBytes),
    false, `a poisoned ${field} must not be accepted as the same publication (new-record side)`,
  );
  assert.equal(
    sameObservedArtifact(poisoned, good, payloadBytes, payloadBytes),
    false, `sameObservedArtifact rejects a poisoned ${field}`,
  );
}

// Structural equality of nested identity material must not depend on the
// object being the same reference: a stored row and a fresh record are
// structurally equal but distinct objects.
{
  const stored = JSON.parse(JSON.stringify(good));
  assert.equal(compatiblePublishedArtifact(stored, good, payloadBytes, payloadBytes),
    true, 'a structurally identical stored row is the same publication');
}

// Integration level: a poisoned row in the backend must surface as an explicit
// immutable conflict, not as a duplicate that permanently blocks publication.
{
  const poisoned = { ...good, producerId: 'wrong-producer' };
  const entries = new Map([[good.artifactId, { artifactId: good.artifactId, record: poisoned, payload: payloadBytes }]]);
  const store = new ArtifactStore({ backend: new MemoryArtifactBackend({ entries }) });

  await assert.rejects(
    () => store.publish(d, { value: 'duplicate-identity' }),
    (error) => error.code === 'artifact-immutable-conflict',
    'the poisoned row must fail as artifact-immutable-conflict, not duplicate',
  );
  // ...and the second correct publish keeps failing closed the same way until
  // the corrupted row is explicitly deleted through the recovery protocol.
  await assert.rejects(() => store.publish(d, { value: 'duplicate-identity' }), (error) => error.code === 'artifact-immutable-conflict');

  await store.delete(good.artifactId);
  const recovered = await store.publish(d, { value: 'duplicate-identity' });
  assert.equal(recovered.status, 'published');
  assert.equal(recovered.duplicate, false);
  assert.equal(recovered.record.producerId, d.producerId);
  await store.close();
}
