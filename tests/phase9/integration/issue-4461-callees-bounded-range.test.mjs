import assert from 'node:assert/strict';
import test from 'node:test';
import { createAgentTools } from '../../../js/agent/tools.js';

for (const range of [null, {}, { end: null }, { end: 0x1000n }, { end: 0xfffn }, { end: ['8192'] }, { start: 0x2000n, end: 0x3000n }]) {
  test(`unproven function range ${String(range?.end)} cannot query later functions`, async () => {
    let calls = 0;
    const tools = createAgentTools({ program: {
      functionRange: () => range,
      calleesOf() { calls++; return [{ addr: 0x5000n }, { addr: 0x6000n }]; },
    } });
    const result = await tools.get_callees(0x1000n);
    assert.equal(calls, 0);
    assert.deepEqual(result.results, []);
    assert.equal(result.supported, false);
    assert.equal(result.complete, false);
    assert.equal(result.truncated, true);
    assert.equal(result.total, null);
    assert.equal(result.reason, 'function-range-unavailable');
  });
}

test('a program without a range capability never receives an unbounded query', async () => {
  const tools = createAgentTools({ program: { calleesOf() { assert.fail('unbounded call'); } } });
  assert.equal((await tools.get_callees(0x1000n)).complete, false);
});

for (const end of [0x1100n, 0x1100, '0x1100']) {
  test(`a valid ${typeof end} end bounds the query and preserves results`, async () => {
    const tools = createAgentTools({ program: {
      functionRange: () => ({ start: 0x1000n, end }),
      calleesOf(start, bound) {
        assert.equal(start, 0x1000n);
        assert.equal(bound, 0x1100n);
        return [{ addr: 0x5000n }];
      },
    } });
    const result = await tools.get_callees(0x1000n);
    assert.equal(result.complete, true);
    assert.equal(result.total, 1);
    assert.equal(result.results[0].addr, 0x5000n);
  });
}

test('range provider failures retain their typed error', async () => {
  const tools = createAgentTools({ program: { functionRange() { throw new Error('backend failed'); } } });
  await assert.rejects(tools.get_callees(0x1000n), { code: 'tool-failed' });
});


test('real symbol-less ProgramIndex does not attribute a later function call to the query', async () => {
  const { ProgramIndex } = await import('../../../js/program.js');
  const scan = { callFrom: new BigUint64Array([0x1004n, 0x2004n]), callTo: new BigUint64Array([0x5000n, 0x6000n]) };
  const program = new ProgramIndex(scan);
  assert.equal(program.functionRange(0x1000n), null);
  const unknown = await createAgentTools({ program }).get_callees(0x1000n);
  assert.deepEqual(unknown.results, []);
  assert.equal(unknown.complete, false);
  const symbols = { functionCount: 2, functionAt: () => ({ start: 0x1000n, end: 0x1100n }) };
  const bounded = await createAgentTools({ program: new ProgramIndex(scan, symbols) }).get_callees(0x1000n);
  assert.deepEqual(bounded.results.map(r => r.addr), [0x5000n]);
});
