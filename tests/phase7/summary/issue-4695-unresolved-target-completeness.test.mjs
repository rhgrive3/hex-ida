import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyCallTargetProof, createFunctionSummary, summaryIsPure, summaryMayWriteRegion } from '../../../js/analysis/summary/contract.js';
import { buildLocalFunctionSummary } from '../../../js/analysis/summary/local.js';

const snapshotId = 'snapshot-4695';
function summarize(call = {}, options = {}) {
  const node = { id: 'call', kind: 'call', inputs: [], outputs: [], origin: { instructionIds: ['i-call'] },
    call: { completeness: 'complete', memoryRead: { scope: 'none' }, memoryWrite: { scope: 'none' },
      noreturn: false, mayThrow: false, ...call } };
  return buildLocalFunctionSummary({ functionId: 'caller', values: [], nodes: [node] }, {},
    { definitions: [], uses: [] }, null, { snapshotId, ...options }).summary;
}
for (const [name, call] of [
  ['absent identity', {}], ['empty candidates', { targetEntityIds: [] }],
  ['null identity', { targetEntityId: null }], ['malformed identity', { targetEntityId: ['callee'] }],
  ['blank identity', { targetEntityId: ' ' }],
  ['runtime target without a finite candidate universe', { targetValueIds: ['target'], targetEntityIds: [] }],
]) {
  test(`#4695: ${name} cannot disappear behind complete no-memory call fields`, () => {
    assert.equal(classifyCallTargetProof({ completeness: 'complete', ...call }).exhaustive, false);
    const summary = summarize(call);
    assert.equal(summary.status.completeness, 'partial');
    assert.equal(summaryIsPure(summary), false);
    assert.equal(summaryMayWriteRegion(summary, 'any'), true);
    assert.equal(summary.unknownCallEffects.length, 1);
    assert.equal(summary.unknownCallEffects[0].callSiteId, 'call');
    assert.ok(summary.memoryWriteRegions.some((effect) => effect.broad));
    assert.equal(summary.noreturn, 'unknown');
    assert.equal(summary.mayThrow, 'unknown');
  });
}
test('#4695: unresolved target has its own reason and remains distinct from a partial indirect set', () => {
  assert.equal(summarize().unknownCallEffects[0].reason, 'unresolved-target');
  const indirect = summarize({ targetEntityIds: ['A'], targetValueIds: ['target'], completeness: 'partial' });
  assert.equal(indirect.unknownCallEffects[0].reason, 'indirect-incomplete-target-set');
  assert.equal(indirect.indirectCallSets[0].exhaustive, false);
});
test('#4695: exact direct identity and an explicit ABI rule retain their resolved path', () => {
  const summary = summarize({ targetEntityIds: ['A'] });
  assert.equal(summary.status.completeness, 'complete');
  assert.equal(summaryIsPure(summary), true);
  assert.deepEqual(summary.directCalls[0].targetEntityIds, ['A']);
});
test('#4695: an identity-matched pure callee summary remains pure', () => {
  const callee = createFunctionSummary({ functionId: 'A', noreturn: false, mayThrow: false,
    status: { snapshotId, analyzerId: 'test', analyzerVersion: '1', completeness: 'complete' } });
  const summary = summarize({ targetEntityIds: ['A'] }, { calleeSummaries: new Map([['A', callee]]) });
  assert.equal(summary.status.completeness, 'complete');
  assert.equal(summaryIsPure(summary), true);
  assert.equal(summary.directCalls[0].summaryId, 'A');
});
test('#4695: an explicitly complete nonempty indirect target set is not downgraded', () => {
  const summary = summarize({ targetEntityIds: ['A', 'B'], targetValueIds: ['target'] });
  assert.equal(summary.status.completeness, 'complete');
  assert.equal(summary.indirectCallSets[0].exhaustive, true);
  assert.deepEqual(summary.indirectCallSets[0].candidateEntityIds, ['A', 'B']);
});
