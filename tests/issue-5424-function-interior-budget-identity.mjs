// Regression for #5424: interior addresses of one function share the
// canonical function-budget/cache identity. 0x1000/0x1004/0x1008 inside
// F:[0x1000,0x1020) cost one analysis slot, not three.
import assert from 'node:assert/strict';
import { runAgent } from '../js/agent/runtime.js';

{
  let turn = 0;
  const analyzed = [];
  const context = {
    program: {
      functionRange(addr) {
        if (addr >= 0x1000n && addr < 0x1020n) return { start: 0x1000n, end: 0x1020n };
        return null;
      },
    },
    analyze: async (addr) => { analyzed.push(addr.toString()); return { name: `fn_${addr}` }; },
    symbols: { functionAt: (addr) => (addr >= 0x1000n && addr < 0x1020n ? { start: 0x1000n, end: 0x1020n, name: 'F' } : null) },
    functionName: (addr) => (addr >= 0x1000n && addr < 0x1020n ? 'F' : null),
  };
  const llm = {
    async next() {
      turn += 1;
      if (turn === 1) return { tool: 'get_function', args: [0x1000n] };
      if (turn === 2) return { tool: 'get_function', args: [0x1004n] };
      if (turn === 3) return { tool: 'get_function', args: [0x1008n] };
      return { answer: { confidence: 0, missingEvidence: [] } };
    },
  };
  const result = await runAgent({ goal: 'interior identity', context, llm, maxFunctions: 1, maxToolCalls: 4 });
  assert.equal(result.missingEvidence.includes('function-budget'), false,
    'interior addresses of one function must not exhaust a one-function budget');
  assert.equal(analyzed.length, 1, 'the three interior addresses share one canonical analysis');
}

// A genuinely second function still consumes its own slot.
{
  let turn = 0;
  const context = {
    program: { functionRange(addr) { return (addr >= 0x1000n && addr < 0x1020n) ? { start: 0x1000n, end: 0x1020n } : (addr >= 0x2000n && addr < 0x2020n) ? { start: 0x2000n, end: 0x2020n } : null; } },
    analyze: async (addr) => ({ name: `fn_${addr}` }),
    symbols: { functionAt: (addr) => (addr >= 0x1000n && addr < 0x1020n ? { start: 0x1000n, end: 0x1020n, name: 'F' } : (addr >= 0x2000n && addr < 0x2020n ? { start: 0x2000n, end: 0x2020n, name: 'G' } : null)) },
    functionName: (addr) => (addr >= 0x1000n && addr < 0x1020n ? 'F' : (addr >= 0x2000n && addr < 0x2020n ? 'G' : null)),
  };
  const llm = {
    async next() {
      turn += 1;
      if (turn === 1) return { tool: 'get_function', args: [0x1000n] };
      if (turn === 2) return { tool: 'get_function', args: [0x2000n] };
      return { answer: { confidence: 0, missingEvidence: [] } };
    },
  };
  const result = await runAgent({ goal: 'two functions', context, llm, maxFunctions: 1, maxToolCalls: 4 });
  assert.equal(result.missingEvidence.includes('function-budget'), true, 'a second distinct function still exhausts the budget');
}

console.log('issue #5424 function interior budget identity regressions PASS');
