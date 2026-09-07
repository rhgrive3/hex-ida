import assert from 'node:assert/strict';
import test from 'node:test';

import { createAppAnalysisQueryAdapter } from '../../js/analysis/query/app-adapter.js';

// Issue 6127: base-adapter callers must stay reachable past the 5000 prefix.
function makeCallersApp(count) {
  const callers = Array.from({ length: count }, (_, i) => ({
    addr: 0x2000n + BigInt(i),
    site: 0x3000n + BigInt(i),
    count: 1,
  }));
  const program = {
    callersOf(_target, limit) {
      const page = [...callers.slice(0, limit)];
      Object.defineProperty(page, 'queryLimited', {
        value: callers.length > limit,
        enumerable: false,
        configurable: true,
      });
      page.complete = callers.length <= limit ? true : undefined;
      return page;
    },
  };
  const app = { ensureProgram: async () => program, store: { get: () => null } };
  return { app, callers };
}

test('6127: the 5001st caller is reachable via continuation', async () => {
  const { app } = makeCallersApp(5001);
  const api = createAppAnalysisQueryAdapter(app);
  let offset = 0;
  const seen = [];
  for (let steps = 0; steps < 10; steps++) {
    const result = await api.callers({}, 0x1000n, { offset, limit: 2000 });
    seen.push(...result.value);
    if (result.page.next == null) break;
    offset = result.page.next;
  }
  assert.equal(seen.length, 5001, 'continuation must reach every caller');
  assert.equal(new Set(seen.map((row) => String(row.addr))).size, 5001, 'no caller may be lost or duplicated');
});

test('6127: 4999/5000/5001 boundaries have no gap or overlap', async () => {
  const { app } = makeCallersApp(5001);
  const api = createAppAnalysisQueryAdapter(app);
  const at4999 = await api.callers({}, 0x1000n, { offset: 4999, limit: 1 });
  assert.equal(at4999.page.returned, 1);
  assert.equal(at4999.value[0].addr, 0x2000n + 4999n);
  const at5000 = await api.callers({}, 0x1000n, { offset: 5000, limit: 1 });
  assert.equal(at5000.page.returned, 1, 'offset 5000 must not be an empty terminal page');
  assert.equal(at5000.value[0].addr, 0x2000n + 5000n);
  assert.equal(at5000.page.next, null, 'the final record ends the walk');
});

test('6127: a truncated source never reports returned:0 with next:null', async () => {
  const { app } = makeCallersApp(6000);
  const api = createAppAnalysisQueryAdapter(app);
  const result = await api.callers({}, 0x1000n, { offset: 5000, limit: 100 });
  assert.equal(result.page.returned, 100);
  assert.equal(result.page.next, 5100);
});

test('6127: single-page limits stay bounded', async () => {
  const { app } = makeCallersApp(6000);
  const api = createAppAnalysisQueryAdapter(app);
  const result = await api.callers({}, 0x1000n, { offset: 0, limit: 50 });
  assert.equal(result.page.returned, 50);
  assert.equal(result.page.limit, 50);
});
