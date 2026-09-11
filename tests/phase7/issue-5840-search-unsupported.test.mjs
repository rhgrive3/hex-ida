import assert from 'node:assert/strict';
import test from 'node:test';

import { installDemandDrivenAnalysis } from '../../js/analysis/demand-driven-runtime.js';
import { createAppAnalysisQueryAdapter as createBaseAppAnalysisQueryAdapter } from '../../js/analysis/query/app-adapter.js';
import { createAppAnalysisQueryAdapter as createProductAnalysisQueryAdapter } from '../../js/analysis/query/product-adapter.js';

function demandApp(search) {
  return { backend: { gen: 1, binaryId: 'binary-test-5840', search } };
}

function workerUnsupportedShape(overrides = {}) {
  // Exact production shape of js/platform/worker.js::runSearch() for a search
  // kind it does not implement.
  return Promise.resolve({ cancelled: false, results: [], scanned: 0, capped: false, unsupported: true, ...overrides });
}

test('demand-driven search publishes backend unsupported as unsupported, not complete (#5840, #5833)', async () => {
  const app = demandApp(() => workerUnsupportedShape());
  installDemandDrivenAnalysis(app);
  const snapshot = await app.analysisQueries.snapshot();
  const result = await app.analysisQueries.search(snapshot, { regionId: 'p0_s0', kind: 'regex', query: 'foo' }, { offset: 0, limit: 10 });
  assert.equal(result.status.completeness, 'unsupported', 'an unimplemented search kind is not a complete empty result');
  assert.equal(result.status.reason, 'search-kind-unsupported');
  assert.equal(result.value, null);
  assert.equal(result.completeness, 'unsupported');
});

test('demand-driven search carries the backend unsupportedReason when provided (#5840, #5833)', async () => {
  const app = demandApp(() => workerUnsupportedShape({ unsupportedReason: 'search-kind-unimplemented:regex' }));
  installDemandDrivenAnalysis(app);
  const snapshot = await app.analysisQueries.snapshot();
  const result = await app.analysisQueries.search(snapshot, { regionId: 'p0_s0', kind: 'regex', query: 'foo' }, {});
  assert.equal(result.status.completeness, 'unsupported');
  assert.equal(result.status.reason, 'search-kind-unimplemented:regex');
});

test('base query adapter search publishes backend unsupported as unsupported (#5840, #5833)', async () => {
  const reason = 'search-kind-unimplemented:regex';
  const app = demandApp(() => workerUnsupportedShape({ unsupportedReason: reason }));
  const adapter = createBaseAppAnalysisQueryAdapter(app);
  const result = await adapter.search(null, { regionId: 'p0_s0', kind: 'regex', query: 'foo' }, { offset: 0, limit: 10 });
  assert.equal(result.status.completeness, 'unsupported');
  assert.equal(result.status.reason, reason);
  assert.equal(result.page.returned, 0);
});

test('a supported search is unchanged: rows are complete, caps stay partial (#5840, #5833)', async () => {
  const app = demandApp((query) => {
    if (query.kind !== 'hex' && query.kind !== 'text') return workerUnsupportedShape();
    return Promise.resolve({ cancelled: false, results: [{ addr: 1n }], scanned: 1, capped: false });
  });
  installDemandDrivenAnalysis(app);
  const snapshot = await app.analysisQueries.snapshot();
  const hit = await app.analysisQueries.search(snapshot, { regionId: 'p0_s0', kind: 'hex', bytes: [0] }, {});
  assert.equal(hit.status.completeness, 'complete');
  assert.deepEqual(hit.value, [{ addr: 1n }]);

  const capped = demandApp(() => Promise.resolve({ cancelled: false, results: [], scanned: 1, capped: true }));
  installDemandDrivenAnalysis(capped);
  const cappedSnapshot = await capped.analysisQueries.snapshot();
  const partial = await capped.analysisQueries.search(cappedSnapshot, { regionId: 'p0_s0', kind: 'hex', bytes: [0] }, {});
  assert.equal(partial.status.completeness, 'partial');
  assert.equal(partial.status.reason, 'search-result-cap');
});

  
test('app.querySearch preserves unsupported completeness and reason (#5840, #5833)', async () => {
  const app = {
    querySearch: async () => ({
      unsupported: true,
      unsupportedReason: 'search-kind-unimplemented:regex',
      results: [],
    }),
  };
  const adapter = createProductAnalysisQueryAdapter(app);
  const result = await adapter.search(null, { kind: 'regex', query: 'foo' }, { offset: 0, limit: 10 });
  assert.equal(result.status.completeness, 'unsupported');
  assert.equal(result.status.reason, 'search-kind-unimplemented:regex');
  assert.deepEqual(result.value, []);
});

test('app.querySearch preserves a top-level unsupported reason (#5840, #5833)', async () => {
  const app = {
    querySearch: async () => ({
      completeness: 'unsupported',
      reason: 'search-kind-not-enabled',
      results: [],
    }),
  };
  const adapter = createProductAnalysisQueryAdapter(app);
  const result = await adapter.search(null, { kind: 'regex', query: 'foo' }, { offset: 0, limit: 10 });
  assert.equal(result.status.completeness, 'unsupported');
  assert.equal(result.status.reason, 'search-kind-not-enabled');
  assert.deepEqual(result.value, []);
});
