import test from 'node:test';
import assert from 'node:assert/strict';
import { createAppAnalysisQueryAdapter } from '../js/analysis/query/app-adapter.js';

function createMockApp() {
  const names = new Map([
    [0x1000n, 'func_1000'],
    [0x2000n, 'func_2000'],
  ]);
  const symbols = {
    funcs: [0x1000n, 0x2000n],
    functionStartsComplete: true,
    functionAt(addr) {
      return { start: addr, end: addr + 0x20n };
    },
    nameAt(addr) {
      return names.get(addr) ?? null;
    },
  };
  return { symbols };
}

test('issue #6242: empty query returns normal function listing', async () => {
  const adapter = createAppAnalysisQueryAdapter(createMockApp());
  const res = await adapter.functions(null, {});
  assert.equal(res.status.completeness, 'complete');
  assert.deepEqual(res.value.map((f) => f.address), [0x1000n, 0x2000n]);
});

test('issue #6242: valid BigInt address filters to exact function', async () => {
  const adapter = createAppAnalysisQueryAdapter(createMockApp());
  const res = await adapter.functions(null, { address: 0x1000n });
  assert.equal(res.status.completeness, 'complete');
  assert.deepEqual(res.value.map((f) => f.address), [0x1000n]);
});

test('issue #6242: valid string address filters to exact function', async () => {
  const adapter = createAppAnalysisQueryAdapter(createMockApp());
  const res = await adapter.functions(null, { address: '0x2000' });
  assert.equal(res.status.completeness, 'complete');
  assert.deepEqual(res.value.map((f) => f.address), [0x2000n]);
});

test('issue #6242: non-numeric string address fails closed with function-query-address-invalid', async () => {
  const adapter = createAppAnalysisQueryAdapter(createMockApp());
  const res = await adapter.functions(null, { address: 'not-an-address' });
  assert.equal(res.status.completeness, 'unsupported');
  assert.equal(res.status.reason, 'function-query-address-invalid');
  assert.equal(res.value, null);
});

test('issue #6242: malformed object address fails closed with function-query-address-invalid', async () => {
  const adapter = createAppAnalysisQueryAdapter(createMockApp());
  const res = await adapter.functions(null, { address: { malformed: true } });
  assert.equal(res.status.completeness, 'unsupported');
  assert.equal(res.status.reason, 'function-query-address-invalid');
  assert.equal(res.value, null);
});

test('issue #6242: invalid address combined with text query fails closed', async () => {
  const adapter = createAppAnalysisQueryAdapter(createMockApp());
  const res = await adapter.functions(null, { address: 'invalid', text: 'func_1000' });
  assert.equal(res.status.completeness, 'unsupported');
  assert.equal(res.status.reason, 'function-query-address-invalid');
  assert.equal(res.value, null);
});

test('issue #6242: negative BigInt or string address fails closed', async () => {
  const adapter = createAppAnalysisQueryAdapter(createMockApp());
  const res1 = await adapter.functions(null, { address: -1n });
  assert.equal(res1.status.completeness, 'unsupported');
  assert.equal(res1.status.reason, 'function-query-address-invalid');

  const res2 = await adapter.functions(null, { address: '-0x1000' });
  assert.equal(res2.status.completeness, 'unsupported');
  assert.equal(res2.status.reason, 'function-query-address-invalid');
});
