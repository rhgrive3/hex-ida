import assert from 'node:assert/strict';
import { schemaRestPages } from '../js/ui/panels/schema-recovery.js';

for (const [total, sizes] of [[0, []], [60, [60]], [61, [60, 1]], [120, [60, 60]], [121, [60, 60, 1]]]) {
  const schemas = Array.from({ length: total }, (_, index) => ({
    id: index,
    best: { consistent:false },
  }));
  const pages = schemaRestPages(schemas);
  assert.deepEqual(pages.map((page) => page.length), sizes, `${total} schemas must be split into reachable pages`);
  assert.deepEqual(pages.flat().map((schema) => schema.id), schemas.map((schema) => schema.id));
}

{
  const schemas = [
    { id:'sure', best:{ consistent:true } },
    { id:'review', best:{ consistent:false } },
  ];
  assert.deepEqual(schemaRestPages(schemas).flat().map((schema) => schema.id), ['review']);
}

assert.throws(() => schemaRestPages([], 0), /schema-page-size-invalid/);
console.log('issue-5521-schema-recovery-pagination: PASS');
