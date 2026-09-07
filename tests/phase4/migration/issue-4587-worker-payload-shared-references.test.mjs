import assert from 'node:assert/strict';

import { ArtifactStore, MemoryArtifactBackend } from '../../../js/core/artifacts/index.js';
import {
  ArtifactAnalysisOrchestrator,
  WORKER_ANALYSIS_PAYLOAD_CODEC_VERSION,
  createWorkerAnalysisArtifactDescriptor,
  decodeWorkerAnalysisPayload,
  encodeWorkerAnalysisPayload,
} from '../../../js/cache/artifact-orchestration.js';

const BINARY_ID = `bin_sha256_${'58'.repeat(32)}`;

function descriptor() {
  return createWorkerAnalysisArtifactDescriptor({
    binaryId:BINARY_ID,
    sliceIndex:0,
    architecture:'arm64',
    producerVersion:'producer-v1',
    loaderVersion:'loader-v1',
    architectureSemanticVersion:'arch-v1',
    abiSemanticVersion:'abi-v1',
    semanticSchemaVersion:'semantic-v1',
    config:{ fixture:'shared-references-4587' },
  });
}

function fixture() {
  const shared = { id:1 };
  const sharedDate = new Date('2026-09-02T00:00:00.000Z');
  return {
    a:shared,
    b:shared,
    key:shared,
    map:new Map([[shared, 'hit']]),
    set:new Set([shared]),
    nested:[{ value:shared }],
    dateA:sharedDate,
    dateB:sharedDate,
  };
}

function assertTopology(value) {
  assert.equal(value.a, value.b, 'plain-object aliases must remain identical');
  assert.equal(value.map.get(value.key), 'hit', 'Map keys must share identity with sibling fields');
  assert.equal(value.set.has(value.a), true, 'Set membership must share identity with sibling fields');
  assert.equal(value.nested[0].value, value.a, 'nested aliases must remain identical');
  assert.equal(value.dateA, value.dateB, 'shared built-in objects must remain identical');
}

// Canonical-JSON persistence must not erase graph topology from the transport.
{
  const encoded = encodeWorkerAnalysisPayload(fixture());
  assert.equal(encoded.codec, WORKER_ANALYSIS_PAYLOAD_CODEC_VERSION);
  assert.equal(encoded.codec, 'hex-worker-analysis-payload-v2');
  const persisted = JSON.parse(JSON.stringify(encoded));
  assertTopology(decodeWorkerAnalysisPayload(persisted));
}

// The old v1 wire format remains readable while v2 gets a new artifact identity.
{
  const legacy = {
    codec:'hex-worker-analysis-payload-v1',
    root:{ t:'object', n:false, v:[['value', { t:'number', v:7 }]] },
  };
  assert.deepEqual(decodeWorkerAnalysisPayload(legacy), { value:7 });
}

// Reference nodes fail closed on forward/unknown IDs and cycles remain rejected.
{
  assert.throws(
    () => decodeWorkerAnalysisPayload({ codec:WORKER_ANALYSIS_PAYLOAD_CODEC_VERSION, root:{ t:'ref', i:0 } }),
    /analysis-artifact-payload-node-invalid/,
  );
  assert.throws(
    () => decodeWorkerAnalysisPayload({ codec:WORKER_ANALYSIS_PAYLOAD_CODEC_VERSION, root:{ t:'object', i:1, n:false, v:[] } }),
    /analysis-artifact-payload-node-invalid/,
  );

  const completedAlias = decodeWorkerAnalysisPayload({
    codec:WORKER_ANALYSIS_PAYLOAD_CODEC_VERSION,
    root:{
      t:'object', i:0, n:false,
      v:[
        ['a', { t:'object', i:1, n:false, v:[['value', { t:'number', v:1 }]] }],
        ['b', { t:'ref', i:1 }],
      ],
    },
  });
  assert.equal(completedAlias.a, completedAlias.b, 'refs to fully decoded nodes must remain valid aliases');

  assert.throws(
    () => decodeWorkerAnalysisPayload({
      codec:WORKER_ANALYSIS_PAYLOAD_CODEC_VERSION,
      root:{ t:'object', i:0, n:false, v:[['self', { t:'ref', i:0 }]] },
    }),
    /analysis-artifact-payload-cyclic/,
  );
  assert.throws(
    () => decodeWorkerAnalysisPayload({
      codec:WORKER_ANALYSIS_PAYLOAD_CODEC_VERSION,
      root:{
        t:'object', i:0, n:false,
        v:[['child', { t:'object', i:1, n:false, v:[['parent', { t:'ref', i:0 }]] }]],
      },
    }),
    /analysis-artifact-payload-cyclic/,
  );

  const cyclic = {};
  cyclic.self = cyclic;
  assert.throws(() => encodeWorkerAnalysisPayload(cyclic), /analysis-artifact-payload-cyclic/);
}

// ArtifactStore cold and warm reuse must preserve the same alias semantics.
{
  const store = new ArtifactStore({ backend:new MemoryArtifactBackend({ reason:'issue-4587-shared-reference-test' }) });
  const runtime = new ArtifactAnalysisOrchestrator({ store });
  const d = descriptor();
  let calls = 0;

  const cold = await runtime.request({ descriptor:d, produce:async () => { calls++; return fixture(); } });
  assert.equal(cold.reused, false);
  assertTopology(cold.payload);

  const warm = await runtime.request({ descriptor:d, produce:async () => { calls++; return fixture(); } });
  assert.equal(warm.reused, true);
  assert.equal(calls, 1, 'warm reuse must not rerun the producer');
  assertTopology(warm.payload);

  const raw = await store.get(d);
  assert.equal(raw.status, 'hit');
  assert.equal(raw.payload.codec, WORKER_ANALYSIS_PAYLOAD_CODEC_VERSION);
  assertTopology(decodeWorkerAnalysisPayload(raw.payload));
  await runtime.close();
}

console.log('issue 4587 worker payload shared references: PASS');
