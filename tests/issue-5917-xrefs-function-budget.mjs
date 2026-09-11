// Regression for #5917: runAgent() counted get_xrefs' first argument as
// function analysis, but get_xrefs queries arbitrary target addresses
// (strings/data/globals; the query planner routes data addresses through it)
// and its own cost contract is `functions: 0`. Two data-address xref lookups
// with maxFunctions:1 stopped the agent before the second lookup without any
// function analysis having happened. get_xrefs is no longer in the
// function-budget tool set.
import assert from 'node:assert/strict';
import { runAgent } from '../js/agent/runtime.js';

{
  let turn = 0;
  const executed = [];
  const llm = {
    async next() {
      turn += 1;
      if (turn === 1) return { tool: 'get_xrefs', args: [0x2000n] };
      if (turn === 2) return { tool: 'get_xrefs', args: [0x3000n] };
      return { answer: { confidence: 0, missingEvidence: [] } };
    },
  };
  const context = {
    program: {
      refSitesTo() { executed.push('xref'); return []; },
      functionsReferencing() { return []; },
    },
  };
  const result = await runAgent({ goal: 'xref budget repro', context, llm, maxFunctions: 1, maxToolCalls: 4 });
  assert.equal(executed.length, 2, 'both data-address xref queries must execute under a tight function budget');
  assert.ok(!result.missingEvidence.includes('function-budget'),
    'function-budget termination must be recorded in missingEvidence');
}
