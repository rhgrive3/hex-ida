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
  const buffer = new ArrayBuffer(16);
  const bufferBytes = new Uint8Array(buffer);
  for (let index = 0; index < bufferBytes.length; index++) bufferBytes[index] = index + 1;
  const sharedBuffer = typeof SharedArrayBuffer === 'function' ? new SharedArrayBuffer(4) : null;
  const sharedBufferView = sharedBuffer ? new Uint8Array(sharedBuffer) : null;
  if (sharedBufferView) sharedBufferView.set([9, 8, 7, 6]);
  return {
    a:shared,
    b:shared,
    key:shared,
    map:new Map([[shared, 'hit']]),
    set:new Set([shared]),
    nested:[{ value:shared }],
    dateA:sharedDate,
    dateB:sharedDate,
    buffer,
    dataViewA:new DataView(buffer, 2, 6),
    dataViewB:new DataView(buffer, 2, 6),
    typedArrayA:new Uint16Array(buffer, 4, 3),
    typedArrayB:new Uint8Array(buffer, 1, 5),
    sharedBuffer,
    sharedBufferView,
  };
}

function assertTopology(value) {
  assert.equal(value.a, value.b, 'plain-object aliases must remain identical');
  assert.equal(value.map.get(value.key), 'hit', 'Map keys must share identity with sibling fields');
  assert.equal(value.set.has(value.a), true, 'Set membership must share identity with sibling fields');
  assert.equal(value.nested[0].value, value.a, 'nested aliases must remain identical');
  assert.equal(value.dateA, value.dateB, 'shared built-in objects must remain identical');
  assert.equal(value.dataViewA.buffer, value.buffer, 'DataView must retain its backing-buffer identity');
  assert.equal(value.dataViewB.buffer, value.buffer, 'separate DataViews must retain their backing-buffer identity');
  assert.equal(value.typedArrayA.buffer, value.buffer, 'typed arrays must retain their backing-buffer identity');
  assert.equal(value.typedArrayB.buffer, value.buffer, 'separate typed arrays must retain their backing-buffer identity');
  assert.equal(value.dataViewA.byteOffset, 2);
  assert.equal(value.dataViewA.byteLength, 6);
  assert.equal(value.typedArrayA.byteOffset, 4);
  assert.equal(value.typedArrayA.length, 3);
  assert.deepEqual(Array.from(new Uint8Array(value.buffer)), [
    1, 2, 3, 4, 5, 6, 7, 8,
    9, 10, 11, 12, 13, 14, 15, 16,
  ], 'backing-buffer bytes must survive canonical JSON persistence');
  if (value.sharedBuffer) {
    assert.equal(value.sharedBufferView.buffer, value.sharedBuffer, 'SharedArrayBuffer-backed views must retain identity');
    assert.deepEqual(Array.from(value.sharedBufferView), [9, 8, 7, 6]);
  } else {
    assert.equal(value.sharedBufferView, null);
  }
}

// Canonical-JSON persistence must not erase graph topology from the transport.
{
  const encoded = encodeWorkerAnalysisPayload(fixture());
  assert.equal(encoded.codec, WORKER_ANALYSIS_PAYLOAD_CODEC_VERSION);
  assert.equal(encoded.codec, 'hex-worker-analysis-payload-v2');
  const persisted = JSON.parse(JSON.stringify(encoded));
  assertTopology(decodeWorkerAnalysisPayload(persisted));
}

// Standalone root views retain the pre-existing value-wire behavior when no
// separately reachable backing buffer identity can be lost.
{
  const buffer = new ArrayBuffer(8);
  new Uint8Array(buffer).set([0, 1, 2, 3, 4, 5, 6, 7]);
  const decoded = decodeWorkerAnalysisPayload(JSON.parse(JSON.stringify(
    encodeWorkerAnalysisPayload(new DataView(buffer, 1, 3)),
  )));
  assert.equal(decoded.buffer.byteLength, 3);
  assert.equal(decoded.byteOffset, 0);
  assert.equal(decoded.byteLength, 3);
  assert.deepEqual(Array.from(new Uint8Array(decoded.buffer)), [1, 2, 3]);
}

// Sparse arrays remain compatible for direct in-memory callers, but they are
// rejected before the ArtifactStore persistence path can produce a lossy wire payload.
{
  const sparse = [];
  sparse[1] = 'x';
  const encodedSparse = encodeWorkerAnalysisPayload(sparse);
  const directSparse = decodeWorkerAnalysisPayload(encodedSparse);
  assert.equal(directSparse.length, 2);
  assert.equal(0 in directSparse, false);
  assert.equal(directSparse[1], 'x');

  const persistedSparse = JSON.parse(JSON.stringify(encodedSparse));
  assert.throws(
    () => decodeWorkerAnalysisPayload(persistedSparse),
    /analysis-artifact-payload-node-invalid/,
  );

  const sparseWire = [];
  sparseWire[1] = { t:'string', v:'x' };
  assert.throws(
    () => decodeWorkerAnalysisPayload({
      codec:WORKER_ANALYSIS_PAYLOAD_CODEC_VERSION,
      root:{ t:'array', i:0, v:sparseWire },
    }),
    /analysis-artifact-payload-node-invalid/,
  );

  const sparseStore = new ArtifactStore({ backend:new MemoryArtifactBackend({ reason:'issue-4587-sparse-reject-test' }) });
  const sparseRuntime = new ArtifactAnalysisOrchestrator({ store:sparseStore });
  await assert.rejects(
    sparseRuntime.request({ descriptor:descriptor(), produce:async () => sparse }),
    /analysis-artifact-payload-sparse-array-unsupported/,
  );
  await sparseRuntime.close();
}

// The old v1 wire format remains readable while v2 gets a new artifact identity.
{
  const legacy = {
    codec:'hex-worker-analysis-payload-v1',
    root:{ t:'object', n:false, v:[['value', { t:'number', v:7 }]] },
  };
  assert.deepEqual(decodeWorkerAnalysisPayload(legacy), { value:7 });

  // Existing v2 value-based view nodes remain readable after the identity
  // preserving form is introduced.
  const legacyV2Views = decodeWorkerAnalysisPayload({
    codec:WORKER_ANALYSIS_PAYLOAD_CODEC_VERSION,
    root:{
      t:'object', i:0, n:false,
      v:[
        ['dataView', { t:'data-view', i:1, v:[1, 2, 3] }],
        ['typedArray', { t:'typed-array', i:2, c:'Uint16Array', v:[513] }],
      ],
    },
  });
  assert.deepEqual(Array.from(new Uint8Array(legacyV2Views.dataView.buffer)), [1, 2, 3]);
  assert.deepEqual(Array.from(legacyV2Views.typedArray), [513]);
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

  // Reference IDs are canonical non-negative safe integers; -0 must fail closed.
  assert.throws(
    () => decodeWorkerAnalysisPayload({
      codec:WORKER_ANALYSIS_PAYLOAD_CODEC_VERSION,
      root:{ t:'object', i:-0, n:false, v:[] },
    }),
    /analysis-artifact-payload-node-invalid/,
  );
  assert.throws(
    () => decodeWorkerAnalysisPayload({
      codec:WORKER_ANALYSIS_PAYLOAD_CODEC_VERSION,
      root:{
        t:'object', i:0, n:false,
        v:[
          ['completed', { t:'object', i:1, n:false, v:[] }],
          ['noncanonical', { t:'ref', i:-0 }],
        ],
      },
    }),
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

  const backing = { t:'array-buffer', i:1, v:[0, 0, 0, 0] };
  assert.throws(
    () => decodeWorkerAnalysisPayload({
      codec:WORKER_ANALYSIS_PAYLOAD_CODEC_VERSION,
      root:{ t:'data-view', i:0, b:backing, o:-0, l:0 },
    }),
    /analysis-artifact-payload-node-invalid/,
  );
  assert.throws(
    () => decodeWorkerAnalysisPayload({
      codec:WORKER_ANALYSIS_PAYLOAD_CODEC_VERSION,
      root:{ t:'typed-array', i:0, c:'Uint16Array', b:backing, o:1, l:1 },
    }),
    /analysis-artifact-payload-node-invalid/,
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
