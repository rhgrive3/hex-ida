import assert from 'node:assert/strict';
import { createHexAIContext } from '../../../js/ai/ui/hex-context.js';

function makeApp(specs) {
  const calls = [];
  const app = {
    store: { get() { return null; } },
    recognition: { records: [] },
    analysisQueries: {
      async snapshot() { return { id:'snapshot' }; },
      async binaryInfo() {
        return {
          completeness:'complete',
          value:{ regions:specs.map((_, index) => ({ id:`r${index}` })) },
          status:{ completeness:'complete' },
        };
      },
      async search(_snapshot, query, page) {
        const index = Number(query.regionId.slice(1));
        const spec = specs[index];
        calls.push({ regionId:query.regionId, offset:page.offset, limit:page.limit });
        if (spec.completeness === 'unsupported') {
          return {
            completeness:'unsupported',
            value:null,
            page:{ offset:page.offset, returned:0, total:null, next:null },
            status:{ completeness:'unsupported', reason:'unsupported-region' },
          };
        }
        const total = spec.total;
        const numericTotal = typeof total === 'number' ? total : 0;
        const start = Math.min(page.offset, numericTotal);
        const end = Math.min(numericTotal, start + page.limit);
        const value = Array.from({ length:end - start }, (_, row) => ({
          address:BigInt(0x1000 + index * 0x100 + start + row),
          text:'x',
        }));
        return {
          completeness:spec.completeness || 'complete',
          value,
          page:{
            offset:page.offset,
            returned:value.length,
            total,
            next:end < numericTotal ? end : null,
          },
          status:{
            completeness:spec.completeness || 'complete',
            reason:spec.completeness === 'partial' ? 'search-incomplete' : null,
          },
        };
      },
    },
  };
  return { app, calls };
}

async function exactPage(offset) {
  const { app } = makeApp([{ total:2 }, { total:1 }]);
  return createHexAIContext(app).searchStrings('x', { offset, limit:50 });
}

for (const [offset, returned] of [[0, 3], [2, 1], [3, 0], [10, 0]]) {
  const page = await exactPage(offset);
  assert.equal(page.total, 3, `offset ${offset} must preserve the exact global denominator`);
  assert.equal(page.returned, returned, `offset ${offset} returned-row count`);
  assert.equal(page.complete, true, `offset ${offset} should remain complete when all regions are exact`);
  assert.equal(page.truncated, false, `offset ${offset} should not become truncated`);
}

{
  const { app } = makeApp([{ total:2 }, { total:1, completeness:'partial' }]);
  const page = await createHexAIContext(app).searchStrings('x', { offset:0, limit:50 });
  assert.equal(page.total, null, 'partial regional cardinality must not become an exact global total');
  assert.equal(page.complete, false);
}

{
  const { app } = makeApp([{ total:null }, { total:1 }]);
  const page = await createHexAIContext(app).searchStrings('x', { offset:0, limit:50 });
  assert.equal(page.total, null, 'unknown regional cardinality must keep the global denominator unknown');
}

{
  const { app } = makeApp([{ completeness:'unsupported' }, { total:1 }]);
  const page = await createHexAIContext(app).searchStrings('x', { offset:0, limit:50 });
  assert.equal(page.total, null, 'unsupported regions must never contribute to an exact global total');
  assert.equal(page.complete, false, 'skipping an unsupported region must make the global search incomplete');
  assert.equal(page.truncated, true);
  assert.equal(page.reason, 'unsupported-region');
}

console.log('issue-3687-ai-searchstrings-total: ok');
