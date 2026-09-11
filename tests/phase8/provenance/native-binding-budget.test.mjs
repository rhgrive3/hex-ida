import assert from 'node:assert/strict';
import test from 'node:test';
import { loadCorpus } from '../../../tools/validation/phase8/build-corpus.mjs';
import { decompileEntry } from '../../../tools/validation/phase8/decompile-corpus.mjs';

test('C4-03 native aggregate loop binds every rendered entity within the unchanged default budget', () => {
  const corpus = loadCorpus();
  const index = corpus.functions.findIndex(entry => entry.id === 'quality.aggregate_array_stride.O1');
  assert.ok(index >= 0);
  const outcome = decompileEntry(corpus.functions[index], {
    index, decompilerTimeBudgetMs:20000, toolchain:corpus.toolchain ?? null,
  });
  assert.equal(outcome.failure ?? null, null);
  assert.ok(outcome.result?.ir);
  assert.deepEqual(outcome.result.expressionHistoryBinding.reasons, []);
  assert.equal(outcome.result.expressionHistoryBinding.completeness, 'complete');
  assert.equal(outcome.result.renderProvenance.completeness, 'complete');
  assert.deepEqual(outcome.result.renderProvenance.reasons, []);
  assert.equal(outcome.result.renderProvenance.counts.provenanceLoss, 0);
});
