import test from 'node:test';
import assert from 'node:assert/strict';

import { createAppAnalysisQueryAdapter } from '../../js/analysis/query/product-evidence-adapter.js';

function evidenceRows(count) {
  return Array.from({ length: count }, (_, i) => ({ id: `e${i}`, verdict: 'supported' }));
}

function adapterFor(rows, extra = {}) {
  const calls = [];
  const app = {
    async getEvidence(query, options) {
      calls.push({ query, options });
      return rows;
    },
    ...extra,
  };
  return { adapter: createAppAnalysisQueryAdapter(app), calls };
}

async function collect(adapter, query = {}, limit = 5_000) {
  const seen = [];
  let offset = 0;
  for (let pages = 0; pages < 100; pages += 1) {
    const result = await adapter.evidence({}, query, { offset, limit });
    seen.push(...result.value.map((row) => row.evidenceId));
    if (result.page.next == null) return { seen, result, pages: pages + 1 };
    assert.ok(result.page.next > offset, 'continuation must advance');
    offset = result.page.next;
  }
  assert.fail('evidence pagination did not terminate');
}

test('4999 and exact-5000 upstream rows terminate complete without a phantom continuation', async () => {
  for (const count of [4_999, 5_000]) {
    const { adapter } = adapterFor(evidenceRows(count));
    const { seen, result } = await collect(adapter);
    assert.equal(seen.length, count);
    assert.equal(seen[0], 'e0');
    assert.equal(seen.at(-1), `e${count - 1}`);
    assert.equal(result.status.completeness, 'complete');
    assert.equal(result.page.next, null);
    assert.equal(result.page.total, count);
  }
});

test('row 5001 remains reachable and upstream offset authority advances past the former cap', async () => {
  const rows = evidenceRows(5_001);
  const { adapter } = adapterFor(rows);

  const penultimate = await adapter.evidence({}, {}, { offset: 4_800, limit: 200 });
  assert.equal(penultimate.value.length, 200);
  assert.equal(penultimate.value[0].evidenceId, 'e4800');
  assert.equal(penultimate.value.at(-1).evidenceId, 'e4999');
  assert.equal(penultimate.status.completeness, 'partial');
  assert.equal(penultimate.page.next, 5_000);

  const final = await adapter.evidence({}, {}, { offset: penultimate.page.next, limit: 200 });
  assert.deepEqual(final.value.map((row) => row.evidenceId), ['e5000']);
  assert.equal(final.status.completeness, 'complete');
  assert.equal(final.page.next, null);
  assert.equal(final.page.total, 5_001);
});

test('10000+ upstream rows traverse without duplicate or missing evidence', async () => {
  const rows = evidenceRows(10_037);
  const { adapter } = adapterFor(rows);
  const { seen, result, pages } = await collect(adapter, {}, 997);
  assert.ok(pages > 10);
  assert.equal(seen.length, rows.length);
  assert.deepEqual(seen, rows.map((row) => row.id));
  assert.equal(new Set(seen).size, rows.length);
  assert.equal(result.page.total, rows.length);
});

test('symbol/function supplements keep stable ordering around paged upstream evidence', async () => {
  const rows = evidenceRows(5_001);
  const address = 0x1000n;
  const app = {
    async getEvidence() { return rows; },
    async analyzeFunction() {
      return {
        evidence: [{ id: 'analysis-0', verdict: 'supported' }],
        rewriteProof: [{ id: 'rewrite-0', verdict: 'supported', rule: 'r0' }],
      };
    },
    symbols: {
      nameAt(value) { return value === address ? 'target' : null; },
      nameEvidence(value) { return value === address ? { id: 'name-0', verdict: 'confirmed' } : null; },
      functionEvidence(value) { return value === address ? { id: 'boundary-0', verdict: 'confirmed' } : null; },
    },
  };
  const adapter = createAppAnalysisQueryAdapter(app);
  const { seen } = await collect(adapter, { address }, 1_001);
  assert.deepEqual(seen.slice(0, 4), ['name-0', 'boundary-0', 'e0', 'e1']);
  assert.deepEqual(seen.slice(-4), ['e4999', 'e5000', 'analysis-0', 'rewrite-0']);
  assert.equal(seen.length, rows.length + 4);
  assert.equal(new Set(seen).size, seen.length);
});

test('query options including cancellation authority are forwarded unchanged to upstream evidence', async () => {
  const rows = evidenceRows(5_001);
  const { adapter, calls } = adapterFor(rows);
  const controller = new AbortController();
  const options = { signal: controller.signal, marker: Symbol('marker') };
  const result = await adapter.evidence({}, {}, { offset: 5_000, limit: 1 }, options);
  assert.equal(result.value[0].evidenceId, 'e5000');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options, options);
});
