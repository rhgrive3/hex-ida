import assert from 'node:assert/strict';
import test from 'node:test';
import { buildSemanticModel } from '../../js/blocks.js';
import { selfRegisters } from '../../js/dataflow-legacy.js';
import { fieldUse } from '../../js/verify.js';

const BASE = 0x100000000n;

function build(lines) {
  const instructions = lines.map((line, row) => {
    const text = String(line).trim();
    const split = text.indexOf(' ');
    return {
      row,
      address: BASE + BigInt(row) * 4n,
      mn: split < 0 ? text : text.slice(0, split),
      ops: split < 0 ? '' : text.slice(split + 1).trim(),
    };
  });
  return buildSemanticModel(instructions, {
    startRow: 0,
    endRow: instructions.length - 1,
    symbolFor: () => null,
    rowOfAddress: () => null,
  });
}

test('Issue #3637: only the XZR ORR MOV alias propagates self identity', () => {
  const ordinary = build([
    'orr x19, x0, x1',
    'ldr w8, [x19, #0x20]',
    'ret',
  ]);
  assert.equal(selfRegisters(ordinary).isSelf('x19', 1), false);
  assert.equal(fieldUse(ordinary, 0x20n).loads, 0);

  const alias = build([
    'orr x19, xzr, x0',
    'ldr w8, [x19, #0x20]',
    'ret',
  ]);
  assert.equal(selfRegisters(alias).isSelf('x19', 1), true);
  assert.equal(fieldUse(alias, 0x20n).loads, 1);

  const shifted = build([
    'orr x19, xzr, x0, lsl #1',
    'ldr w8, [x19, #0x20]',
    'ret',
  ]);
  assert.equal(selfRegisters(shifted).isSelf('x19', 1), false);

  const mov = build(['mov x19, x0', 'ret']);
  assert.equal(selfRegisters(mov).isSelf('x19', 1), true);
});
