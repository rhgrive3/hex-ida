import test from 'node:test';
import assert from 'node:assert/strict';
import { nativeWorkerFixture } from './native-worker-fixture.mjs';
import { captured, callee, scope } from './native-owner-fixture.mjs';
import { workFor } from './helpers.mjs';
import { buildCanonicalQueryProjection } from '../../js/analysis/query/semantic/projection.js';
import { indexScopedFunctionEntries } from '../../js/analysis/query/semantic/call-targets.js';
import { bindScopedSummaryCallCandidates } from '../../js/analysis/summary/scoped-call-candidates.js';
import { projectScopedLocalOwners } from '../../js/analysis/scoped-local-projection.js';
import { createFunctionSummary } from '../../js/analysis/summary/contract.js';
async function complete(f, request) {
  let r = await f.invoke('summarySlice', request), steps = 0;
  while (r.continuation) { assert.ok(++steps < 16); r = await f.invoke('resumeSummarySlice', { cursor: r.continuation.cursor }); }
  return r;
}
test('native source-bound selected call reaches the existing summary SCC without removing fallback', async t => {
  const f = await nativeWorkerFixture(t), r = await complete(f, { functionIds: ['0x1000', '0x2000'] });
  assert.equal(r.executionStatus, 'completed'); assert.equal(r.semanticClosure, 'unknown'); assert.equal(r.exact, false);
  assert.equal(r.callCandidateBindings.bindings.length, 1); assert.equal(r.callCandidateBindings.publication, 'none');
  const binding = r.callCandidateBindings.bindings[0];
  assert.equal(binding.source, 'canonical-literal-to-selected-entry');
  const summary = r.summaries.find(x => x.functionId === binding.callerFunctionId).summary;
  assert.deepEqual(summary.indirectCallSets[0].candidateEntityIds, [binding.targetFunctionId]);
  assert.equal(summary.indirectCallSets[0].exhaustive, false); assert.equal(summary.unknownCallEffects.length, 1);
  assert.ok(summary.memoryWriteRegions.some(x => x.broad)); assert.equal(summary.mayThrow, 'unknown');
  assert.equal(r.context, 'context-insensitive'); assert.equal(r.preparation.sourceInputsRetained, false);
  assert.equal(f.counters.workers, 2);
});
test('a literal target outside selected summary inputs remains open and is not loaded', async t => {
  const f = await nativeWorkerFixture(t), r = await complete(f, { functionIds: ['0x1000'] });
  assert.equal(r.callCandidateBindings.bindings.length, 0);
  assert.ok(r.callCandidateBindings.remaining.some(x => x.reason === 'literal-target-outside-selected-entries'));
  assert.equal(r.summaries[0].summary.indirectCallSets[0].candidateEntityIds.length, 0);
  assert.equal(f.counters.workers, 1);
});
test('summary continuation is single-use and preserves work while loading one function per step', async t => {
  const f = await nativeWorkerFixture(t); let r = await f.invoke('summarySlice', { functionIds: ['0x1000','0x2000'] });
  assert.equal(r.preparation.loadedFunctions, 1); const cursor = r.continuation.cursor;
  r = await f.invoke('resumeSummarySlice', { cursor }); assert.equal(r.preparation.loadedFunctions, 2);
  await assert.rejects(f.invoke('resumeSummarySlice', { cursor })); assert.equal(f.counters.workers, 2);
});
async function canonicalPair(t) {
  const f = scope(), a = captured(), c = captured(0x2000n, callee);
  const project = async x => {
    const p = await buildCanonicalQueryProjection(x.result.pipeline, { ...f, snapshotId: 'snap', work: workFor(t),
      sourceLocation: { start: x.base, end: x.base + BigInt(x.rows.length * 4), snapshotId: 'snap' } });
    t.after(() => p.release()); return p;
  };
  const p = await project(a), q = await project(c), index = indexScopedFunctionEntries([p,q]);
  // Obtain the real canonical local summary from the captured existing owner.
  const summary = projectScopedLocalOwners(a.result, { kind: 'summary', worldId: f.world.id, snapshotId: 'snap' }).summary;
  return { ...f, a, p, q, index, summary };
}
test('candidate linking rejects a changed canonical summary function or snapshot', async t => {
  const f = await canonicalPair(t);
  assert.ok(f.summary, 'canonical-local-summary-required');
  for (const mutate of [s => { s.functionId = f.q.functionId; }, s => { s.status.snapshotId = 'later'; }]) {
    const summary = structuredClone(f.summary); mutate(summary);
    await assert.rejects(bindScopedSummaryCallCandidates(summary, f.p, f.index, { ...f, snapshotId: 'snap', work: workFor(t) }), /link-owner/);
  }
});
test('zero candidate budget retains the original canonical summary and its unknown effects', async t => {
  const f = await canonicalPair(t);
  const r = await bindScopedSummaryCallCandidates(f.summary, f.p, f.index, { ...f, snapshotId: 'snap', work: workFor(t), maximumBindings: 0 });
  assert.equal(r.summary, f.summary); assert.equal(r.bindings.length, 0);
  assert.ok(r.skipped.some(row => row.reason === 'candidate-link-limit'));
});
test('candidate-only linking preserves every canonical field except its nonexhaustive candidate list', async t => {
  const f = await canonicalPair(t);
  const r = await bindScopedSummaryCallCandidates(f.summary, f.p, f.index, { ...f, snapshotId: 'snap', work: workFor(t) });
  for (const key of Object.keys(f.summary)) if (key !== 'indirectCallSets') assert.deepEqual(r.summary[key], f.summary[key], key);
  assert.equal(r.bindings.length, 1); assert.equal(r.summary.indirectCallSets[0].exhaustive, false);
  assert.deepEqual(createFunctionSummary(r.summary), r.summary);
});

test('budget interruption before link commit resumes without duplicate candidates or worker reloads', async t => {
  const f = await nativeWorkerFixture(t);
  let r = await f.invoke('summarySlice', { functionIds: ['0x1000', '0x2000'] });
  r = await f.invoke('resumeSummarySlice', { cursor: r.continuation.cursor });
  r = await f.invoke('resumeSummarySlice', { cursor: r.continuation.cursor }, { workUnits: 1 });
  assert.equal(r.executionStatus, 'budget-exhausted'); assert.equal(r.preparation.linkedFunctions, 0);
  assert.equal(r.callCandidateBindings.bindings.length, 0);
  let steps = 0;
  while (r.continuation) { assert.ok(++steps < 16); r = await f.invoke('resumeSummarySlice', { cursor: r.continuation.cursor }); }
  assert.equal(r.executionStatus, 'completed'); assert.equal(r.callCandidateBindings.bindings.length, 1);
  assert.equal(f.counters.workers, 2);
});
test('partial external function entries are not silently converted into closed dispatch', async t => {
  const f = await canonicalPair(t), index = indexScopedFunctionEntries([f.p]);
  const r = await bindScopedSummaryCallCandidates(f.summary, f.p, index, { ...f, snapshotId: 'snap', work: workFor(t) });
  assert.equal(r.summary, f.summary); assert.equal(r.bindings.length, 0); assert.equal(r.targetClosure, 'unknown');
});
