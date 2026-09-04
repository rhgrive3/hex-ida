import assert from 'node:assert/strict';
import { compilePattern, evaluatePattern } from '../js/pattern/index.js';

// 1. Canonical numeric count works
{
  const compiled = compilePattern({
    kind: 'struct',
    name: 'NumericCount',
    fields: [{
      name: 'items',
      type: { kind: 'array', count: 2, element: { kind: 'primitive', name: 'u8' } },
    }],
  });
  const res = evaluatePattern(compiled, new Uint8Array([0x10, 0x20]));
  assert.equal(res.status, 'complete');
  assert.equal(res.value.fields.items.length, 2);
}

// 2. Canonical field-ref count works
{
  const compiled = compilePattern({
    kind: 'struct',
    name: 'RefDynamicCount',
    fields: [
      { name: 'len', type: { kind: 'primitive', name: 'u8' } },
      { name: 'items', type: { kind: 'array', count: 'len', element: { kind: 'primitive', name: 'u8' } } },
    ],
  });
  const res = evaluatePattern(compiled, new Uint8Array([2, 0xaa, 0xbb]));
  assert.equal(res.status, 'complete');
  assert.equal(res.value.fields.items.length, 2);
}

// 3. Unallowed types for count must fail at type-check / compile time
for (const invalidCount of [
  123n,               // bigint
  true,               // boolean
  false,              // boolean
  () => 1,            // function
  [1],                // array
  Symbol('count'),    // symbol
  -1,                 // negative integer
  1.5,                // non-integer
  null,               // null
  undefined,          // undefined
]) {
  assert.throws(
    () => {
      compilePattern({
        kind: 'struct',
        name: 'InvalidCount',
        fields: [{
          name: 'items',
          type: { kind: 'array', count: invalidCount, element: { kind: 'primitive', name: 'u8' } },
        }],
      });
    },
    /pattern-array-count-invalid/,
    `Count ${String(invalidCount)} must be rejected`,
  );
}

// 4. Invalid field ref string must be rejected with pattern-array-count-ref-invalid
assert.throws(
  () => {
    compilePattern({
      kind: 'struct',
      name: 'InvalidRef',
      fields: [{
        name: 'items',
        type: { kind: 'array', count: '123_invalid_start', element: { kind: 'primitive', name: 'u8' } },
      }],
    });
  },
  /pattern-array-count-ref-invalid/,
);

console.log('issue #6233 pattern array count validation regressions PASS');
