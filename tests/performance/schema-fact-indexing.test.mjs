import assert from 'node:assert/strict';
import test from 'node:test';

import { decodeSchema } from '../../js/schema.js';

function cmpImmediate(register, immediate) {
  return (0xf100001f | ((immediate & 0xfff) << 10) | (register << 5)) >>> 0;
}
function addImmediate(register, immediate) {
  return (0x91000000 | ((immediate & 0xfff) << 10) | (register << 5) | register) >>> 0;
}
function storeIndexed(base, index) {
  return (0xb8207800 | (index << 16) | (base << 5)) >>> 0;
}

function wideIndexedSchemaFixture() {
  const words = [];
  for (let base = 1; base <= 30; base += 1) {
    for (let index = 1; index <= 30; index += 1) {
      if (base === index) continue;
      words.push(cmpImmediate(index, 8 + (index % 17)));
      words.push(addImmediate(index, 1));
      words.push(storeIndexed(base, index));
    }
  }
  return new Uint32Array(words);
}

test('schema recovery indexes loop facts instead of filter-sorting the full fact arrays per table', () => {
  const words = wideIndexedSchemaFixture();
  const originalFilter = Array.prototype.filter;
  const originalSort = Array.prototype.sort;
  let largeFilters = 0;
  let largeSorts = 0;
  Array.prototype.filter = function (...args) {
    if (this.length >= 100) largeFilters += 1;
    return Reflect.apply(originalFilter, this, args);
  };
  Array.prototype.sort = function (...args) {
    if (this.length >= 20) largeSorts += 1;
    return Reflect.apply(originalSort, this, args);
  };
  let schema;
  try {
    schema = decodeSchema(words, 0n);
  } finally {
    Array.prototype.filter = originalFilter;
    Array.prototype.sort = originalSort;
  }
  assert.equal(schema?.tables?.length, 870);
  // Legacy nearestFact/recordCountOf perform thousands of full fact-array
  // filters and hundreds of stable sorts for this fixture. The indexed path
  // keeps those operations constant while preserving the public table order.
  assert.ok(largeFilters <= 2, `schema recovery performed ${largeFilters} large-array filters`);
  assert.ok(largeSorts <= 2, `schema recovery performed ${largeSorts} large-array sorts`);
});
