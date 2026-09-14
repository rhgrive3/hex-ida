import assert from 'node:assert/strict';
import test from 'node:test';

import {
  addRange,
  addRanges,
  exactRange,
  rangeRelation,
} from '../../../js/analysis/pointsto/lattice.js';

function assertWidthLoss(result, message) {
  assert.equal(result.lost, 'width-overflow', message);
  assert.equal(result.range.min, null, message);
  assert.equal(result.range.max, null, message);
}

test('known pointer-width overflow still widens to unbounded', () => {
  const maxSigned64 = (1n << 63n) - 1n;
  assertWidthLoss(addRange(exactRange(maxSigned64), 1n, 64), 'known 64-bit overflow');
  assertWidthLoss(addRanges(exactRange(maxSigned64), exactRange(1n), 64), 'known 64-bit ranged overflow');
});

test('missing or malformed width cannot preserve an exact arithmetic result', () => {
  const invalidWidths = [
    null,
    undefined,
    0,
    1,
    NaN,
    Infinity,
    '64',
    64n,
    true,
    [],
    [64],
    {},
  ];

  for (const widthBits of invalidWidths) {
    assertWidthLoss(addRange(exactRange(8n), 4n, widthBits), `addRange width=${String(widthBits)}`);
    assertWidthLoss(addRanges(exactRange(8n), exactRange(4n), widthBits), `addRanges width=${String(widthBits)}`);
  }
});

test('width validation never invokes caller-controlled numeric coercion', () => {
  let coercions = 0;
  const widthBits = {
    [Symbol.toPrimitive]() {
      coercions += 1;
      return 64;
    },
  };

  assertWidthLoss(addRange(exactRange(8n), 4n, widthBits), 'structured width addRange');
  assertWidthLoss(addRanges(exactRange(8n), exactRange(4n), widthBits), 'structured width addRanges');
  assert.equal(coercions, 0);
});

test('valid primitive widths preserve in-range exact arithmetic', () => {
  const single = addRange(exactRange(8n), 4n, 64);
  assert.equal(single.lost, null);
  assert.deepEqual(single.range, exactRange(12n));

  const ranged = addRanges(exactRange(8n), exactRange(4n), 64);
  assert.equal(ranged.lost, null);
  assert.deepEqual(ranged.range, exactRange(12n));
});

test('unknown-width arithmetic cannot manufacture a NoAlias interval', () => {
  const unknownWidth = addRange(exactRange(0n), 16n, null);
  assertWidthLoss(unknownWidth, 'unknown-width arithmetic');
  assert.equal(rangeRelation(unknownWidth.range, 8n, exactRange(4096n), 8n), 'may');
});
