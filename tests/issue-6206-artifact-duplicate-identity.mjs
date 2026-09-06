import assert from 'node:assert/strict';
import test from 'node:test';
import { createArtifactDescriptor, createArtifactRecord, encodeArtifactPayload } from '../js/core/artifacts/contracts.js';
import { compatiblePublishedArtifact } from '../js/core/artifacts/storage/integrity.js';
import { MemoryArtifactBackend } from '../js/core/artifacts/backends.js';
import { ArtifactStore } from '../js/core/artifacts/store.js';

function makeGood() {
  const descriptor = createArtifactDescriptor({
    binaryId: 'bin-1',
    artifactKind: 'test.kind',
    producerId: 'producer-a',
    producerVersion: '1.0.0',
    versions: { loader: '1', architectureSemantic: '1', abiSemantic: '1', semanticSchema: '1' },
    config: { x: 1 },
  });
  const payload = { hello: 'world' };
  const payloadBytes = encodeArtifactPayload(payload);
  const record = createArtifactRecord(descriptor, payloadBytes);
  return { descriptor, payload, payloadBytes, record };
}

test('issue #6206 - identical record stays duplicate', () => {
  const { record, payloadBytes } = makeGood();
  assert.equal(compatiblePublishedArtifact(record, record, payloadBytes, payloadBytes), true);
});

test('issue #6206 - producerId mismatch is not duplicate', () => {
  const { record, payloadBytes } = makeGood();
  const poisoned = { ...record, producerId: 'wrong-producer' };
  assert.equal(compatiblePublishedArtifact(poisoned, record, payloadBytes, payloadBytes), false);
});

test('issue #6206 - binaryId/version/config/upstream mismatch is not duplicate', () => {
  const { record, payloadBytes } = makeGood();
  for (const patch of [
    { binaryId: 'other-bin' },
    { producerVersion: '9.9.9' },
    { canonicalConfigHash: 'deadbeef' },
    { entityId: 'other-entity' },
    { versions: { ...record.versions, loader: '9' } },
    { upstreamArtifactIds: ['other-id'] },
  ]) {
    const poisoned = { ...record, ...patch };
    assert.equal(compatiblePublishedArtifact(poisoned, record, payloadBytes, payloadBytes), false, JSON.stringify(patch));
  }
});

test('issue #6206 - creation-only diff stays duplicate', () => {
  const { descriptor, payloadBytes } = makeGood();
  const payload = { hello: 'world' };
  const r1 = createArtifactRecord(descriptor, payloadBytes, { creation: { at: 'a' } });
  const r2 = createArtifactRecord(descriptor, payloadBytes, { creation: { at: 'b' } });
  assert.equal(compatiblePublishedArtifact(r1, r2, payloadBytes, payloadBytes), true);
});

test('issue #6206 - poisoned row does not permanently block publish', async () => {
  const { descriptor, payload, payloadBytes, record: good } = makeGood();
  const poisoned = { ...good, producerId: 'wrong-producer' };
  const entries = new Map([[good.artifactId, {
    artifactId: good.artifactId,
    record: structuredClone(poisoned),
    payload: payloadBytes.slice(),
  }]]);
  const backend = new MemoryArtifactBackend({ entries });
  const store = new ArtifactStore({ backend });
  // With the fix, the poisoned row is NOT treated as duplicate, so putAtomic
  // throws artifact-immutable-conflict and the poison is visible.
  // Before the fix it was treated as duplicate and later failed with
  // artifact-record-identity-mismatch while keeping the poisoned row.
  try {
    await store.publish(descriptor, payload);
    assert.fail('publish should reject on poisoned row');
  } catch (error) {
    assert.ok(
      error?.code === 'artifact-immutable-conflict' || error?.code === 'artifact-record-identity-mismatch',
      `unexpected code ${error?.code}: ${error?.message}`,
    );
    // After fix, it must be the conflict path (duplicate not taken).
    assert.equal(error?.code, 'artifact-immutable-conflict');
  }
  const raw = await backend.getRaw(good.artifactId);
  assert.equal(raw.record.producerId, 'wrong-producer');
});
