import assert from 'node:assert/strict';
import { renderIndexedMemory } from '../../js/decompiler/address-semantics.js';

// Issue #5561: renderIndexedMemory() embedded the base expression without
// parentheses. renderValue() can return bitwise forms whose precedence is
// below '+', so memory[a & b + i] reassociated the effective address in the
// emitted C (C parses + tighter than &): memory[a & (b + i)].

// The minimal repro from the issue.
assert.equal(
  renderIndexedMemory('a & b', 'i', { extend: null, scale: 0, size: 0 }),
  'memory[(a & b) + i]',
  'bitwise-AND base must be parenthesized',
);

// Every bitwise form that binds looser than or equal to '+' is parenthesized.
for (const [base, expected] of [
  ['a | b', 'memory[(a | b) + i]'],
  ['a ^ b', 'memory[(a ^ b) + i]'],
  ['a << 3', 'memory[(a << 3) + i]'],
  ['a >> 3', 'memory[(a >> 3) + i]'],
  ['a & 0xff', 'memory[(a & 0xff) + i]'],
]) {
  assert.equal(renderIndexedMemory(base, 'i', { extend: null, scale: 0, size: 0 }), expected, `base '${base}' keeps its precedence`);
}

// Arithmetic forms are parenthesized uniformly (correct, merely redundant for
// '*' — the wrapped() helper is a structural gate, not a precedence table).
assert.equal(
  renderIndexedMemory('a * 4', 'i', { extend: null, scale: 0, size: 0 }),
  'memory[(a * 4) + i]',
);

// Simple identifiers keep the exact legacy shape.
assert.equal(
  renderIndexedMemory('buf', 'i', { extend: null, scale: 0, size: 0 }),
  'memory[buf + i]',
);

// The byte-scale path already wrapped the base; unchanged.
assert.equal(
  renderIndexedMemory('a & b', 'i', { extend: null, scale: 2, size: 4 }),
  '(a & b)[i]',
);
assert.equal(
  renderIndexedMemory('p->f', 'i', { extend: null, scale: 2, size: 4 }),
  'p->f[i]',
);

// Shifted-index path parenthesizes the base too.
assert.equal(
  renderIndexedMemory('a & b', 'i', { extend: null, scale: 2, size: 0 }),
  'memory[(a & b) + (i << 2)]',
);

console.log('issue #5561 indexed-memory base parentheses regression: PASS');
