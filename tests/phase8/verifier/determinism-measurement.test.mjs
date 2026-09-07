/**
 * The determinism metric must compare like with like.
 *
 * `transformDeterminismFailureCount` is a hard-zero exit gate, so what it
 * measures has to be the transform, not the clock. Deterministic measurement
 * mode deliberately ignores wall-clock allowances; a fixed work budget is the
 * reproducible truncation boundary.
 *
 * This pins the invariant rather than the symptom: a run at a different budget
 * is a different observation, and the metric's own run must use the caller's
 * budget.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { PHASE8_DEFAULT_WORK_BUDGET } from '../../../js/decompiler/phase8/index.js';
import { loadCorpus } from '../../../tools/validation/phase8/build-corpus.mjs';
import { observeCorpus } from '../../../tools/validation/phase8/decompile-corpus.mjs';
import { determinismFailures } from '../../../tools/validation/phase8/metrics.mjs';

// A few functions rather than the whole corpus: the point is the comparison
// rule, and one truncatable function proves it as well as forty-five do.
const corpus = loadCorpus();
const sample = {
  ...corpus,
  functions: corpus.functions.filter((entry) => ['quality.loop_nested.O2', 'quality.aggregate_array_stride.O2', 'quality.loop_counted_sum.O0'].includes(entry.id)),
};
const TIGHT_WORK_BUDGET = 1;
const COMPLETE_WORK_BUDGET = PHASE8_DEFAULT_WORK_BUDGET;

test('a deterministically truncated run and a complete run are different observations', () => {
  const tight = observeCorpus({ corpus: sample, phase8WorkBudget: TIGHT_WORK_BUDGET });
  const generous = observeCorpus({ corpus: sample, phase8WorkBudget: COMPLETE_WORK_BUDGET });
  assert.notDeepEqual(tight, generous,
    'the fixed work budget must change the observation when it withholds the optimizer ledger');
});

test('comparing runs made at different budgets reports failures that are not transform failures', () => {
  const tight = observeCorpus({ corpus: sample, phase8WorkBudget: TIGHT_WORK_BUDGET });
  assert.deepEqual(
    determinismFailures({ corpus: sample, first: tight, phase8WorkBudget: TIGHT_WORK_BUDGET }),
    [],
    'the metric must replay the supplied run with the same fixed work budget',
  );
  const failures = determinismFailures({ corpus: sample, first: tight, phase8WorkBudget: COMPLETE_WORK_BUDGET });
  assert.ok(failures.length > 0,
    'a mismatched work budget must be visible; if it is not, the metric is not comparing what it claims to');
});

test('the metric reports nothing when both runs share the work allowance', () => {
  const generous = observeCorpus({ corpus: sample, phase8WorkBudget: COMPLETE_WORK_BUDGET });
  assert.deepEqual(determinismFailures({ corpus: sample, first: generous, phase8WorkBudget: COMPLETE_WORK_BUDGET }), []);
});
