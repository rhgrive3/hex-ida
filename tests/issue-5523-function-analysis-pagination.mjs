import assert from 'node:assert/strict';
import { createFunctionPager } from '../js/ui/panels/function-analysis.js';

function fixture(total, completeness = 'complete') {
  const rows = Array.from({ length: total }, (_, index) => ({ address: BigInt(index), name: `f${index}` }));
  const calls = [];
  return {
    calls,
    pager: createFunctionPager(async (offset, options) => {
      const limit = 600;
      calls.push({ offset, limit, signal:options.signal });
      const value = rows.slice(offset, offset + limit);
      return {
        value,
        completeness,
        page: {
          offset,
          limit,
          returned:value.length,
          total:completeness === 'complete' ? rows.length : null,
          next:offset + value.length < rows.length ? offset + value.length : null,
        },
      };
    }),
  };
}

for (const [total, offsets] of [[599, [0]], [600, [0]], [601, [0, 600]], [1201, [0, 600, 1200]]]) {
  const sample = fixture(total);
  const controller = new AbortController();
  const first = await sample.pager.next({ signal:controller.signal });
  const rows = [...first.value];
  while (sample.pager.hasMore) rows.push(...(await sample.pager.next({ signal:controller.signal })).value);
  assert.equal(rows.length, total, `${total} functions must remain reachable`);
  assert.equal(new Set(rows.map((row) => row.address)).size, total, `${total} functions must not duplicate`);
  assert.deepEqual(sample.calls.map((call) => call.offset), offsets);
  assert.equal(sample.calls.every((call) => call.signal === controller.signal), true);
  assert.equal(sample.pager.completeness, 'complete');
}

{
  const sample = fixture(601, 'partial');
  while (sample.pager.hasMore) await sample.pager.next();
  assert.equal(sample.pager.completeness, 'partial', 'source incompleteness must remain visible after continuation');
}

for (const response of [
  { value:[{ address:0n }], completeness:'complete' },
  { value:[{ address:0n }], completeness:'complete', page:{} },
  { value:[{ address:0n }], completeness:'complete', page:{ next:7 } },
  { value:[{ address:0n }], completeness:'complete', page:{ next:0 } },
]) {
  let calls = 0;
  const pager = createFunctionPager(async () => { calls++; return response; });
  const page = await pager.next();
  assert.equal(calls, 1, 'malformed continuation must stop without retrying');
  assert.equal(page.value.length, 1);
  assert.equal(pager.hasMore, false);
  assert.equal(pager.completeness, 'partial');
}

console.log('issue-5523-function-analysis-pagination: PASS');
