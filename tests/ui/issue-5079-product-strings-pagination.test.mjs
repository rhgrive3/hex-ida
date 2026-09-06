import assert from 'node:assert/strict';
import { loadCanonicalStrings } from '../../js/ui/product-hardened.js';

function rows(count) {
  return Array.from({ length:count }, (_, index) => ({
    text:`string-${index}`,
    addr:BigInt(index),
  }));
}

function pagedQueries(allRows, { completeness = 'complete', malformedPage = null, abortAfterFirst = null } = {}) {
  const calls = [];
  return {
    calls,
    async strings(snapshot, filter, page, options) {
      calls.push({ snapshot, filter, page:{ ...page }, signal:options?.signal });
      const slice = allRows.slice(page.offset, page.offset + page.limit);
      if (abortAfterFirst && calls.length === 1) abortAfterFirst.abort('test-abort');
      const naturalNext = page.offset + slice.length < allRows.length ? page.offset + slice.length : null;
      const next = malformedPage == null ? naturalNext : malformedPage({ page, slice, naturalNext });
      return {
        value:slice,
        completeness,
        status:{ scannedRegions:3, totalRegions:completeness === 'complete' ? 3 : 4 },
        page:{ offset:page.offset, limit:page.limit, returned:slice.length, total:completeness === 'complete' ? allRows.length : null, next },
      };
    },
  };
}

for (const count of [199, 200, 201, 401]) {
  const queries = pagedQueries(rows(count));
  const snapshot = { id:`snapshot-${count}` };
  const filter = { text:'needle' };
  const result = await loadCanonicalStrings(queries, snapshot, filter);
  assert.equal(result.completeness, 'complete', `${count} complete matches must stay complete`);
  assert.equal(result.value.length, count, `${count} matches must all be reachable`);
  assert.deepEqual(result.value.map((row) => row.text), rows(count).map((row) => row.text), `${count} matches must preserve ordering without gaps/duplicates`);
  assert.deepEqual(queries.calls.map((call) => call.page.offset), count <= 200 ? [0] : count <= 400 ? [0, 200] : [0, 200, 400]);
  assert.ok(queries.calls.every((call) => call.page.limit === 200), 'canonical string page size must remain bounded at 200');
  assert.ok(queries.calls.every((call) => call.snapshot === snapshot && call.filter === filter), 'continuation pages must keep one snapshot/filter identity');
}

{
  const queries = pagedQueries(rows(201), { completeness:'partial' });
  const result = await loadCanonicalStrings(queries, { id:'partial' }, { text:'' });
  assert.equal(result.value.length, 201, 'partial artifacts must still expose every currently reachable match');
  assert.equal(result.completeness, 'partial', 'source partialness must remain sticky across pages');
  assert.deepEqual(result.status, { scannedRegions:3, totalRegions:4 });
}

for (const malformedPage of [
  () => 201,
  () => 0,
  () => '200',
  () => 200.5,
]) {
  const queries = pagedQueries(rows(201), { malformedPage });
  const result = await loadCanonicalStrings(queries, { id:'malformed' }, { text:'x' });
  assert.equal(queries.calls.length, 1, 'malformed continuation must stop before another query');
  assert.equal(result.value.length, 200, 'already returned rows remain usable when continuation fails closed');
  assert.equal(result.completeness, 'partial', 'malformed continuation must never claim a complete result set');
}

for (const pageOverride of [
  { offset:1 },
  { limit:199 },
  { returned:199 },
  { total:199 },
  { total:401, next:null },
]) {
  const calls = [];
  const queries = {
    async strings(_snapshot, _filter, page) {
      calls.push(page.offset);
      return {
        value:rows(200),
        completeness:'complete',
        page:{ offset:page.offset, limit:page.limit, returned:200, total:200, next:null, ...pageOverride },
      };
    },
  };
  const result = await loadCanonicalStrings(queries, { id:'contradictory-page' }, {});
  assert.deepEqual(calls, [0], 'contradictory page envelope must stop before another query');
  assert.equal(result.value.length, 200, 'already returned rows remain usable when page metadata contradicts the response');
  assert.equal(result.completeness, 'partial', 'contradictory offset/limit/returned/total/next metadata must fail closed');
}

{
  const calls = [];
  const queries = {
    async strings(_snapshot, _filter, page) {
      calls.push(page.offset);
      return { value:rows(200), completeness:'complete' };
    },
  };
  const result = await loadCanonicalStrings(queries, { id:'missing-page' }, {});
  assert.deepEqual(calls, [0]);
  assert.equal(result.completeness, 'partial', 'missing pagination metadata must fail closed');
}

{
  const queries = { async strings() { return { value:{ 0:'not-an-array' }, completeness:'complete', page:{ next:null } }; } };
  const result = await loadCanonicalStrings(queries, { id:'bad-value' }, {});
  assert.deepEqual(result.value, []);
  assert.equal(result.completeness, 'partial', 'non-array page values must fail closed');
}

{
  const controller = new AbortController();
  const queries = pagedQueries(rows(401), { abortAfterFirst:controller });
  const result = await loadCanonicalStrings(queries, { id:'aborted' }, { text:'x' }, { signal:controller.signal });
  assert.equal(queries.calls.length, 1, 'abort after a page must prevent continuation fetches');
  assert.equal(result.value.length, 200);
  assert.equal(result.completeness, 'partial', 'aborted pagination must never claim completeness');
  assert.equal(queries.calls[0].signal, controller.signal, 'AbortSignal must propagate to the canonical query');
}

console.log('issue #5079 product hardened string pagination regression PASS');
