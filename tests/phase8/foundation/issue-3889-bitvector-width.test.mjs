import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SUPPORTED_WIDTHS,
  bitvector,
  evaluateBinary,
  extractField,
  insertField,
  isSupportedWidth,
  maxSigned,
  maxUnsigned,
  minSigned,
  signExtend,
  truncate,
  unsignedOf,
  zeroExtend,
} from '../../../js/decompiler/phase8/bitvector.js';

const malformedWidths = [
  '32',
  '8',
  [32],
  [8],
  true,
  false,
  NaN,
  Infinity,
  1.5,
  -8,
  24,
];

test('issue #3889: exact bitvector widths require supported primitive integers', () => {
  for (const width of SUPPORTED_WIDTHS) assert.equal(isSupportedWidth(width), true, String(width));
  for (const width of malformedWidths) assert.equal(isSupportedWidth(width), false, String(width));

  let valueOfCalls = 0;
  const viaValueOf = { valueOf() { valueOfCalls += 1; return 32; } };
  let primitiveCalls = 0;
  const viaPrimitive = { [Symbol.toPrimitive]() { primitiveCalls += 1; return 64; } };

  assert.equal(isSupportedWidth(viaValueOf), false);
  assert.equal(isSupportedWidth(viaPrimitive), false);
  assert.equal(valueOfCalls, 0);
  assert.equal(primitiveCalls, 0);

  assert.throws(() => bitvector(1n, viaValueOf), TypeError);
  assert.throws(() => bitvector(1n, viaPrimitive), TypeError);
  assert.throws(() => unsignedOf(1n, '32'), TypeError);
  assert.throws(() => maxUnsigned('8'), TypeError);
  assert.throws(() => minSigned([8]), TypeError);
  assert.throws(() => maxSigned(true), TypeError);

  assert.equal(maxUnsigned(8), 0xffn);
  assert.equal(minSigned(8), -0x80n);
  assert.equal(maxSigned(8), 0x7fn);
});

test('issue #3889: valid arithmetic still wraps at the declared width', () => {
  const left = bitvector(0xfffffff0n, 32);
  const right = bitvector(0x20n, 32);
  assert.deepEqual(evaluateBinary('add', left, right), bitvector(0x10n, 32));
});

test('issue #3889: extension and field helpers do not launder malformed widths', () => {
  const value = bitvector(0xffn, 8);
  assert.equal(truncate(value, '8'), null);
  assert.equal(zeroExtend(value, [32]), null);
  assert.equal(signExtend(value, '32'), null);
  assert.equal(extractField(value, 0, '8'), null);
  assert.equal(extractField(value, 0, [8]), null);
  assert.equal(insertField(value, { bits: '8', value: 1n }, 0), null);
  assert.equal(insertField({ bits: '8', value: 0n }, value, 0), null);

  assert.deepEqual(truncate(value, 8), value);
  assert.deepEqual(zeroExtend(value, 16), bitvector(0xffn, 16));
  assert.deepEqual(signExtend(value, 16), bitvector(0xffffn, 16));
  assert.deepEqual(extractField(value, 0, 8), value);
  assert.deepEqual(insertField(bitvector(0n, 8), bitvector(0xfn, 8), 0), bitvector(0xfn, 8));
});
