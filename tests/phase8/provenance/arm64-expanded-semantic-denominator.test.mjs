import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { loadCorpus } from '../../../tools/validation/phase8/build-corpus.mjs';
import { closeSessions, decompileEntry } from '../../../tools/validation/phase8/decompile-corpus.mjs';
import { loadFrozenBaseline } from '../../../tools/validation/phase8/metrics.mjs';
import { validateRenderProvenance } from '../../../js/decompiler/phase8/render-provenance.js';

const EXPANDED_ARM64_CASES = Object.freeze([
  'quality.aggregate_array_stride.O0',
  'quality.dce_volatile_read.O1',
  'quality.dce_volatile_read.O2',
  'quality.gvn_call_barrier.O0',
  'quality.gvn_call_barrier.O1',
  'quality.gvn_call_barrier.O2',
  'quality.loop_counted_sum.O0',
  'quality.loop_decrement_step.O0',
  'quality.loop_early_exit.O0',
  'quality.loop_nested.O0',
]);

const corpus = loadCorpus();
const baseline = loadFrozenBaseline();
after(() => closeSessions());

test('ARM64 representative denominator expansions retain complete provenance', () => {
  assert.equal(corpus.functions.length, 135, 'the frozen denominator must stay at 135 cases');
  assert.deepEqual(
    EXPANDED_ARM64_CASES.map((id) => baseline.observations.find((entry) => entry.id === id)?.semantic),
    Array(EXPANDED_ARM64_CASES.length).fill(false),
    'the regression list must remain anchored to cases that were non-semantic in the frozen baseline',
  );

  const representatives = ['quality.aggregate_array_stride.O0', 'quality.gvn_call_barrier.O0', 'quality.loop_nested.O0'];
  for (const id of representatives) {
    const index = corpus.functions.findIndex((entry) => entry.id === id);
    assert.ok(index >= 0, `${id}: case must exist in the frozen 135-case corpus`);
    const entry = corpus.functions[index];
    assert.equal(entry.architectureId, 'arm64', `${id}: denominator expansion is ARM64-only`);

    const { result, failure } = decompileEntry(entry, {
      index,
      decompilerTimeBudgetMs: 20000,
      deterministicTransforms: true,
      phase8Optimize: false,
      toolchain: corpus.toolchain ?? null,
    });

    assert.equal(failure ?? null, null, `${id}: decompilation must complete`);
    assert.equal(result?.semantic, true, `${id}: must use the semantic pipeline`);
    assert.equal(result?.expressionHistoryBinding?.completeness, 'complete', `${id}: expression history binding`);
    assert.equal(result?.phase8Projection?.history?.completeness, 'complete', `${id}: projection history`);
    assert.equal(result?.renderProvenance?.completeness, 'complete', `${id}: render provenance`);
    assert.deepEqual(result?.renderProvenance?.reasons ?? [], [], `${id}: no incomplete-map reasons`);
    assert.equal(validateRenderProvenance(result.renderProvenance).state, 'complete', `${id}: map must validate`);
  }
});
