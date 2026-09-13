import assert from 'node:assert/strict';

import { ArtifactStore, MemoryArtifactBackend } from '../js/core/artifacts/index.js';
import { stableStringify } from '../js/core/identity/index.js';
import {
  ArtifactAnalysisOrchestrator,
  WORKER_ANALYSIS_PAYLOAD_CODEC_VERSION,
  createWorkerAnalysisArtifactDescriptor,
  decodeWorkerAnalysisPayload,
  encodeWorkerAnalysisPayload,
} from '../js/cache/artifact-orchestration.js';

const BINARY_ID = `bin_sha256_${'59'.repeat(32)}`;
let suffix = 0;

function descriptor(fixture) {
  suffix += 1;
  return createWorkerAnalysisArtifactDescriptor({
    binaryId:BINARY_ID,
    sliceIndex:0,
    architecture:'arm64',
    producerVersion:'producer-v1',
    loaderVersion:'loader-v1',
    architectureSemanticVersion:'arch-v1',
    abiSemanticVersion:'abi-v1',
    semanticSchemaVersion:'semantic-v1',
    config:{ fixture:`sparse-5525-${fixture}` },
  });
}

function orchestrator(reason) {
  const store = new ArtifactStore({ backend:new MemoryArtifactBackend({ reason }) });
  return new ArtifactAnalysisOrchestrator({ store });
}

// Dense arrays keep their existing round-trip through canonical JSON persistence.
{
  const dense = [1, undefined, null, 'x'];
  const decoded = decodeWorkerAnalysisPayload(
    JSON.parse(stableStringify(encodeWorkerAnalysisPayload(dense, { rejectSparseArrays:true }))),
    { rejectSparseArrays:true },
  );
  assert.equal(decoded.length, 4);
  assert.equal(0 in decoded, true);
  assert.equal(decoded[1], undefined);
  assert.equal(2 in decoded, true);
  assert.equal(decoded[2], null);
  assert.equal(decoded[3], 'x');
}

// An explicit undefined and a hole are different shapes; the hole is never
// admitted onto the persistence route as if it were lossless (#5525).
{
  const withHole = new Array(2);
  withHole[1] = 7;
  assert.throws(
    () => encodeWorkerAnalysisPayload(withHole, { rejectSparseArrays:true }),
    /analysis-artifact-payload-sparse-array-unsupported/,
  );
  const inMemory = decodeWorkerAnalysisPayload(encodeWorkerAnalysisPayload(withHole));
  assert.equal(inMemory.length, 2);
  assert.equal(0 in inMemory, false, 'a hole must not degrade into undefined for in-memory callers');
  assert.equal(inMemory[1], 7);
}

// Leading, middle and trailing holes must fail closed on the production
// publish path for both the hot cache and the persistent backend.
for (const [label, sparse] of [
  ['leading', (() => { const a = new Array(3); a[1] = 'b'; a[2] = 'c'; return a; })()],
  ['middle', (() => { const a = ['a']; a.length = 4; a[3] = 'd'; return a; })()],
  ['trailing', (() => { const a = ['a', 'b']; a.length = 5; return a; })()],
  ['nested', { rows:[(() => { const a = new Array(2); a[1] = 1; return a; })()] }],
]) {
  const runtime = orchestrator(`issue-5525-${label}`);
  const store = runtime.store;
  await assert.rejects(
    runtime.request({ descriptor:descriptor(label), produce:async () => sparse }),
    /analysis-artifact-payload-sparse-array-unsupported/,
    `${label} sparse payloads must be rejected before persistence`,
  );
  assert.equal(store.metrics.publishes, 0, `${label} sparse rejection must not publish a lossy artifact`);
  assert.equal(store.backend.entries.size, 0, `${label} sparse rejection must not persist a lossy payload`);
  assert.equal(runtime.metrics.coldPublishes, 0);
  await runtime.close();
}

// A holey wire node that reaches the reader anyway is rejected, never decoded
// into a silently different dense array.
{
  const holey = { codec:WORKER_ANALYSIS_PAYLOAD_CODEC_VERSION, root:{ t:'array', i:0, v:[null, { t:'number', v:7 }] } };
  assert.throws(
    () => decodeWorkerAnalysisPayload(JSON.parse(stableStringify(holey)), { rejectSparseArrays:true }),
    /analysis-artifact-payload-node-invalid/,
  );
  assert.throws(
    () => decodeWorkerAnalysisPayload({ codec:WORKER_ANALYSIS_PAYLOAD_CODEC_VERSION, root:{ t:'array', i:0, v:'nope' } }, { rejectSparseArrays:true }),
    /analysis-artifact-payload-/,
  );
}

console.log('issue #5525 sparse worker payload persistence regressions PASS');
