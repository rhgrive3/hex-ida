import assert from 'node:assert/strict';
import test from 'node:test';
import { ArtifactStore } from '../../../js/core/artifacts/index.js';
import { artifactRecordChecksum } from '../../../js/core/artifacts/storage/integrity.js';
import { PersistentMemoryBackend, descriptor } from './support.mjs';

/*
 * #8808: `ArtifactStore.#upstreamsValid()` treated a self-consistent storage
 * envelope as an identity proof for a row this store had not itself published
 * in this session. The envelope's `recordChecksum` is a `stableDigest` over
 * the mutable `record`, so a party able to swap a persisted row (restart,
 * corruption, migration, tampering) can also recompute the checksum. That
 * reopens the exact invariant #5770 closed: a forged upstream row that
 * inherits the expected artifactId while every other identity field belongs
 * to another descriptor was still accepted on a fresh store, and any
 * dependent artifact published on top of it was served as a valid cache hit.
 *
 * The repair persists the artifact-key `optionsHash` as durable identity
 * material on every record, and validates the stored row's artifactId against
 * a recompute of `createArtifactId(...)` from the record's own material at
 * the `validateStoredArtifact` boundary. A forged row cannot produce a
 * matching `optionsHash` because that digest covers the original
 * `config`/`keyExtras`/`dependencyScope` material the substituted fields do
 * not carry. Genuine persisted rows recompute cleanly and remain valid
 * upstreams on a fresh session (test 4 below, mirroring #5770's envelope
 * scenario).
 */

async function publishForgedSwapEntries() {
  const entries = new Map();
  const backend = new PersistentMemoryBackend({ entries });
  const store = new ArtifactStore({ backend });
  const upstreamA = descriptor('8808-forged-a');
  const upstreamB = descriptor('8808-forged-b');
  const top = descriptor('8808-forged-top', { upstreamArtifactIds:[upstreamA.artifactId] });
  await store.publish(upstreamA, { value:'A' });
  await store.publish(upstreamB, { value:'B' });
  await store.publish(top, { value:'parent-derived-from-A' });
  // Replace A's stored row with B's record/payload, relabel artifactId,
  // recompute the envelope's self-consistent checksum. This is exactly the
  // bypass #5770's successor introduced.
  const rowB = entries.get(upstreamB.artifactId);
  const forgedRecord = { ...structuredClone(rowB.record), artifactId: upstreamA.artifactId };
  entries.set(upstreamA.artifactId, {
    artifactId: upstreamA.artifactId,
    storageEnvelopeSchemaVersion: rowB.storageEnvelopeSchemaVersion,
    recordChecksum: artifactRecordChecksum(forgedRecord),
    record: forgedRecord,
    payload: rowB.payload.slice(0),
  });
  return { entries, upstreamA, top };
}

test('#8808 forged upstream surviving a fresh session cannot make parent a hit', async () => {
  const { entries, top } = await publishForgedSwapEntries();
  const second = new ArtifactStore({ backend:new PersistentMemoryBackend({ entries }) });
  const result = await second.get(top.artifactId);
  assert.notEqual(result.status, 'hit',
    'a forged upstream row that survives a fresh session must not validate a dependency (#8808)');
  assert.equal((await second.get(top.artifactId)).status, result.status,
    'the forged row stays rejected across repeated reads');
});

test('#8808 direct read of a forged row does not establish upstream identity authority', async () => {
  const { entries, upstreamA } = await publishForgedSwapEntries();
  const third = new ArtifactStore({ backend:new PersistentMemoryBackend({ entries }) });
  const direct = await third.get(upstreamA.artifactId);
  assert.notEqual(direct.status, 'hit',
    'a swapped row must fail closed on direct read (#8808)');
});

test('#8808 forged row remains rejected on a second fresh session', async () => {
  const { entries, top } = await publishForgedSwapEntries();
  for (let i = 0; i < 3; i++) {
    const s = new ArtifactStore({ backend:new PersistentMemoryBackend({ entries }) });
    assert.notEqual((await s.get(top.artifactId)).status, 'hit',
      `iteration ${i}: forged row cannot mint a durable identity for the parent`);
  }
});

test('#8808 genuine persisted envelope rows still hit after a fresh session (no #5770 regression)', async () => {
  const entries = new Map();
  const upstream = descriptor('8808-genuine-a');
  const top = descriptor('8808-genuine-top', { upstreamArtifactIds:[upstream.artifactId] });
  const first = new ArtifactStore({ backend:new PersistentMemoryBackend({ entries }) });
  await first.publish(upstream, { value:'persisted' });
  await first.publish(top, { value:'parent' });
  const second = new ArtifactStore({ backend:new PersistentMemoryBackend({ entries }) });
  const result = await second.get(top.artifactId);
  assert.equal(result.status, 'hit',
    'genuine persisted rows must remain valid upstreams after restart (#8808 fix preserves #5770 behavior)');
  assert.deepEqual(result.payload, { value:'parent' });
});

test('#8808 same-session row swap remains rejected by the existing in-memory proof (#5770)', async () => {
  const entries = new Map();
  const upstreamA = descriptor('8808-same-a');
  const upstreamB = descriptor('8808-same-b');
  const top = descriptor('8808-same-top', { upstreamArtifactIds:[upstreamA.artifactId] });
  const store = new ArtifactStore({ backend:new PersistentMemoryBackend({ entries }) });
  await store.publish(upstreamA, { value:'A' });
  await store.publish(upstreamB, { value:'B' });
  await store.publish(top, { value:'parent' });
  entries.set(upstreamA.artifactId, entries.get(upstreamB.artifactId));
  const swapped = await store.get(top.artifactId);
  assert.notEqual(swapped.status, 'hit',
    'a swapped row must not pass upstream validation even inside the same session (#5770)');
});

test('#8808 ordinary record-byte corruption is still detected by the storage envelope', async () => {
  const entries = new Map();
  const store = new ArtifactStore({ backend:new PersistentMemoryBackend({ entries }) });
  const d = descriptor('8808-corrupt-envelope');
  await store.publish(d, { value:1 });
  store.evictHot(d.artifactId);
  entries.get(d.artifactId).record.creation = { corrupted:true };
  const result = await store.get(d.artifactId);
  assert.equal(result.status, 'corrupt',
    'the envelope remains a byte-corruption detector even after the identity-proof tightening');
  assert.equal(result.reason, 'artifact-record-checksum-mismatch');
});

test('#8808 a legacy row without durable identity material fails closed for upstream use', async () => {
  const entries = new Map();
  const upstream = descriptor('8808-legacy-upstream');
  const top = descriptor('8808-legacy-top', { upstreamArtifactIds:[upstream.artifactId] });
  const store = new ArtifactStore({ backend:new PersistentMemoryBackend({ entries }) });
  await store.publish(upstream, { value:'legacy' });
  await store.publish(top, { value:'parent' });
  // Strip the durable identity field the fix now requires; the fresh-store
  // read must refuse the row as a dependency rather than launder it as a
  // legacy-envelope identity.
  const row = entries.get(upstream.artifactId);
  delete row.record.optionsHash;
  row.recordChecksum = artifactRecordChecksum(row.record);
  const second = new ArtifactStore({ backend:new PersistentMemoryBackend({ entries }) });
  assert.notEqual((await second.get(top.artifactId)).status, 'hit',
    'a row without durable identity material cannot serve as an upstream (#8808)');
});
