import assert from 'node:assert/strict';
import test from 'node:test';
import { solveInterproceduralSummaries } from '../../../js/analysis/summary/interprocedural.js';

const STATUS = {
  snapshotId: 'snapshot_issue_6208', analyzerId: 'issue-6208-local', analyzerVersion: '1', completeness: 'complete',
};
function localSummary(functionId, markerRegion) {
  return {
    functionId, inputs: [], returnValues: [], returnProvenance: [], registerEffects: [], memoryReadRegions: [],
    memoryWriteRegions: [{ regionId: markerRegion, regionKind: 'global-absolute', broad: false,
      addressSpaces: ['memory'], source: 'proven-summary', evidenceIds: [`effect:${functionId}`] }],
    escapes: [], allocations: [], frees: [], directCalls: [], indirectCallSets: [], unknownCallEffects: [],
    noreturn: false, mayThrow: false, stackDelta: null, semanticFacts: [], status: STATUS,
  };
}
test('#6208 a local summary keyed under a foreign functionId fails closed', () => {
  const locals = new Map([['fn_A', localSummary('fn_B', 'region_of_B')]]);
  assert.throws(() => solveInterproceduralSummaries({ roots: ['fn_A'], localSummaries: locals }),
    /interprocedural-local-summary-identity-mismatch/);
});
test('#6208 correctly keyed local summaries still compose', () => {
  const locals = new Map([['fn_A', localSummary('fn_A', 'region_of_A')]]);
  const { summaries, status } = solveInterproceduralSummaries({ roots: ['fn_A'], localSummaries: locals });
  assert.equal(status.completeness, 'complete');
  assert.ok(summaries.get('fn_A').memoryWriteRegions.some((effect) => effect.regionId === 'region_of_A'));
});


function callerWith({ directCalls = [], indirectCallSets = [] } = {}) {
  return { ...localSummary('fn_A', 'region_of_A'), directCalls, indirectCallSets };
}
test('#6208 a mis-keyed reachable direct callee becomes unknown-call partial, not a solver throw', () => {
  const locals = new Map([
    ['fn_A', callerWith({ directCalls: [{ callSiteId: 'call_direct', targetEntityIds: ['fn_B'] }] })],
    ['fn_B', localSummary('fn_WRONG', 'region_of_wrong')],
  ]);
  const { summaries, status } = solveInterproceduralSummaries({ roots: ['fn_A'], localSummaries: locals });
  assert.equal(status.completeness, 'partial');
  const summary = summaries.get('fn_A');
  assert.ok(summary);
  assert.ok(summary.unknownCallEffects.some((effect) => effect.callSiteId === 'call_direct' && effect.reason === 'summary-missing' && effect.targetEntityIds.includes('fn_B')));
  assert.ok(summary.memoryWriteRegions.some((effect) => effect.broad === true));
});
test('#6208 a mis-keyed reachable indirect callee becomes unknown-call partial, not a solver throw', () => {
  const locals = new Map([
    ['fn_A', callerWith({ indirectCallSets: [{ callSiteId: 'call_indirect', candidateEntityIds: ['fn_B'], exhaustive: true }] })],
    ['fn_B', localSummary('fn_WRONG', 'region_of_wrong')],
  ]);
  const { summaries, status } = solveInterproceduralSummaries({ roots: ['fn_A'], localSummaries: locals });
  assert.equal(status.completeness, 'partial');
  const summary = summaries.get('fn_A');
  assert.ok(summary);
  assert.ok(summary.unknownCallEffects.some((effect) => effect.callSiteId === 'call_indirect' && effect.reason === 'summary-missing' && effect.targetEntityIds.includes('fn_B')));
  assert.ok(summary.memoryWriteRegions.some((effect) => effect.broad === true));
});