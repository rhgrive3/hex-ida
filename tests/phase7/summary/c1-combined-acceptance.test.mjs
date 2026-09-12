import assert from 'node:assert/strict';
import test from 'node:test';
import { analyzeLocalPointsTo } from '../../../js/analysis/pointsto/local.js';
import { buildLocalFunctionSummary } from '../../../js/analysis/summary/local.js';
import { createFunctionSummary, functionSummaryDigest } from '../../../js/analysis/summary/contract.js';
import { callerFixture, finiteSummary, RETURN_KINDS, SNAPSHOT } from '../helpers/c1-acceptance.mjs';

const MODES = Object.freeze(['complete', 'missing', 'stale', 'partial', 'unknown-return',
  'unknown-effects', 'wrong-function', 'wrong-contract', 'nonexhaustive']);

function altered(summary, mode) {
  if (mode === 'missing') return null;
  if (mode === 'wrong-contract') return { ...summary, contractVersion:'obsolete' };
  if (mode === 'wrong-function') return createFunctionSummary({ ...summary, functionId:'another-function' });
  if (mode === 'stale') return createFunctionSummary({ ...summary, status:{ ...summary.status, snapshotId:'stale' } });
  if (mode === 'partial') return createFunctionSummary({ ...summary, status:{ ...summary.status, completeness:'partial', stopReason:'dependency-missing' } });
  if (mode === 'unknown-return') return createFunctionSummary({ ...summary, returnProvenance:[{ kind:'unknown', returnIndex:0 }] });
  if (mode === 'unknown-effects') return createFunctionSummary({ ...summary,
    unknownCallEffects:[{ callSiteId:'unresolved-effect', reason:'summary-incomplete' }],
    status:{ ...summary.status, completeness:'partial', stopReason:'dependency-missing' },
    memoryWriteRegions:[{ broad:true, regionKind:'unknown', addressSpaces:['memory'], source:'unknown-call-fallback' }],
    noreturn:'unknown', mayThrow:'unknown' });
  return summary;
}

for (const kind of RETURN_KINDS) for (const count of [1, 2]) for (const mode of MODES) {
  test(`C1-02 producer/wrapper/spill ${kind}/${count}-targets/${mode}`, () => {
    const leaves = Array.from({ length:count }, (_unused, index) => `leaf_${index}`);
    const original = new Map(leaves.map((id, index) => [id, finiteSummary(kind, id, index)]));
    const wrappers = new Map();
    for (const [index, id] of leaves.entries()) {
      const f = callerFixture({ functionId:`wrapper_${index}`, targets:[id], spill:false, returnOffset:8 });
      const result = buildLocalFunctionSummary(f.ir, f.cfg, f.ssa, null, { snapshotId:SNAPSHOT, calleeSummaries:original });
      assert.equal(result.summary.returnProvenance.length, 1);
      assert.equal(result.summary.returnProvenance[0].kind, kind);
      assert.equal(result.summary.returnProvenance[0].offset, String(24 + 16 * index));
      wrappers.set(result.summary.functionId, result.summary);
    }
    const targets = [...wrappers.keys()];
    // Poison every possible position, not just the first candidate visited.
    for (const poisoned of targets) {
      const summaries = new Map(wrappers), replacement = altered(summaries.get(poisoned), mode);
      if (replacement) summaries.set(poisoned, replacement); else summaries.delete(poisoned);
      const f = callerFixture({ targets, incompleteCall:mode === 'nonexhaustive' });
      const before = [...summaries].map(([id, summary]) => [id, functionSummaryDigest(summary)]);
      const result = analyzeLocalPointsTo(f.ir, f.cfg, f.ssa, { snapshotId:SNAPSHOT, memorySsa:f.memorySsa, summaries });
      const loaded = result.pointsTo.get('loaded');
      if (mode === 'complete') {
        assert.equal(loaded.top, false);
        assert.equal(loaded.targets.length, kind === 'arg' ? 1 : count);
        assert.deepEqual(loaded.targets.map(target => [target.offsetRange.min, target.offsetRange.max]).sort(),
          kind === 'arg' ? [[24n, BigInt(24 + 16 * (count - 1))]]
            : leaves.map((_id, index) => [BigInt(24 + 16 * index), BigInt(24 + 16 * index)]).sort());
        assert.deepEqual(result.calleeSummaryIds, [...summaries.values()].map(summary => `summary:${functionSummaryDigest(summary)}`).sort());
      } else {
        assert.equal(loaded.top, true, `${poisoned}: cannot retain only the good candidates`);
        assert.equal(loaded.targets.length, 0);
        assert.equal(result.pointsTo.get('field').top, true);
      }
      assert.deepEqual([...summaries].map(([id, summary]) => [id, functionSummaryDigest(summary)]), before);
    }
  });
}

test('C1-02 every wrapper digest change invalidates the actual spill consumer', () => {
  const targets = ['leaf_a', 'leaf_b'];
  const summaries = new Map(targets.map((id, index) => [id, finiteSummary('root', id, index)]));
  const f = callerFixture({ targets });
  const run = supplied => analyzeLocalPointsTo(f.ir, f.cfg, f.ssa, { snapshotId:SNAPSHOT, memorySsa:f.memorySsa, summaries:supplied });
  const initial = run(summaries);
  for (const id of targets) {
    const changed = new Map(summaries), old = summaries.get(id);
    changed.set(id, createFunctionSummary({ ...old, returnProvenance:old.returnProvenance.map(fact => ({ ...fact, offset:'48' })) }));
    const result = run(changed);
    assert.equal(result.pointsTo.get('loaded').top, false);
    assert.notDeepEqual(result.pointsTo.get('loaded'), initial.pointsTo.get('loaded'));
    assert.notDeepEqual(result.calleeSummaryIds, initial.calleeSummaryIds);
    assert.ok(!result.calleeSummaryIds.includes(`summary:${functionSummaryDigest(old)}`));
    assert.deepEqual(run(summaries).pointsTo.get('loaded'), initial.pointsTo.get('loaded'));
  }
});

test('C1-02 a provider cancellation cannot leave a precise downstream field', () => {
  for (const cancelledId of ['leaf_a', 'leaf_b']) {
    const f = callerFixture({ targets:['leaf_a', 'leaf_b'] }), controller = new AbortController();
    const result = analyzeLocalPointsTo(f.ir, f.cfg, f.ssa, { snapshotId:SNAPSHOT, memorySsa:f.memorySsa,
      signal:controller.signal, summaryProvider(id) {
        if (id === cancelledId) controller.abort();
        return finiteSummary('root', id, id === 'leaf_a' ? 0 : 1);
      } });
    assert.equal(result.status.stopReason, 'cancelled');
    assert.equal(result.pointsTo.get('loaded').top, true);
    assert.equal(result.pointsTo.get('field').top, true);
  }
});
