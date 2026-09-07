import assert from 'node:assert/strict';
import test from 'node:test';

import { createFunctionSummary, summaryIsPure } from '../../../js/analysis/summary/contract.js';
import { solveInterproceduralSummaries } from '../../../js/analysis/summary/interprocedural.js';
import { buildSummaryGraph } from '../corpus/summaries.mjs';

function exhaustiveCaller(candidateEntityIds, callSiteId = 'dispatch.issue3414') {
  const base = buildSummaryGraph('exhaustive-indirect');
  return createFunctionSummary({
    ...base.get('fn_dispatch_exact'),
    indirectCallSets: [{ callSiteId, candidateEntityIds, exhaustive: true }],
  });
}

test('#3414 exhaustive indirect candidate with no summary/model fails closed', () => {
  const caller = exhaustiveCaller(['fn_missing']);
  const summary = solveInterproceduralSummaries({
    roots: ['fn_dispatch_exact'],
    localSummaries: new Map([['fn_dispatch_exact', caller]]),
  }).summaries.get('fn_dispatch_exact');

  assert.ok(summary.memoryWriteRegions.some((effect) => effect.broad),
    'missing candidate semantics must contribute a conservative broad write');
  assert.ok(summary.unknownCallEffects.some((effect) =>
    effect.callSiteId === 'dispatch.issue3414'
    && effect.reason === 'library-model-missing'
    && effect.targetEntityIds.includes('fn_missing')),
  'missing external candidate must retain UnknownCallEffect provenance');
  assert.equal(summary.noreturn, 'unknown');
  assert.equal(summary.mayThrow, 'unknown');
  assert.notEqual(summary.status.completeness, 'complete');
  assert.equal(summaryIsPure(summary), false);
});

test('#3414 exhaustive indirect external candidate uses a library model', () => {
  const caller = exhaustiveCaller(['external_modeled'], 'dispatch.modeled');
  const summary = solveInterproceduralSummaries({
    roots: ['fn_dispatch_exact'],
    localSummaries: new Map([['fn_dispatch_exact', caller]]),
    libraryModels: new Map([['external_modeled', {
      memoryReadRegions: [{ regionId:'model-read', regionKind:'global-absolute', source:'library-model' }],
      memoryWriteRegions: [{ regionId:'model-write', regionKind:'global-absolute', source:'library-model' }],
      noreturn:false,
      mayThrow:true,
    }]]),
  }).summaries.get('fn_dispatch_exact');

  assert.ok(summary.memoryReadRegions.some((effect) => effect.regionId === 'model-read'));
  assert.ok(summary.memoryWriteRegions.some((effect) => effect.regionId === 'model-write'));
  assert.equal(summary.memoryWriteRegions.some((effect) => effect.broad), false,
    'a proven library model must not be replaced by an unknown broad effect');
  assert.equal(summary.unknownCallEffects.some((effect) => effect.callSiteId === 'dispatch.modeled'), false);
  assert.equal(summary.mayThrow, true);
  assert.equal(summary.status.completeness, 'complete');
});
