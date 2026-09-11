import assert from 'node:assert/strict';
import test from 'node:test';
import { createAppAnalysisQueryAdapter } from '../../js/analysis/query/app-adapter.js';

function bounded(values, { complete = false, queryLimited = false, reason = null } = {}) {
  const result = [...values];
  Object.defineProperties(result, {
    complete: { value: complete, enumerable: false },
    queryLimited: { value: queryLimited, enumerable: false },
    incompleteReason: { value: reason, enumerable: false },
  });
  return result;
}

function baseApp({ autoReport = null, searchResult = null } = {}) {
  const callers = bounded([0x2000n, 0x3000n], { queryLimited: true, reason: 'query-limit' });
  const callees = bounded([0x4000n, 0x5000n], { queryLimited: true, reason: 'query-limit' });
  const refs = bounded([
    { site: 0x1010n, target: 0x1000n, kind: 'data' },
    { site: 0x1020n, target: 0x1000n, kind: 'data' },
  ], { reason: 'xref-budget' });
  const calls = bounded([
    { site: 0x1030n, target: 0x1000n, caller: 0x2000n },
  ], { complete: true });

  return {
    autoReport,
    validatedFunctionRange() {
      return { ok: true, start: 0x1000n, end: 0x1100n, complete: true };
    },
    async ensureProgram() {
      return {
        callersOf() { return callers; },
        calleesOf() { return callees; },
        refSitesTo() { return refs; },
        callSitesTo() { return calls; },
      };
    },
    backend: searchResult == null ? {} : {
      search() { return Promise.resolve(searchResult); },
    },
  };
}

test('complete materialized pages keep exact total, including offset > 0', async () => {
  const app = baseApp({ autoReport: { report: { deep: [{ id: 1 }, { id: 2 }, { id: 3 }] } } });
  const adapter = createAppAnalysisQueryAdapter(app);
  const first = await adapter.evidence({}, {}, { offset: 0, limit: 2 });
  assert.equal(first.status.completeness, 'complete');
  assert.equal(first.page.total, 3);
  assert.equal(first.page.next, 2);

  const second = await adapter.evidence({}, {}, { offset: 2, limit: 2 });
  assert.equal(second.status.completeness, 'complete');
  assert.equal(second.page.total, 3);
  assert.equal(second.page.returned, 1);
  assert.equal(second.page.next, null);
});

test('query-limited callers and callees publish unknown total without losing continuation', async () => {
  const adapter = createAppAnalysisQueryAdapter(baseApp());
  for (const method of ['callers', 'callees']) {
    const first = await adapter[method]({}, 0x1000n, { offset: 0, limit: 2 });
    assert.equal(first.status.completeness, 'partial', `${method}: source remains partial`);
    assert.equal(first.page.total, null, `${method}: bounded prefix is not an exact universe total`);
    assert.equal(first.page.next, 2, `${method}: producer cap still exposes continuation`);

    const boundary = await adapter[method]({}, 0x1000n, { offset: 2, limit: 2 });
    assert.equal(boundary.page.returned, 0, `${method}: prefix boundary is empty`);
    assert.equal(boundary.page.total, null, `${method}: boundary does not invent total`);
    assert.equal(boundary.page.next, 4, `${method}: one empty boundary probe still advances`);
  }
});

test('partial xrefs do not publish the materialized subset length as exact total', async () => {
  const adapter = createAppAnalysisQueryAdapter(baseApp());
  const result = await adapter.xrefs({}, 0x1000n, { offset: 0, limit: 2 });
  assert.equal(result.status.completeness, 'partial');
  assert.equal(result.page.total, null);
  assert.equal(result.page.next, 2);
});

function queryLimitedXrefsApp(limitedSource) {
  const refs = [
    { site: 0x1010n, target: 0x1000n, kind: 'data' },
  ];
  const calls = [
    { site: 0x1030n, target: 0x1000n, caller: 0x2000n },
  ];
  Object.defineProperty(refs, 'complete', { value: true, enumerable: false });
  Object.defineProperty(calls, 'complete', { value: true, enumerable: false });
  Object.defineProperty(limitedSource === 'refs' ? refs : calls, 'queryLimited', { value: true, enumerable: false });

  const app = baseApp();
  app.ensureProgram = async () => ({
    refSitesTo() { return refs; },
    callSitesTo() { return calls; },
  });
  return app;
}

test('query-limited refSitesTo keeps xrefs partial even without complete:false', async () => {
  const result = await createAppAnalysisQueryAdapter(queryLimitedXrefsApp('refs')).xrefs({}, 0x1000n, { offset: 0, limit: 2 });
  assert.equal(result.status.completeness, 'partial');
  assert.equal(result.status.reason, 'query-limit');
  assert.equal(result.status.truncationReason, 'query-limit');
  assert.equal(result.page.total, null);
});

test('query-limited callSitesTo keeps xrefs partial even without complete:false', async () => {
  const result = await createAppAnalysisQueryAdapter(queryLimitedXrefsApp('calls')).xrefs({}, 0x1000n, { offset: 0, limit: 2 });
  assert.equal(result.status.completeness, 'partial');
  assert.equal(result.status.reason, 'query-limit');
  assert.equal(result.status.truncationReason, 'query-limit');
  assert.equal(result.page.total, null);
});

test('truncated auto-report evidence keeps total unknown', async () => {
  const app = baseApp({
    autoReport: { report: { deep: [{ id: 1 }, { id: 2 }, { id: 3 }], truncated: true } },
  });
  const result = await createAppAnalysisQueryAdapter(app).evidence({}, {}, { offset: 0, limit: 2 });
  assert.equal(result.status.completeness, 'partial');
  assert.equal(result.page.total, null);
  assert.equal(result.page.next, 2);
});

test('capped and cancelled backend searches keep total unknown', async () => {
  for (const searchResult of [
    { results: [{ id: 1 }, { id: 2 }], capped: true, cancelled: false },
    { results: [{ id: 1 }, { id: 2 }], capped: false, cancelled: true },
  ]) {
    const adapter = createAppAnalysisQueryAdapter(baseApp({ searchResult }));
    const result = await adapter.search({}, { kind: 'text', query: 'needle' }, { offset: 0, limit: 1 });
    assert.equal(result.status.completeness, 'partial');
    assert.equal(result.page.total, null);
    assert.equal(result.page.next, 1);
  }
});
