import assert from 'node:assert/strict';
import test from 'node:test';
import { buildSemanticModel } from '../../../js/blocks.js';
import { createAgentTools } from '../../../js/agent/tools.js';

const a = 0x1000n, b = 0x2000n;
const empty = buildSemanticModel([{ row: 0, address: a, mn: 'ret', ops: '' }], [], []);
const positive = buildSemanticModel([
  { row: 0, address: b, mn: 'mov', ops: 'w0, #123' },
  { row: 1, address: b + 4n, mn: 'ret', ops: '' },
], [], []);

for (const tool of ['find_constant', 'explain_evidence']) {
  for (const contextScope of [false, true]) {
    test(`${tool} reports ${contextScope ? 'context' : 'requested'} scope omitted by the function budget`, async () => {
      const called = [];
      const tools = createAgentTools({
        analyze: async address => { called.push(address); return address === a ? empty : positive; },
        candidateFunctions: contextScope ? [b] : [],
      }, { maxFunctions: 1 });
      const result = await tools[tool](tool === 'find_constant' ? 123 : 'unseen-evidence', { functions: contextScope ? [a] : [a, b] });
      assert.deepEqual(called, [a]);
      assert.deepEqual(result.results, []);
      assert.equal(result.complete, false);
      assert.equal(result.total, null);
      assert.equal(result.scopeTruncated, true);
      assert.equal(result.reason, 'function-budget');
    });
  }
  test(`${tool} deduplicates equivalent addresses before enforcing the budget`, async () => {
    let calls = 0;
    const tools = createAgentTools({ analyze: async () => { calls++; return empty; }, candidateFunctions: [a] }, { maxFunctions: 1 });
    const result = await tools[tool](tool === 'find_constant' ? 123 : 'absent', { functions: [a, '0x1000', { addr: a }] });
    assert.equal(calls, 1);
    assert.equal(result.scopeTruncated, false);
    assert.equal(result.complete, true);
  });
}

test('zero budget performs no work and never proves absence', async () => {
  const tools = createAgentTools({ analyze: async () => assert.fail('zero budget') }, { maxFunctions: 0 });
  const result = await tools.find_constant(123, { functions: [a] });
  assert.equal(result.complete, false);
  assert.equal(result.reason, 'function-budget');
});

test('all requested functions and their positive matches remain available within budget', async () => {
  const tools = createAgentTools({ analyze: async address => address === a ? empty : positive }, { maxFunctions: 2 });
  const result = await tools.find_constant(123, { functions: [a, b] });
  assert.equal(result.complete, true);
  assert.equal(result.scopeTruncated, false);
  assert.ok(result.results.some(row => row.function === b));
});

test('scope overflow stops pulling a stream immediately, closing its iterator', async () => {
  let pulled = 0, closed = false;
  function* candidates() {
    try { for (let i = 0; i < 100; i++) { pulled++; yield a + BigInt(i); } }
    finally { closed = true; }
  }
  const tools = createAgentTools({ analyze: async () => empty }, { maxFunctions: 1 });
  const result = await tools.find_constant(123, { functions: candidates() });
  assert.equal(result.scopeTruncated, true);
  assert.equal(pulled, 2);
  assert.equal(closed, true);
});
