import assert from 'node:assert/strict';
import test from 'node:test';

import { loadCorpus } from '../../../tools/validation/phase8/build-corpus.mjs';
import { decompileEntry, observationOf } from '../../../tools/validation/phase8/decompile-corpus.mjs';

const ID = 'quality.aggregate_array_stride.O2';
const corpus = loadCorpus();
const index = corpus.functions.findIndex(entry => entry.id === ID);
assert.ok(index >= 0, `${ID} must remain in the frozen Phase 8 corpus`);

function steppingClock(stepMs) {
  let elapsed = 0;
  return () => { elapsed += stepMs; return elapsed; };
}

function withSlowPerformanceClock(run) {
  const descriptor = Object.getOwnPropertyDescriptor(performance, 'now');
  let elapsed = 0;
  Object.defineProperty(performance, 'now', {
    configurable:true,
    value:() => { elapsed += 10; return elapsed; },
  });
  try { return run(); }
  finally {
    if (descriptor) Object.defineProperty(performance, 'now', descriptor);
    else delete performance.now;
  }
}

test('aggregate_array_stride.O2 keeps identical bindings and output under a slow injected clock', () => {
  const options = {
    index,
    decompilerTimeBudgetMs:20000,
    toolchain:corpus.toolchain ?? null,
  };
  const baseline = decompileEntry(corpus.functions[index], { ...options, transformClock:steppingClock(0) });
  const slow = withSlowPerformanceClock(() => decompileEntry(corpus.functions[index], {
    ...options,
    transformClock:steppingClock(10),
  }));

  assert.equal(baseline.failure ?? null, null);
  assert.equal(slow.failure ?? null, null);
  for (const [label, outcome] of [['baseline', baseline], ['slow clock', slow]]) {
    assert.equal(outcome.result.expressionHistoryBinding?.completeness, 'complete', `${label} expression bindings`);
    assert.equal(outcome.result.phase8Projection?.history?.completeness, 'complete', `${label} Phase 8 history`);
    assert.equal(outcome.result.renderProvenance?.completeness, 'complete', `${label} render provenance`);
  }
  assert.deepEqual(observationOf(corpus.functions[index], slow), observationOf(corpus.functions[index], baseline));
  assert.equal(slow.result.rewriteProof.length, baseline.result.rewriteProof.length,
    'a slow host must preserve every producer-event record');
  assert.equal(slow.result.renderProvenance.ledger.length, baseline.result.renderProvenance.ledger.length,
    'a slow host must preserve the complete render ledger');
});
