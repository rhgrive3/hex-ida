import assert from 'node:assert/strict';
import test from 'node:test';

import {
  discoveryArtifactForRebuild,
  verifyDiscoveryReparse,
} from '../../../js/analysis/discovery/artifact.js';
import {
  DiscoveryProducerRegistry,
  fuseFunctionCandidates,
} from '../../../js/analysis/discovery/fusion.js';
import { GENERIC_PRODUCERS } from '../../../js/analysis/discovery/producers.js';

const binding = Object.freeze({
  binaryId: 't035-binary',
  sourceHash: 'source-v1',
  snapshotId: 'snapshot-v1',
  architectureId: 'x86_64',
});

function discover({ sourceHash = binding.sourceHash, sizeBytes = 0x20, withData = true } = {}) {
  const registry = new DiscoveryProducerRegistry();
  for (const producer of GENERIC_PRODUCERS) registry.register(producer);

  const input = {
    image: {
      // The byte span is readable independently of the discovery claims. The
      // second loader start deliberately sits inside the first claimed range,
      // so the artifact must retain that ambiguity for a writer to resolve.
      code: Uint8Array.from({ length: 0x40 }, (_, index) => index),
      codeBaseAddress: 0x1000,
      functions: [
        { address: 0x1000, source: 'function_starts', sizeBytes },
        { address: 0x1010, source: 'function_starts' },
      ],
      relocationTargets: [{ address: 0x1008, id: 'reloc-1', sourceAddress: 0x2000 }],
    },
  };
  const byteIntervals = withData ? [{
    start: 0x1008,
    end: 0x1010,
    kind: 'data',
    producerId: 'discovery.references',
    producerVersion: '2',
    evidenceIds: ['reloc-1'],
  }] : [];
  const intervalCounts = new Map([
    ['discovery.references', byteIntervals.length],
  ]);
  const collected = registry.collect(input, binding.architectureId, {
    ...binding,
    sourceHash,
  }, intervalCounts);
  return fuseFunctionCandidates(collected.evidence, {
    ...binding,
    sourceHash,
    producerRuns: collected.producerRuns,
    byteIntervals,
  });
}

test('T035 keeps code/data/relocation ambiguity in a reassemblable binding', () => {
  const result = discover();
  assert.equal(result.status.completeness, 'complete');
  assert.equal(result.artifact.publication.status, 'complete');

  const collisionKinds = new Set(result.artifact.collisionSets.map((collision) => collision.kind));
  assert.equal(collisionKinds.has('code-data'), true);
  assert.equal(collisionKinds.has('code-data-reference'), true);
  assert.equal(collisionKinds.has('function-contained-start'), true);
  assert.deepEqual(
    result.artifact.intervalClaims.map(({ kind, start, end }) => ({ kind, start, end })),
    [
      { kind: 'code', start: '4096', end: '4128' },
      { kind: 'data', start: '4104', end: '4112' },
    ],
  );

  const source = discoveryArtifactForRebuild(result.artifact, binding);
  const reparsed = discover({ sourceHash: 'output-v1' });
  assert.equal(
    verifyDiscoveryReparse(source, reparsed.artifact, { expectedOutputHash: 'output-v1' }).ok,
    true,
  );

  // A writer cannot narrow an unknown/overlapping source claim merely by
  // producing a shorter extent or by dropping the readable data interval.
  assert.equal(
    verifyDiscoveryReparse(
      source,
      discover({ sourceHash: 'output-v1', sizeBytes: 0x10 }).artifact,
      { expectedOutputHash: 'output-v1' },
    ).ok,
    false,
  );
  assert.equal(
    verifyDiscoveryReparse(
      source,
      discover({ sourceHash: 'output-v1', withData: false }).artifact,
      { expectedOutputHash: 'output-v1' },
    ).ok,
    false,
  );
});
