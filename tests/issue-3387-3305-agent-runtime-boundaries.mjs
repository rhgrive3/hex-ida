import assert from 'node:assert/strict';
import { runAgent } from '../js/agent/runtime.js';

async function runSingleTool(step, budget = {}) {
  const seen = [];
  const llm = {
    async next({ observations }) {
      if (observations.length) return { answer:{ confidence:0 } };
      return step;
    },
  };
  const result = await runAgent({
    goal:'find strings',
    context:{
      async searchStrings(query) {
        seen.push(query);
        return [];
      },
    },
    llm,
    budget:{ maxToolCalls:2, timeoutMs:2000, ...budget },
  });
  return { result, seen };
}

for (const scalar of [0, false, '']) {
  const { result, seen } = await runSingleTool({ tool:'search_strings', args:scalar });
  assert.deepEqual(seen, [scalar], `args=${JSON.stringify(scalar)} must reach the tool unchanged`);
  assert.deepEqual(result.observations[0].request.args, [scalar]);
}

for (const scalar of [0, false, '']) {
  const { result, seen } = await runSingleTool({ tool:'search_strings', args:null, arguments:scalar });
  assert.deepEqual(seen, [scalar], `arguments=${JSON.stringify(scalar)} must be used when args is nullish`);
  assert.deepEqual(result.observations[0].request.args, [scalar]);
}

// #3305: a truthy non-function cancellation option is configuration noise, not
// permission to call an arbitrary value as a predicate.
const nonCallableCancellation = await runSingleTool(
  { tool:'search_strings', args:'needle' },
  { isCancelled:true },
);
assert.deepEqual(nonCallableCancellation.seen, ['needle']);
assert.equal(nonCallableCancellation.result.stats.toolCalls, 1);
assert.ok(!nonCallableCancellation.result.missingEvidence.includes('cancelled'));

// A real callback remains authoritative.
const callableCancellation = await runSingleTool(
  { tool:'search_strings', args:'never-runs' },
  { isCancelled:() => true },
);
assert.deepEqual(callableCancellation.seen, []);
assert.equal(callableCancellation.result.stats.toolCalls, 0);
assert.ok(callableCancellation.result.missingEvidence.includes('cancelled'));

console.log('issue #3387/#3305 agent runtime boundaries: PASS');
