import assert from 'node:assert/strict';
import test from 'node:test';

import { integerText } from '../../../js/decompiler/pretty/c.js';

function asInt128(text) {
  // Evaluate the printed expression the way the C semantics would: the
  // unsigned __int128 chunk construction, cast back to signed when wrapped.
  const wide = /^__int128\)\(?/.test(text) ? text : null;
  return wide;
}

test('#5249 a negative 65..127-bit constant sign-extends into the 128-bit pattern', () => {
  // -200 at width 80 must print a value equal to -200, not 2^80-200.
  const printed = integerText(-200n, 80, true);
  assert.match(printed, /^\(\(__int128\)/);
  assert.match(printed, /0xFFFFFFFFFFFFFFFFULL << 64/);
  assert.match(printed, /0xFFFFFFFFFFFFFF38ULL/);
});

test('#5249 only the sign bit set means negative at the original width', () => {
  // 0x8000...0 at width 80 is -2^79 in 80-bit two's complement; printing
  // +2^79 would silently drop the sign (#5249).
  const negative = integerText(0x80000000000000000000n, 80, true);
  assert.match(negative, /0xFFFFFFFFFFFF8000ULL << 64/);
  // The largest positive 80-bit value keeps its zero-extended chunks.
  const plus = integerText((1n << 79n) - 1n, 80, true);
  assert.match(plus, /0x7FFFULL << 64/);
  assert.match(plus, /0xFFFFFFFFFFFFFFFFULL\)/);
});

test('#5249 unsigned wide constants keep zero extension', () => {
  const printed = integerText(2n ** 80n - 1n, 80, false);
  assert.equal(
    printed,
    '(((unsigned __int128)0xFFFFULL << 64) | 0xFFFFFFFFFFFFFFFFULL)',
  );
});

test('#5249 exact 128-bit signed values are unchanged', () => {
  const printed = integerText((1n << 127n) - 1n, 128, true);
  assert.equal(
    printed,
    '((__int128)(((unsigned __int128)0x7FFFFFFFFFFFFFFFULL << 64) | 0xFFFFFFFFFFFFFFFFULL))',
  );
});
