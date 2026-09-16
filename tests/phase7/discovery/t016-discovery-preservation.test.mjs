import assert from 'node:assert/strict';
import test from 'node:test';
import { functionCandidates } from '../../../js/analysis/index.js';

const binding = { binaryId: 't016-binary', sourceHash: 'source-v1', snapshotId: 'snapshot-v1', architectureId: 'x86_64' };
function discover(sizeBytes, sourceHash = binding.sourceHash) {
  return functionCandidates({
    input: { image: { functions: [{ address: 0x1000, source: 'function_starts', ...(sizeBytes == null ? {} : { sizeBytes }) }] } },
    ...binding, sourceHash,
  });
}

test('T016 production discovery retains a start whose extent is unknown', async () => {
  const result = discover();
  assert.ok(result.artifact, 'production discovery must publish its canonical artifact');
  assert.equal(result.artifact.functionCandidates[0].extentState, 'unknown');
  const { discoveryArtifactForRebuild, verifyDiscoveryReparse } = await import('../../../js/analysis/discovery/artifact.js');
  const source = discoveryArtifactForRebuild(result.artifact, binding);
  assert.equal(source.functionCandidates[0].extentState, 'unknown');
  assert.equal(verifyDiscoveryReparse(source, discover(undefined, 'output-v1').artifact, { expectedOutputHash: 'output-v1' }).ok, true);
  assert.equal(verifyDiscoveryReparse(source, discover(16, 'output-v1').artifact, { expectedOutputHash: 'output-v1' }).ok, false,
    'an unchanged collision-ID set cannot authorize invented exact extent');
});

test('T016 typed identity rejects excessive sparse width and nesting before encoding', async () => {
  const { canonicalTypedValue } = await import('../../../js/analysis/discovery/canonical-value.js');
  assert.throws(() => canonicalTypedValue(new Array(1_000_000_000)), /budget|limit/);
  let nested = null;
  for (let depth = 0; depth < 512; depth += 1) nested = [nested];
  assert.throws(() => canonicalTypedValue(nested), /budget|limit/);
});
