import assert from 'node:assert/strict';
import { evaluatePattern } from '../../../js/pattern/index.js';

// Issue #5913: a fixed-alternative union occupies at least its largest
// alternative's span. staticSize(union) previously returned null, struct
// cursor updates were skipped, and every following sequential field re-read
// the union's own storage at the union's offset. Union provenance also
// claimed only the first alternative's length.

const bytes = new Uint8Array([
  0x11, 0x22, 0x33, 0x44, // union storage
  0xaa,                   // next field
]);

const root = {
  kind: 'struct',
  name: 'Root',
  fields: [
    { name: 'u', type: { kind: 'union', options: [
      { kind: 'primitive', name: 'u8' },
      { kind: 'primitive', name: 'u32le' },
    ] } },
    { name: 'next', type: { kind: 'primitive', name: 'u8' } },
  ],
};

const result = evaluatePattern(root, bytes);
assert.equal(result.status, 'complete', 'fixed-size union layout must evaluate completely');
assert.equal(result.value.fields.u.provenance.offset, '0');
assert.equal(result.value.fields.u.provenance.length, '4', 'union provenance must cover the largest alternative');
assert.equal(result.value.fields.next.value, 0xaa, 'next field must read past the union storage');
assert.equal(result.value.fields.next.provenance.offset, '4');

// All-static nested alternatives: struct-in-union and enum/pointer members.
const nested = evaluatePattern({
  kind: 'struct',
  fields: [
    { name: 'u', type: { kind: 'union', options: [
      { kind: 'struct', fields: [{ name: 'a', type: { kind: 'primitive', name: 'u8' } }, { name: 'b', type: { kind: 'primitive', name: 'u8' } }] },
      { kind: 'primitive', name: 'u32le' },
    ] } },
    { name: 'tail', type: { kind: 'primitive', name: 'u8' } },
  ],
}, bytes);
assert.equal(nested.value.fields.tail.provenance.offset, '4');
assert.equal(nested.value.fields.u.provenance.length, '4');

// A dynamically sized alternative keeps the union unsizeable: the evaluator
// must fail closed (partial) instead of returning a complete result that
// consumes 0 bytes. An expression-form count is readable at runtime but has
// no provable static size.
const dynamic = evaluatePattern({
  kind: 'struct',
  fields: [
    { name: 'u', type: { kind: 'union', options: [
      { kind: 'primitive', name: 'u8' },
      { kind: 'array', element: { kind: 'primitive', name: 'u8' }, count: { op: 'const', value: 2 } },
    ] } },
    { name: 'next', type: { kind: 'primitive', name: 'u8' } },
  ],
}, bytes);
assert.equal(dynamic.status, 'partial', 'union with a dynamic alternative must not claim a complete layout');
assert.equal(dynamic.reason, 'pattern-union-size-unproven');

console.log('issue-5913 pattern union layout span and cursor advance: ok');
