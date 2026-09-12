import assert from 'node:assert/strict';
import { ArtifactStore, MemoryArtifactBackend } from '../../../js/core/artifacts/index.js';
import {
  ArtifactAnalysisOrchestrator,
  createWorkerAnalysisArtifactDescriptor,
} from '../../../js/cache/artifact-orchestration.js';

// #5439: canonical slice/entity ids are lowercase hex by construction. A
// caller-supplied uppercase-hex spelling of the same id must normalize onto
// the same identity material instead of minting a second ArtifactId.
const common = {
  binaryId: 'bin_sha256_' + '11'.repeat(32),
  entityId: 'entity_' + '22'.repeat(16),
  artifactKind: 'worker-analysis-result',
  producerId: 'producer-issue5439',
  producerVersion: '1',
  loaderVersion: '1',
  architectureSemanticVersion: '1',
  abiSemanticVersion: '1',
  semanticSchemaVersion: '1',
};

{
  const lower = createWorkerAnalysisArtifactDescriptor({ ...common, sliceId: 'slice_' + 'ab'.repeat(16) });
  const upper = createWorkerAnalysisArtifactDescriptor({ ...common, sliceId: 'slice_' + 'AB'.repeat(16) });

  // Prove the canonical identity survives the real ArtifactStore/scheduler
  // reuse path, not only descriptor equality. Evict the hot row after the
  // lowercase publish so the uppercase-equivalent request must resolve the
  // canonical key through the backing store. Before the #5439 fix these two
  // spellings mint different ArtifactIds, invoke the producer twice, and leave
  // two backend rows.
  const backend = new MemoryArtifactBackend({ reason:'issue-5439-case-identity' });
  const store = new ArtifactStore({ backend });
  const runtime = new ArtifactAnalysisOrchestrator({ store });
  const payload = { fixture:'issue-5439-case-identity' };
  let producerCalls = 0;
  const produce = async () => { producerCalls++; return payload; };

  const cold = await runtime.request({ descriptor:lower, produce });
  assert.equal(cold.reused, false);
  store.evictHot(lower.artifactId);
  const warm = await runtime.request({ descriptor:upper, produce });
  const stats = store.stats();

  assert.equal(stats.backend.entries, 1, 'case variation must not create a duplicate ArtifactStore record');
  assert.equal(stats.writes, 1, 'case variation must publish only one canonical artifact key');
  assert.equal(warm.reused, true, 'uppercase-equivalent descriptor must warm-reuse the lowercase publication');
  assert.equal(producerCalls, 1, 'warm reuse must not re-run the producer for case-only identity variation');
  assert.ok(stats.memoryHits >= 1, 'warm reuse must resolve through the backing ArtifactStore after hot eviction');
  assert.equal(warm.record.artifactId, lower.artifactId);
  assert.deepEqual(warm.payload, payload);
  await runtime.close();

  assert.equal(upper.sliceId, lower.sliceId, 'uppercase hex sliceId must canonicalize to lowercase');
  assert.equal(upper.artifactId, lower.artifactId, 'same slice identity must not fork the ArtifactId namespace');
  assert.match(lower.sliceId, /^slice_[0-9a-f]{32}$/);
}

{
  const lower = createWorkerAnalysisArtifactDescriptor({ ...common, sliceId: 'slice_' + 'cd'.repeat(16), entityId: 'entity_' + '22'.repeat(16) });
  const upperEntity = createWorkerAnalysisArtifactDescriptor({ ...common, sliceId: 'slice_' + 'cd'.repeat(16), entityId: 'entity_' + '22'.repeat(16).toUpperCase() });
  assert.equal(upperEntity.entityId, lower.entityId, 'uppercase hex entityId must canonicalize to lowercase');
  assert.equal(upperEntity.artifactId, lower.artifactId, 'same entity identity must not fork the ArtifactId namespace');
  assert.match(lower.entityId, /^entity_[0-9a-f]{32}$/);
}

// Generated ids stay lowercase (already canonical, unchanged contract).
{
  const generated = createWorkerAnalysisArtifactDescriptor({ ...common });
  assert.match(generated.sliceId, /^slice_[0-9a-f]{32}$/);
  assert.match(generated.entityId, /^entity_[0-9a-f]{32}$/);
}

// Non-hex garbage keeps failing the canonical gate (normalization cannot
// rescue a structurally invalid id).
{
  assert.throws(
    () => createWorkerAnalysisArtifactDescriptor({ ...common, sliceId: 'slice_' + 'zz'.repeat(16) }),
    /analysis-artifact-slice-id-not-canonical/,
  );
  assert.throws(
    () => createWorkerAnalysisArtifactDescriptor({ ...common, entityId: 'entity_short' }),
    /analysis-artifact-entity-id-not-canonical/,
  );
}

console.log('phase4 migration issue-5439 canonical slice/entity case: PASS');
