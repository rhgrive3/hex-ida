import assert from 'node:assert/strict';
import test from 'node:test';

import { createAppAnalysisQueryAdapter } from '../../js/analysis/query/app-adapter.js';

// Issue 6127: base-adapter callers must stay reachable past the 5000 prefix.
function makeCallersApp(count, { queryLimited = null } = {}) {
  const callers = Array.from({ length: count }, (_, i) => ({
    addr: 0x2000n + BigInt(i),
    site: 0x3000n + BigInt(i),
    count: 1,
  }));
  const requestedLimits = [];
  const program = {
    callersOf(_target, limit) {
      requestedLimits.push(limit);
      const page = [...callers.slice(0, limit)];
      Object.defineProperty(page, 'queryLimited', {
        value: queryLimited ?? callers.length > limit,
        enumerable: false,
        configurable: true,
      });
      page.complete = callers.length <= limit ? true : undefined;
      return page;
    },
  };
  const app = { ensureProgram: async () => program, store: { get: () => null } };
  return { app, callers, requestedLimits };
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

test('6127: a capped source preserves continuation after an empty page', async () => {
  const { app, requestedLimits } = makeCallersApp(5000, { queryLimited:true });
  const api = createAppAnalysisQueryAdapter(app);
  const first = await api.callers({}, 0x1000n, { offset:5000, limit:100 });
  assert.equal(first.page.returned, 0);
  assert.ok(first.page.next > 5000, 'a capped producer must advance beyond the empty-page offset');
  const second = await api.callers({}, 0x1000n, { offset:first.page.next, limit:100 });
  assert.equal(second.page.returned, 0);
  assert.notEqual(second.page.offset, first.page.offset, 'the next request must not repeat the capped offset');
  assert.deepEqual(requestedLimits, [5100, 5200], 'each request must ask the producer for a strictly later prefix');
});
test('6127: an overflowing cumulative offset fails closed before producer access', async () => {
  const { app, requestedLimits } = makeCallersApp(1);
  const api = createAppAnalysisQueryAdapter(app);
  const result = await api.callers({}, 0x1000n, { offset:Number.MAX_SAFE_INTEGER, limit:1 });
  assert.equal(result.value.length, 0);
  assert.equal(result.status.completeness, 'unsupported');
  assert.equal(result.status.reason, 'page-range-overflow');
  assert.equal(result.page.next, null, 'an unrepresentable continuation must terminate fail-closed');
  assert.deepEqual(requestedLimits, [], 'an overflowing cumulative limit must never reach callersOf');
});
test('6127: single-page limits stay bounded', async () => {
  const { app } = makeCallersApp(6000);
  const api = createAppAnalysisQueryAdapter(app);
  const result = await api.callers({}, 0x1000n, { offset: 0, limit: 50 });
  assert.equal(result.page.returned, 50);
  assert.equal(result.page.limit, 50);
});
