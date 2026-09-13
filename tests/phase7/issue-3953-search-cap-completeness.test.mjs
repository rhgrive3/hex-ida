import assert from 'node:assert/strict';
import test from 'node:test';

import { installDemandDrivenAnalysis } from '../../js/analysis/demand-driven-runtime.js';
import { createAppAnalysisQueryAdapter } from '../../js/analysis/query/app-adapter.js';

const finalPage = Object.freeze({ offset: 2, limit: 1 });
const rows = Object.freeze([{ addr: 1n }, { addr: 2n }, { addr: 3n }]);

function backendResult(overrides = {}) {
  return Promise.resolve({
    results: rows,
    capped: false,
    cancelled: false,
    ...overrides,
  });
}

function demandApp(search) {
  return {
    backend: {
      gen: 1,
      binaryId: 'binary-issue-3953',
      search,
    },
  };
}

test('#3953 base adapter marks an exhausted capped materialization truncated', async () => {
  const adapter = createAppAnalysisQueryAdapter(demandApp(() => backendResult({ capped: true })));
  const result = await adapter.search(null, { kind: 'text', query: 'needle' }, finalPage);

  assert.equal(result.status.completeness, 'truncated');
  assert.equal(result.status.reason, 'search-result-cap');
  assert.equal(result.page.returned, 1);
  assert.equal(result.page.next, null);
  assert.deepEqual(result.value, [{ addr: 3n }]);
});

test('#3953 demand adapter preserves the same unrecoverable cap semantics', async () => {
  const app = demandApp(() => backendResult({ capped: true }));
  installDemandDrivenAnalysis(app);
  const snapshot = await app.analysisQueries.snapshot();
  const result = await app.analysisQueries.search(
    snapshot,
    { kind: 'text', query: 'needle' },
    finalPage,
  );

  assert.equal(result.status.completeness, 'truncated');
  assert.equal(result.status.reason, 'search-result-cap');
  assert.equal(result.page.returned, 1);
  assert.equal(result.page.next, null);
  assert.deepEqual(result.value, [{ addr: 3n }]);
});

test('#3953 cancellation remains partial and takes precedence over a cap', async () => {
  const base = createAppAnalysisQueryAdapter(demandApp(() => backendResult({ capped: true, cancelled: true })));
  const baseResult = await base.search(null, { kind: 'text', query: 'needle' }, {});
  assert.equal(baseResult.status.completeness, 'partial');
  assert.equal(baseResult.status.reason, 'cancelled');

  const app = demandApp(() => backendResult({ capped: true, cancelled: true }));
  installDemandDrivenAnalysis(app);
  const snapshot = await app.analysisQueries.snapshot();
  const demandResult = await app.analysisQueries.search(snapshot, { kind: 'text', query: 'needle' }, {});
  assert.equal(demandResult.status.completeness, 'partial');
  assert.equal(demandResult.status.reason, 'cancelled');
});

test('#3953 uncapped finite searches remain complete', async () => {
  const base = createAppAnalysisQueryAdapter(demandApp(() => backendResult()));
  const baseResult = await base.search(null, { kind: 'text', query: 'needle' }, {});
  assert.equal(baseResult.status.completeness, 'complete');

  const app = demandApp(() => backendResult());
  installDemandDrivenAnalysis(app);
  const snapshot = await app.analysisQueries.snapshot();
  const demandResult = await app.analysisQueries.search(snapshot, { kind: 'text', query: 'needle' }, {});
  assert.equal(demandResult.status.completeness, 'complete');
});
