import assert from 'node:assert/strict';
import { compilePattern, evaluatePattern } from '../../../js/pattern/index.js';

// Issue #5010: static layout sizes are binary coordinates. Number arithmetic
// must not round a valid fixed layout before it is attached to provenance or
// reused as a cursor/array stride.
const max = Number.MAX_SAFE_INTEGER;
const triple = {
  kind: 'struct',
  fields: [
    { name: 'a', type: { kind: 'primitive', name: 'u8' } },
    { name: 'b', type: { kind: 'primitive', name: 'u8' } },
    { name: 'c', type: { kind: 'primitive', name: 'u8' } },
  ],
};
const huge = { kind: 'array', count: max, element: triple };
const exact = 3n * BigInt(max);
const rounded = BigInt(3 * max);
assert.notEqual(exact, rounded, 'fixture must cross the safe-integer precision boundary');

// A fixed-size union publishes staticSize() directly as provenance and the
// enclosing struct then uses that span as its sequential cursor. This is an
// observable current-main path for rounded staticSize() values.
const compiled = compilePattern({
  kind: 'struct',
  name: 'Root',
  fields: [
    { name: 'u', type: { kind: 'union', options: [
      { kind: 'primitive', name: 'u8' },
      huge,
    ] } },
    { name: 'marker', type: { kind: 'primitive', name: 'u8' } },
  ],
}, { snapshotId: 'issue-5010' });

const reads = [];
const source = {
  snapshotId: 'issue-5010',
  size: null,
  read(offset, length) {
    const at = BigInt(offset);
    reads.push([at, length]);
    if (at === 0n && length === 1) return Uint8Array.of(0x11);
    if (at === exact && length === 1) return Uint8Array.of(0x42);
    if (at === rounded && length === 1) return Uint8Array.of(0x99);
    throw new RangeError(`unexpected read ${at} length=${length}`);
  },
};

const result = evaluatePattern(compiled, source);
assert.equal(result.status, 'complete');
assert.equal(result.value.fields.u.provenance.length, exact.toString(),
  'union provenance must preserve the exact fixed layout span');
assert.equal(result.value.fields.marker.provenance.offset, exact.toString(),
  'following field must start after the exact fixed layout span');
assert.equal(result.value.fields.marker.value, 0x42,
  'following field must not read the Number-rounded predecessor byte');
assert.ok(!reads.some(([at]) => at === rounded), 'rounded coordinate must never be read');

// The sibling random-access path must also multiply an exact static element
// size without first returning to Number arithmetic. The outer element is a
// huge lazy array, so this checks coordinates without allocating its payload.
const outer = evaluatePattern({
  kind: 'struct',
  name: 'Outer',
  fields: [{ name: 'items', type: { kind: 'array', count: 4, element: huge } }],
}, {
  snapshotId: '',
  size: null,
  read() { throw new Error('lazy huge array expansion must not read payload bytes'); },
});
const third = outer.value.fields.items.expand(3);
assert.equal(third.provenance.offset, (3n * exact).toString(),
  'nested lazy array stride must stay exact beyond Number.MAX_SAFE_INTEGER');
assert.equal(third.provenance.length, '0', 'lazy array construction must remain lazy');

// Ordinary fixed-size layouts keep their existing offsets and values.
const small = evaluatePattern({
  kind: 'struct',
  name: 'Small',
  fields: [
    { name: 'items', type: { kind: 'array', count: 2, element: triple } },
    { name: 'tail', type: { kind: 'primitive', name: 'u8' } },
  ],
}, new Uint8Array([1, 2, 3, 4, 5, 6, 0xaa]));
assert.equal(small.status, 'complete');
assert.equal(small.value.fields.tail.provenance.offset, '6');
assert.equal(small.value.fields.tail.value, 0xaa);
assert.equal(small.value.fields.items.expand(1).provenance.offset, '3');

console.log('issue-5010 exact static pattern layout arithmetic: ok');
