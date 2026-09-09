import assert from 'node:assert/strict';
import { ArtifactStore, MemoryArtifactBackend } from '../../../js/core/artifacts/index.js';
import {
  ANALYSIS_ORCHESTRATION_ROUTE,
  ArtifactAnalysisOrchestrator,
  WORKER_ANALYSIS_PAYLOAD_CODEC_VERSION,
  WORKER_CACHE_MIGRATION_VERSION,
  createWorkerAnalysisArtifactDescriptor,
} from '../../../js/cache/artifact-orchestration.js';

const BINARY_ID = `bin_sha256_${'42'.repeat(32)}`;
const descriptor = createWorkerAnalysisArtifactDescriptor({
  binaryId:BINARY_ID,
  sliceIndex:0,
  architecture:'arm64',
  artifactKind:'issue-5420-fixture',
  producerVersion:'producer-v1',
  loaderVersion:'loader-v1',
  architectureSemanticVersion:'arch-v1',
  abiSemanticVersion:'abi-v1',
  semanticSchemaVersion:'schema-v1',
});

const descriptorWithCustomIdentity = createWorkerAnalysisArtifactDescriptor({
  binaryId:BINARY_ID,
  sliceIndex:0,
  architecture:'arm64',
  artifactKind:'issue-5420-fixture',
  producerVersion:'producer-v1',
  loaderVersion:'loader-v1',
  architectureSemanticVersion:'arch-v1',
  abiSemanticVersion:'abi-v1',
  semanticSchemaVersion:'schema-v1',
  keyExtras:{ customIdentity:'kept' },
});
const descriptorWithReservedOverrides = createWorkerAnalysisArtifactDescriptor({
  binaryId:BINARY_ID,
  sliceIndex:0,
  architecture:'arm64',
  artifactKind:'issue-5420-fixture',
  producerVersion:'producer-v1',
  loaderVersion:'loader-v1',
  architectureSemanticVersion:'arch-v1',
  abiSemanticVersion:'abi-v1',
  semanticSchemaVersion:'schema-v1',
  keyExtras:{
    customIdentity:'kept',
    migrationContract:'attacker-migration',
    payloadCodec:'attacker-codec',
  },
});
assert.equal(
  descriptorWithReservedOverrides.artifactId,
  descriptorWithCustomIdentity.artifactId,
  'reserved identity provenance must not be caller-overridable',
);
assert.notEqual(
  descriptorWithCustomIdentity.artifactId,
  descriptor.artifactId,
  'non-reserved custom identity metadata must remain identity material',
);

const runtime = new ArtifactAnalysisOrchestrator({
  store:new ArtifactStore({ backend:new MemoryArtifactBackend({ reason:'issue-5420' }) }),
});

let producerCalls = 0;
try {
  const cold = await runtime.request({
    descriptor,
    creation:{
      migrationContract:'attacker-migration',
      payloadCodec:'attacker-codec',
      sourceRoute:ANALYSIS_ORCHESTRATION_ROUTE.ARTIFACT,
      customTrace:'kept-cold',
    },
    produce:async () => {
      producerCalls++;
      return { ok:true, value:7n };
    },
  });

  assert.equal(cold.reused, false);
  assert.equal(cold.record.creation.migrationContract, WORKER_CACHE_MIGRATION_VERSION);
  assert.equal(cold.record.creation.payloadCodec, WORKER_ANALYSIS_PAYLOAD_CODEC_VERSION);
  assert.equal(cold.record.creation.sourceRoute, ANALYSIS_ORCHESTRATION_ROUTE.CURRENT);
  assert.equal(cold.record.creation.customTrace, 'kept-cold');
  assert.deepEqual(cold.payload, { ok:true, value:7n });

  const warm = await runtime.request({
    descriptor,
    creation:{
      migrationContract:'second-migration',
      payloadCodec:'second-codec',
      sourceRoute:ANALYSIS_ORCHESTRATION_ROUTE.ARTIFACT,
      customTrace:'ignored-on-warm-hit',
    },
    produce:async () => {
      producerCalls++;
      return { ok:false };
    },
  });

  assert.equal(warm.reused, true);
  assert.equal(producerCalls, 1, 'warm reuse must not alter producer or artifact identity');
  assert.equal(warm.record.creation.migrationContract, WORKER_CACHE_MIGRATION_VERSION);
  assert.equal(warm.record.creation.payloadCodec, WORKER_ANALYSIS_PAYLOAD_CODEC_VERSION);
  assert.equal(warm.record.creation.sourceRoute, ANALYSIS_ORCHESTRATION_ROUTE.CURRENT);
  assert.equal(warm.record.creation.customTrace, 'kept-cold');
  assert.deepEqual(warm.payload, { ok:true, value:7n });
} finally {
  await runtime.close();
}

const concurrentDescriptor = createWorkerAnalysisArtifactDescriptor({
  binaryId:BINARY_ID,
  sliceIndex:0,
  architecture:'arm64',
  artifactKind:'issue-5420-concurrent-fixture',
  producerVersion:'producer-v1',
  loaderVersion:'loader-v1',
  architectureSemanticVersion:'arch-v1',
  abiSemanticVersion:'abi-v1',
  semanticSchemaVersion:'schema-v1',
});
const concurrentRuntime = new ArtifactAnalysisOrchestrator({
  store:new ArtifactStore({ backend:new MemoryArtifactBackend({ reason:'issue-5420-concurrent' }) }),
});
let releaseProducer;
const producerGate = new Promise((resolve) => { releaseProducer = resolve; });
let concurrentProducerCalls = 0;
try {
  const first = concurrentRuntime.request({
    descriptor:concurrentDescriptor,
    creation:{
      migrationContract:'first-migration',
      payloadCodec:'first-codec',
      sourceRoute:ANALYSIS_ORCHESTRATION_ROUTE.ARTIFACT,
      customTrace:'first-wins-custom-metadata',
    },
    produce:async () => {
      concurrentProducerCalls++;
      await producerGate;
      return { concurrent:true };
    },
  });

  // Let the first request create the shared producer before the second joins it.
  await Promise.resolve();
  const second = concurrentRuntime.request({
    descriptor:concurrentDescriptor,
    creation:{
      migrationContract:'second-migration',
      payloadCodec:'second-codec',
      sourceRoute:ANALYSIS_ORCHESTRATION_ROUTE.ARTIFACT,
      customTrace:'second-must-not-rewrite-shared-provenance',
    },
    produce:async () => {
      concurrentProducerCalls++;
      return { shouldNotRun:true };
    },
  });
  releaseProducer();
  const [firstResult, secondResult] = await Promise.all([first, second]);

  assert.equal(concurrentProducerCalls, 1, 'same artifact must remain single-flight under concurrent callers');
  for (const result of [firstResult, secondResult]) {
    assert.equal(result.record.creation.migrationContract, WORKER_CACHE_MIGRATION_VERSION);
    assert.equal(result.record.creation.payloadCodec, WORKER_ANALYSIS_PAYLOAD_CODEC_VERSION);
    assert.equal(result.record.creation.sourceRoute, ANALYSIS_ORCHESTRATION_ROUTE.CURRENT);
    assert.deepEqual(result.payload, { concurrent:true });
  }
  assert.equal(firstResult.record.creation.customTrace, 'first-wins-custom-metadata');
  assert.equal(secondResult.record.creation.customTrace, 'first-wins-custom-metadata');
} finally {
  await concurrentRuntime.close();
}

console.log('issue-5420 reserved creation provenance regression passed');
