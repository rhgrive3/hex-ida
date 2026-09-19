import assert from 'node:assert/strict';
import test from 'node:test';

import { createAnalysisStatus } from '../../js/analysis/status.js';
import { createFunctionSummary } from '../../js/analysis/summary/contract.js';
import { solveInterproceduralSummaries } from '../../js/analysis/summary/interprocedural.js';

function fixture(count = 256) {
  const snapshotId = 'return-provenance-indexing';
  const status = createAnalysisStatus({ snapshotId, analyzerId:'phase7.summary.local', analyzerVersion:'1.0.0', completeness:'complete' });
  const callee = createFunctionSummary({
    functionId:'callee',
    returnValues:Array.from({ length:count }, (_, index) => `callee_ret_${index}`),
    returnProvenance:Array.from({ length:count }, (_, index) => ({
      kind:'root', rootEntityId:`root_${index}`, addressSpace:'memory', returnIndex:index, offset:'0',
    })),
    status,
  });
  const returnValues = Array.from({ length:count }, (_, index) => `ret_${index}`);
  const digest = 'return-source-digest';
  const caller = createFunctionSummary({
    functionId:'caller', returnValues,
    directCalls:[{ callSiteId:'call', targetEntityIds:['callee'], effectSource:'proven-summary' }],
    returnProvenance:Array.from({ length:count }, (_, index) => ({ kind:'unknown', returnIndex:index })),
    returnSourceDigest:digest,
    returnEquations:{
      version:2, source:{ functionId:'caller', snapshotId, digest },
      sites:returnValues.map((valueId, index) => ({ siteId:`site_${index}`, valueId, returnIndex:index, alternativeCount:1 })),
      rows:returnValues.map((valueId, index) => ({ siteId:`site_${index}`, valueId, returnIndex:index, alternativeIndex:0,
        kind:'call', callSiteId:'call', callReturnIndex:index, offset:'0', arguments:[] })),
    },
    status,
  });
  return { snapshotId, caller, callee };
}

test('interprocedural return equations index solved callee provenance by return position once', () => {
  const { snapshotId, caller, callee } = fixture();
  const originalFilter = Array.prototype.filter;
  let returnVectorFilters = 0;
  Array.prototype.filter = function patchedFilter(...args) {
    if (String(args[0]).includes('(fact.returnIndex ?? 0) === row.callReturnIndex')) returnVectorFilters += 1;
    return Reflect.apply(originalFilter, this, args);
  };
  let solved;
  try {
    solved = solveInterproceduralSummaries({ roots:['caller'], localSummaries:new Map([['caller', caller], ['callee', callee]]), snapshotId });
  } finally {
    Array.prototype.filter = originalFilter;
  }
  const summary = solved.summaries.get('caller');
  assert.equal(solved.status.completeness, 'complete');
  assert.equal(summary.returnProvenance.length, 256);
  assert.equal(returnVectorFilters, 0, `solver filtered the complete callee return vector ${returnVectorFilters} times`);
});
