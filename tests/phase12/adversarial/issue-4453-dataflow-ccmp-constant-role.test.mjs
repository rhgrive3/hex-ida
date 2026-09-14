import assert from 'node:assert/strict';
import { buildSemanticModel } from '../../../js/blocks.js';
import { constantComparisons, constantComparisonsLegacy } from '../../../js/dataflow.js';

const BASE = 0x100000000n;

function modelOf(lines) {
  const rows = lines.map((line, row) => {
    const split = line.indexOf(' ');
    return {
      row,
      address: BASE + BigInt(row * 4),
      mn: split < 0 ? line : line.slice(0, split),
      ops: split < 0 ? '' : line.slice(split + 1),
    };
  });
  return buildSemanticModel(rows, {
    startRow: 0,
    endRow: rows.length - 1,
    rowOfAddress: () => null,
  });
}

function legacy(line) {
  return constantComparisonsLegacy(modelOf([line, 'ret']));
}

function facade(line) {
  return constantComparisons(modelOf([line, 'ret']));
}

assert.deepEqual(legacy('ccmp x0, x1, #0, ne'), [],
  'register-form CCMP must not expose fallback NZCV as a comparison literal');
assert.deepEqual(legacy('ccmn w0, w1, #15, eq'), [],
  'register-form CCMN must not expose fallback NZCV as a comparison literal');
assert.equal(legacy('ccmp x0, x1, #0, ne').length, 0,
  'changing fallback NZCV must not create a threshold');

assert.equal(legacy('ccmp x0, #31, #15, ne')[0].value, 31n,
  'immediate-form CCMP keeps the actual comparison operand');
assert.equal(legacy('ccmn w0, #7, #15, eq')[0].value, 7n,
  'immediate-form CCMN keeps the actual comparison operand');

assert.equal(legacy('cmp w8, #100')[0].value, 100n,
  'ordinary integer comparisons keep their literal threshold');
assert.equal(legacy('fcmp d0, #0.0')[0].float, 0,
  'ordinary floating comparisons keep their zero literal');

assert.deepEqual(facade('ccmp x0, x1, #15, ne'), [],
  'IR-backed facade must agree that register-form CCMP has no threshold literal');
assert.equal(facade('ccmp x0, #31, #15, ne')[0].value, 31n,
  'IR-backed facade must agree on the immediate-form CCMP operand');

console.log('[phase12] issue #4453 CCMP/CCMN immediate-role regressions passed');
