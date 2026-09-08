import assert from 'node:assert/strict';
import test from 'node:test';

import { deriveMemoryRegion } from '../../../js/analysis/alias/regions-v2.js';
import { createAnalysisStatus } from '../../../js/analysis/status.js';
import { solveInterproceduralSummaries, LIBRARY_MODEL_SCHEMA, LIBRARY_MODEL_VERSION,
  LIBRARY_MODEL_PROVENANCE_SCHEMA } from '../../../js/analysis/summary/interprocedural.js';
import {
  createFunctionSummary,
  summaryMayWriteRegion,
} from '../../../js/analysis/summary/contract.js';

const complete = createAnalysisStatus({
  snapshotId: 's4064-proof-merge',
  analyzerId: 'phase7.summary.local',
  analyzerVersion: '1.2.0',
  completeness: 'complete',
});

function stack(name, offset, widthBits) {
  return deriveMemoryRegion({
    functionId: 'fn4064-proof-merge',
    widthBits,
    origin: { instructionIds: [`instruction_${name}`] },
    regionEvidence: { kind: 'stack-fixed', offset },
  });
}

function effect(region, withProof) {
  return {
    regionId: region.id,
    regionKind: region.kind,
    ...(withProof ? { region } : {}),
    broad: false,
    addressSpaces: [region.addressSpace ?? 'memory'],
    source: 'proven-summary',
  };
}

function solveDuplicate(label, localEffect, modelEffect) {
  const callerId = `caller4064-${label}`;
  const modelId = `model4064-${label}`;
  const caller = createFunctionSummary({
    functionId: callerId,
    status: complete,
    noreturn: false,
    mayThrow: false,
    memoryWriteRegions: [localEffect],
    directCalls: [{
      callSiteId: `call4064-${label}`,
      targetEntityIds: [modelId],
      summaryId: modelId,
      effectSource: 'proven-summary',
    }],
  });
  const solved = solveInterproceduralSummaries({
    snapshotId: complete.snapshotId,
    roots: [callerId],
    localSummaries: new Map([[callerId, caller]]),
    libraryModels: new Map([[modelId, {
      modelSchema: LIBRARY_MODEL_SCHEMA, modelVersion: LIBRARY_MODEL_VERSION,
      targetEntityId: modelId, snapshotId: complete.snapshotId,
      completeness: 'complete', stopReason: null, current: true,
      provenance: { schema: LIBRARY_MODEL_PROVENANCE_SCHEMA, providerId: 'region-merge-test',
        providerVersion: '1', evidenceIds: [`model:${modelId}`] },
      memoryReadRegions: [],
      memoryWriteRegions: [{ ...modelEffect, source: 'library-model', evidenceIds: [`write:${modelId}`] }],
      escapes: [],
      noreturn: false,
      mayThrow: false,
    }]]),
  });
  return solved.summaries.get(callerId);
}

test('duplicate region proof stays fail-open when either input lacks geometry', () => {
  const write = stack('one-sided-proof', 0, 64);
  const disjoint = stack('one-sided-query', 8, 32);
  const proof = effect(write, true);
  const legacy = effect(write, false);

  for (const [label, localEffect, modelEffect] of [
    ['local-legacy', legacy, proof],
    ['model-legacy', proof, legacy],
  ]) {
    const result = solveDuplicate(label, localEffect, modelEffect);
    const merged = result.memoryWriteRegions.find((entry) => entry.regionId === write.id);
    assert.ok(merged, `missing merged effect for ${label}`);
    assert.equal('region' in merged, false, `${label} must not launder one-sided geometry`);
    assert.equal(summaryMayWriteRegion(result, disjoint), true,
      `${label} must remain may-write when duplicate geometry is unverifiable`);
  }
});

test('duplicate canonical proofs retain merged origin and NoAlias precision', () => {
  const left = stack('proof-left', 0, 64);
  const right = stack('proof-right', 0, 64);
  const disjoint = stack('proof-query', 8, 32);
  assert.equal(left.id, right.id, 'equal canonical geometry must share region identity');

  const result = solveDuplicate('both-proven', effect(left, true), effect(right, true));
  const merged = result.memoryWriteRegions.find((entry) => entry.regionId === left.id);
  assert.ok(merged?.region, 'two canonical proofs must retain region geometry');
  assert.deepEqual(
    merged.region.origin.instructionIds,
    ['instruction_proof-left', 'instruction_proof-right'],
  );
  assert.equal(summaryMayWriteRegion(result, disjoint), false,
    'two canonical proofs must retain proven disjoint NoWrite precision');
});
