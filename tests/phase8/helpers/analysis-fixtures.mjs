import assert from 'node:assert/strict';
import { ANALYSIS_KEYS, createPassDescriptor, createPassResult } from '../../../js/decompiler/phase8/contract.js';
import { runPassTransaction } from '../../../js/decompiler/phase8/transaction.js';

// Test fixtures use the same staging/commit boundary as product passes. Never
// restore the removed __write capability on authoritative analysis state.
export function publishFixtureAnalyses(state, facts) {
  const produced = Object.keys(facts);
  const descriptor = createPassDescriptor({
    id: 'phase8.test-fixture-producer', version: '1', stage: 'canonical-facts',
    produces: produced, preserves: ANALYSIS_KEYS.filter(key => !produced.includes(key)),
  });
  const outcome = runPassTransaction(state, {
    descriptor,
    run(_context, _budget, area) {
      for (const key of produced) area.stage(key, facts[key]);
      return createPassResult({ descriptor, status: 'changed', completeness: 'complete', produced });
    },
  }, { analysis: state }, {});
  assert.equal(outcome.committed, true, outcome.stopReason);
  for (const key of produced) assert.equal(state.get(key), facts[key]);
  return state;
}
