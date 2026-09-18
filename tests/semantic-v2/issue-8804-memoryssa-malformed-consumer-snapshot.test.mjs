// Review regression for #8804: consumer-side snapshot provenance must reject
// malformed non-null tokens before equality can collapse them to the same null.
import assert from 'node:assert/strict';
import test from 'node:test';

import { stableDigest } from '../../js/core/identity/index.js';
import { createSemanticCfg } from '../../js/semantics/cfg/index.js';
import { createSemanticIrFunction } from '../../js/semantics/ir/function.js';
import { MEMORY_SSA_BUILD_VERSION, buildMemorySsa } from '../../js/semantics/memoryssa/build.js';
import {
  CANONICAL_MEMORY_FORWARDING_CONSUMER,
  CANONICAL_MEMORY_FORWARDING_PURPOSE,
  forwardMemoryValue,
} from '../../js/semantics/memoryssa/queries.js';

function fixture() {
  const origin = { instructionIds: ['i'] };
  const ir = createSemanticIrFunction({
    functionId: 'f-8804-consumer',
    entryBlockId: 'entry',
    blocks: [{ id: 'entry', nodeIds: [], origin }],
    values: [],
    nodes: [],
    completeness: 'complete',
    unknowns: [],
    origin,
  });
  const cfg = createSemanticCfg({
    functionId: ir.functionId,
    entryBlockId: 'entry',
    blocks: [{ id: 'entry', successors: [] }],
  });
  const identity = {
    binaryId: 'binary-8804',
    sliceId: 'slice-8804',
    functionId: ir.functionId,
    snapshotId: 'snapshot-8804',
    semanticIrId: 'ir-8804',
    semanticIrContractVersion: ir.contractVersion,
    semanticIrDigest: stableDigest(ir),
    scalarSsaId: 'ssa-8804',
    scalarSsaBuildVersion: '1.0.0',
    scalarSsaDigest: 'ssa-digest-8804',
    memorySsaId: 'mssa-8804',
    memorySsaBuildVersion: MEMORY_SSA_BUILD_VERSION,
    analyzerVersion: 'memoryssa-8804',
  };
  return buildMemorySsa(ir, cfg, {
    identity,
    snapshotId: 'snapshot-8804',
    canonicalIrIdentity: {
      functionId: ir.functionId,
      semanticIrId: identity.semanticIrId,
      semanticIrContractVersion: identity.semanticIrContractVersion,
      semanticIrDigest: identity.semanticIrDigest,
    },
  });
}

test('#8804 malformed artifact and caller snapshots never authenticate each other', () => {
  const artifact = structuredClone(fixture());
  artifact.snapshotId = ['artifact-snapshot'];
  artifact.identity.snapshotId = ['identity-snapshot'];
  const result = forwardMemoryValue(artifact, 'unused', {
    functionId: artifact.functionId,
    snapshotId: ['caller-snapshot'],
    consumerId: CANONICAL_MEMORY_FORWARDING_CONSUMER,
    purpose: CANONICAL_MEMORY_FORWARDING_PURPOSE,
  });
  assert.equal(result.status, 'stale');
  assert.equal(result.reason, 'memoryssa-stale-snapshot');
});

test('#8804 malformed identity snapshot cannot authenticate a valid artifact snapshot', () => {
  const artifact = structuredClone(fixture());
  artifact.identity.snapshotId = ['snapshot-8804'];
  const result = forwardMemoryValue(artifact, 'unused', {
    functionId: artifact.functionId,
    snapshotId: 'snapshot-8804',
    consumerId: CANONICAL_MEMORY_FORWARDING_CONSUMER,
    purpose: CANONICAL_MEMORY_FORWARDING_PURPOSE,
  });
  assert.equal(result.status, 'stale');
  assert.equal(result.reason, 'memoryssa-identity-snapshot-mismatch');
});
