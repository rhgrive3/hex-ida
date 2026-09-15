import assert from 'node:assert/strict';
import { buildSemanticModel } from '../../js/blocks.js';

const BASE = 0x100000n;

function model(lines) {
  const raw = lines.map((line, row) => {
    const split = line.indexOf(' ');
    return {
      row,
      address: BASE + BigInt(row * 4),
      mn: split < 0 ? line : line.slice(0, split),
      ops: split < 0 ? '' : line.slice(split + 1),
    };
  });
  return buildSemanticModel(raw, {
    startRow: 0,
    endRow: raw.length - 1,
    rowOfAddress: (address) => {
      const delta = address - BASE;
      if (delta < 0n || delta >= BigInt(raw.length * 4)) return null;
      return Number(delta / 4n);
    },
  });
}

function target(row) {
  return '#0x' + (BASE + BigInt(row * 4)).toString(16);
}

// One predecessor path writes x0, the other keeps the function-entry x0 live.
// The join must still recognise x0 as an entry argument candidate.
assert.deepEqual(model([
  `cbz x1, ${target(2)}`,
  'mov x0, #1',
  `add x2, x0, #1`,
  'ret',
]).argRegs, [0, 1], 'a write on only one predecessor must not launder entry x0');

// The same CFG with the two paths laid out in the opposite textual order
// must produce the same argRegs.
assert.deepEqual(model([
  `cbnz x1, ${target(2)}`,
  `b ${target(3)}`,
  'mov x0, #1',
  'add x2, x0, #1',
  'ret',
]).argRegs, [0, 1], 'block order must not change the join result');

// Every predecessor kills x0 before the join: entry x0 is not an argument.
assert.deepEqual(model([
  `cbz x1, ${target(3)}`,
  'mov x0, #1',
  `b ${target(4)}`,
  'mov x0, #2',
  'add x2, x0, #1',
  'ret',
]).argRegs, [1], 'a write proven on every path must remain excluded');

// No predecessor writes x0: the join read is an entry argument.
assert.deepEqual(model([
  `cbz x1, ${target(3)}`,
  'mov x2, #1',
  `b ${target(4)}`,
  'mov x3, #2',
  'add x4, x0, #1',
  'ret',
]).argRegs, [0, 1], 'an unwritten join read stays an entry argument');

// A branch condition that reads x1 before any write keeps the existing result.
assert.deepEqual(model([
  `cbz x1, ${target(2)}`,
  'mov x2, #1',
  'ret',
]).argRegs, [1], 'entry-register reads before the join are unaffected');

console.log('issue #3921 CFG join entry-argument merge: PASS');
