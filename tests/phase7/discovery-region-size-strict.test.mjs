import assert from 'node:assert/strict';
import { regionFromSize } from '../../js/analysis/discovery/fusion.js';

const valid = [
  [4096n, 32n],
  [4096, 32],
  ['4096', '32'],
  [' 4096 ', '+32'],
];
for (const [start, size] of valid) {
  const region = regionFromSize(start, size);
  assert.equal(region?.start, '4096');
  assert.equal(region?.end, '4128');
  assert.equal(region?.ownership, 'exclusive');
}

assert.equal(regionFromSize(4096n, 0n), null);
assert.equal(regionFromSize(4096n, -1n), null);

const malformed = [
  [['4096'], 32n],
  [4096n, ['32']],
  [4096n, true],
  [4096n, false],
  [4096n, { valueOf() { return 32; } }],
  [4096n, 1.5],
  [4096n, Number.NaN],
  [4096n, Number.POSITIVE_INFINITY],
  [4096n, '32.0'],
  [4096n, ''],
];
for (const [start, size] of malformed) {
  assert.equal(regionFromSize(start, size), null, `malformed ${String(size)} must fail closed`);
}

console.log('discovery region size strict boundary: ok');
