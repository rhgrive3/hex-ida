import test from 'node:test';
import assert from 'node:assert/strict';

import { buildSemanticModel } from '../../js/blocks.js';
import { findValueUpdates } from '../../js/dataflow.js';

const BASE = 0x100000000n;
const TARGET = 0x100000100n;
const LINES = [
  'adrp x8, #0x100004000',
  'ldrsw x2, [x8, #0x20]',
  `b #0x${TARGET.toString(16)}`,
];

function modelFor(symbol) {
  const rows = LINES.map((line, row) => {
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
    symbolFor: (address) => address === TARGET ? symbol : null,
    rowOfAddress: (address) => {
      const delta = address - BASE;
      return delta < 0n || delta >= BigInt(rows.length * 4) ? null : Number(delta / 4n);
    },
  });
}

test('#3709 non-runtime symbols containing ObjC helper text do not mint confirmed field evidence', () => {
  for (const symbol of [
    'my_objc_getProperty_probe',
    'objc_setProperty_debug_wrapper',
    'not_objc_setProperty_nonatomic_copy',
  ]) {
    assert.deepEqual(findValueUpdates(modelFor(symbol)), [], symbol);
  }
});

test('#3709 canonical ObjC property helpers retain their ABI-specialized evidence', () => {
  const controls = [
    ['objc_getProperty', 'read', 'x0'],
    ['_objc_getProperty', 'read', 'x0'],
    ['objc_setProperty', 'write', 'x3'],
    ['_objc_setProperty_atomic', 'write', 'x3'],
    ['objc_setProperty_nonatomic', 'write', 'x3'],
    ['_objc_setProperty_atomic_copy', 'write', 'x3'],
    ['objc_setProperty_nonatomic_copy', 'write', 'x3'],
  ];
  for (const [symbol, kind, register] of controls) {
    const updates = findValueUpdates(modelFor(symbol));
    assert.equal(updates.length, 1, symbol);
    assert.equal(updates[0].kind, kind, symbol);
    assert.equal(updates[0].register, register, symbol);
    assert.equal(updates[0].confidence, 1, symbol);
    assert.equal(updates[0].helper, symbol, symbol);
    assert.equal(updates[0].location.indexAddr, 0x100004020n, symbol);
  }
});
