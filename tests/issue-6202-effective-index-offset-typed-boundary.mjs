import assert from 'node:assert/strict';
import {
  effectiveIndexOffset,
  renderExtendedIndex,
  renderIndexedMemory,
} from '../js/decompiler/address-semantics.js';

console.log('Testing #6202: effectiveIndexOffset rejects structured coercion.');

// 1. Structured value / extend / scale no longer promote to canonical offsets.
assert.equal(effectiveIndexOffset(['1'], ['uxtw'], ['2']), null);
assert.equal(effectiveIndexOffset(true, 'uxtw', 2), null);
assert.equal(effectiveIndexOffset(1n, ['uxtw'], 2), null);
assert.equal(effectiveIndexOffset(1n, 'uxtw', ['2']), null);
assert.equal(effectiveIndexOffset({}, 'uxtw', 2), null);
assert.equal(effectiveIndexOffset(1n, { toString: () => 'uxtw' }, 2), null);
assert.equal(effectiveIndexOffset('2', 'uxtw', 2), null);
assert.equal(effectiveIndexOffset(1n, 'uxtw', '2'), null);
assert.equal(effectiveIndexOffset(1n, 'uxtw', true), null);

// 2. Fractional / NaN / Infinity / negative / oversized scale fail closed without raw exceptions.
assert.equal(effectiveIndexOffset(1n, 'uxtw', 1.5), null);
assert.equal(effectiveIndexOffset(1n, 'uxtw', Number.NaN), null);
assert.equal(effectiveIndexOffset(1n, 'uxtw', Number.POSITIVE_INFINITY), null);
assert.equal(effectiveIndexOffset(1n, 'uxtw', -1), null);
assert.equal(effectiveIndexOffset(1n, 'uxtw', Number.MAX_SAFE_INTEGER), null);
assert.equal(effectiveIndexOffset(1n, 'uxtw', 5), null);

// 3. Unknown extend selector stays fail-closed.
assert.equal(effectiveIndexOffset(1n, 'rubbish', 2), null);

// 4. Canonical typed inputs keep their existing results.
assert.equal(effectiveIndexOffset(1n, 'uxtw', 2), 4n);
assert.equal(effectiveIndexOffset(1n, 'sxtw', 2), 4n);
assert.equal(effectiveIndexOffset(1n, 'sxtx', 2), 4n);
assert.equal(effectiveIndexOffset(1n, 'uxtx', 2), 4n);
assert.equal(effectiveIndexOffset(1n, 'lsl', 2), 4n);
assert.equal(effectiveIndexOffset(1n, null, 2), 4n);
assert.equal(effectiveIndexOffset(0xffffffffn, 'uxtw', 2), (0xffffffffn << 2n) & 0xfffffffffffffn);
assert.equal(effectiveIndexOffset(-1n, 'sxtw', 2), -4n);
assert.equal(effectiveIndexOffset(0x10n, 'lsl', 0), 0x10n);
assert.equal(effectiveIndexOffset(0x10n), 0x10n);
assert.equal(effectiveIndexOffset(1n, 'uxtw', 4), 16n);

// 5. Presentation helpers share the typed-boundary and bounded-scale policy.
assert.equal(renderExtendedIndex('x0', 'uxtw'), '(uint64_t)(uint32_t)x0');
assert.equal(renderExtendedIndex('x0', null), 'x0');
assert.equal(renderExtendedIndex('x0', ['uxtw']), '__arm64_index_invalid(x0)');
assert.equal(renderIndexedMemory('x1', 'x0', { extend: 'uxtw', scale: ['2'] }), 'memory[x1 + (uint64_t)(uint32_t)x0]');
assert.equal(renderIndexedMemory('x1', 'x0', { extend: 'uxtw', scale: Number.MAX_SAFE_INTEGER }), 'memory[x1 + (uint64_t)(uint32_t)x0]');
assert.equal(renderIndexedMemory('x1', 'x0', { extend: 'uxtw', scale: 2, size: 4 }), 'x1[(uint64_t)(uint32_t)x0]');
assert.equal(
  renderIndexedMemory('x1', 'x0', { extend: 'uxtw', scale: 2, size: 8 }),
  'memory[x1 + ((uint64_t)(uint32_t)x0 << 2)]',
);

console.log('#6202: All tests passed successfully.');
