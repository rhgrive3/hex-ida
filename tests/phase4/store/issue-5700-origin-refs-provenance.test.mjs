import assert from 'node:assert/strict';
import test from 'node:test';

import { ArtifactStore, MemoryArtifactBackend } from '../../../js/core/artifacts/index.js';
import { createArtifactRecord, encodeArtifactPayload } from '../../../js/core/artifacts/contracts.js';
import { compatiblePublishedArtifact } from '../../../js/core/artifacts/storage/integrity.js';
import { descriptor } from './support.mjs';

test('#5700 originRefs stay non-key but cannot be silently replaced by first-writer provenance', async () => {
  const entries = new Map();
  const store = new ArtifactStore({ backend:new MemoryArtifactBackend({ entries }) });
  const a = descriptor('origin-refs-provenance', { originRefs:['origin:A'] });
  const b = descriptor('origin-refs-provenance', { originRefs:['origin:B'] });

  assert.equal(a.artifactId, b.artifactId, 'originRefs remain non-key artifact provenance');
  const first = await store.publish(a, { ok:true });
  assert.deepEqual(first.record.originRefs, ['origin:A']);

  await assert.rejects(
    () => store.publish(b, { ok:true }),
    (error) => error?.code === 'artifact-immutable-conflict',
    'same payload with different originRefs must not become a duplicate of A',
  );

  await assert.rejects(
    () => store.get(b),
    (error) => error?.code === 'artifact-record-provenance-mismatch',
    'reading A through descriptor B must refuse the provenance mismatch',
  );

  // A descriptor mismatch is a caller incompatibility, not evidence that the
  // stored A row is corrupt. Refusing B must therefore not delete A.
  const readAsA = await store.get(a);
  assert.equal(readAsA.status, 'hit');
  assert.deepEqual(readAsA.record.originRefs, ['origin:A']);

  const exactDuplicate = await store.publish(a, { ok:true }, { creation:{ producerRun:'second' } });
  assert.equal(exactDuplicate.duplicate, true);
  assert.deepEqual(exactDuplicate.record.originRefs, ['origin:A']);
  await store.close();
});

test('#5700 duplicate compatibility includes provenance but still ignores creation bookkeeping', () => {
  const a = descriptor('origin-refs-compatibility', { originRefs:['origin:A'] });
  const b = descriptor('origin-refs-compatibility', { originRefs:['origin:B'] });
  const payload = encodeArtifactPayload({ ok:true });
  const a1 = createArtifactRecord(a, payload, { creation:{ producerRun:'one' } });
  const a2 = createArtifactRecord(a, payload, { creation:{ producerRun:'two' } });
  const b1 = createArtifactRecord(b, payload, { creation:{ producerRun:'one' } });

  assert.equal(compatiblePublishedArtifact(a1, a2, payload, payload), true,
    'creation metadata stays non-key duplicate bookkeeping');
  assert.equal(compatiblePublishedArtifact(a1, b1, payload, payload), false,
    'originRefs mismatch is not the same publication');
});
