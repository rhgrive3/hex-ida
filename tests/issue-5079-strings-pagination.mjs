import assert from 'node:assert/strict';
import { loadCanonicalStrings } from '../js/ui/product-hardened.js';

// Issue #5079: Strings Explorer must consume the canonical strings pagination
// contract. The query layer reports source completeness and page continuation
// separately, so `completeness === 'complete'` together with
// `page.next != null` means "more matches exist", not "everything is shown".
// A single fixed `{ offset: 0, limit: 200 }` query silently drops match 201+.

const makeQueries = (total, completeness = 'complete') => {
  const rows = Array.from({ length: total }, (_, index) => ({ addr: BigInt(index * 4), text: `foo-string-${index}` }));
  const calls = [];
  return {
    calls,
    queries: {
      async strings(_snapshot, query, page) {
        calls.push({ query: { ...query }, page: { ...page } });
        const needle = String(query.text || '');
        const filtered = needle ? rows.filter((row) => row.text.includes(needle)) : rows;
        const value = filtered.slice(page.offset, page.offset + page.limit);
        return {
          value,
          completeness,
          status: { producer: 'canonical-product-string-artifact/v1' },
          page: {
            offset: page.offset,
            limit: page.limit,
            returned: value.length,
            total: completeness === 'complete' ? filtered.length : null,
            next: page.offset + value.length < filtered.length ? page.offset + value.length : null,
          },
        };
      },
    },
  };
};

assert.equal(typeof loadCanonicalStrings, 'function', 'loadCanonicalStrings must be exported for the strings pagination contract');

// The exact counterexample from the issue: 201 complete matches.
for (const [total, offsets] of [[199, [0]], [200, [0]], [201, [0, 200]], [450, [0, 200, 400]]]) {
  const fixture = makeQueries(total);
  const result = await loadCanonicalStrings(fixture.queries, { snapshotId: 's' }, 'foo');
  assert.equal(result.value.length, total, `${total} complete matches must all remain reachable`);
  assert.equal(result.completeness, 'complete');
  assert.deepEqual(fixture.calls.map((call) => call.page.offset), offsets, `${total} matches must follow page.next without gaps`);
  assert.equal(new Set(result.value.map((row) => row.text)).size, total, `${total} matches must not duplicate across pages`);
}

// Producer incompleteness must survive paging instead of being upgraded.
{
  const partial = makeQueries(201, 'partial');
  const result = await loadCanonicalStrings(partial.queries, { snapshotId: 's' }, 'foo');
  assert.equal(result.value.length, 201, 'partial sources still expose every reachable page');
  assert.equal(result.completeness, 'partial', 'source incompleteness must remain fail-closed after paging');
}

// A non-contiguous continuation must stop, not loop forever.
{
  let calls = 0;
  const malformed = await loadCanonicalStrings({
    async strings() {
      calls++;
      return { value: [{ text: 'a' }, { text: 'b' }], completeness: 'complete', page: { next: 7 } };
    },
  }, { snapshotId: 's' }, 'a');
  assert.equal(calls, 1, 'malformed continuation must not create an unbounded query loop');
  assert.equal(malformed.value.length, 2);
  assert.equal(malformed.completeness, 'partial', 'non-contiguous continuation must fail closed');
}

// A missing page envelope must fail closed instead of claiming completeness.
for (const [label, response] of [
  ['missing page', { value: [{ text: 'a' }], completeness: 'complete' }],
  ['missing next', { value: [{ text: 'a' }], completeness: 'complete', page: {} }],
]) {
  let calls = 0;
  const result = await loadCanonicalStrings({
    async strings() {
      calls++;
      return response;
    },
  }, { snapshotId: 's' }, 'a');
  assert.equal(calls, 1, `${label} must stop without retrying`);
  assert.equal(result.value.length, 1);
  assert.equal(result.completeness, 'partial', `${label} must fail closed`);
}

console.log('issue #5079 strings pagination: PASS');
