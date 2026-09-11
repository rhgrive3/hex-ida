import assert from 'node:assert/strict';
import test from 'node:test';
import { loadCorpus } from '../../../tools/validation/phase8/build-corpus.mjs';
import { decompileEntry, provenanceFromSourceMap } from '../../../tools/validation/phase8/decompile-corpus.mjs';
import { loadFrozenProvenance } from '../../../tools/validation/phase8/metrics.mjs';

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

for (const optimization of ['O1','O2']) for (const phase8Optimize of [false,true]) {
  test(`C4-03 native x86 call barrier retains consumed state origins (${optimization}, optimize=${phase8Optimize})`, () => {
    const corpus = loadCorpus(), id = `x86_64.quality.gvn_call_barrier.${optimization}`;
    const index = corpus.functions.findIndex(entry => entry.id === id);
    assert.ok(index >= 0);
    const reference = loadFrozenProvenance().observations.find(entry => entry.id === id);
    const outcome = decompileEntry(corpus.functions[index], {
      index, phase8Optimize, decompilerTimeBudgetMs:20000, toolchain:corpus.toolchain ?? null,
    });
    assert.equal(outcome.failure ?? null, null);
    const actual = provenanceFromSourceMap(outcome.result.sourceMap);
    assert.deepEqual(reference.sourceAddresses.filter(address => !actual.sourceAddresses.includes(address)), []);
  });
}
