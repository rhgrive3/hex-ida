import assert from 'node:assert/strict';
import test from 'node:test';

import { buildCil } from '../fixtures/medium-cil.mjs';
import { parseCil } from '../../../js/managed/cil/parser.js';
import { liftCilMethod } from '../../../js/managed/cil/lifter.js';
import { validateCilEffectFunction } from '../../../js/managed/cil/validation.js';

const i8 = (value) => [0x21, ...[...new Uint8Array(new BigUint64Array([BigInt(value)]).buffer)]];
const VOID = [0x00, 0x00, 0x01];

function lift(body, options = {}) {
  const built = buildCil({
    methods: [{ name: 'F', body, signature: VOID, ...options }],
  });
  return liftCilMethod(0, parseCil(built.bytes));
}

const bundleAt = (lifted, offset) => lifted.bundles.find((bundle) => bundle.bytecodeOffset === offset);

test('#4043 int64 constants keep 64-bit width through add', () => {
  const lifted = lift([...i8(1), ...i8(2), 0x58, 0x26, 0x2a]);
  const add = bundleAt(lifted, 18);
  assert.equal(add.mnemonic, 'add');
  assert.equal(add.completeness, 'exact');
  assert.deepEqual(add.consumedValues, [{ id: 'rhs', bits: 64 }, { id: 'lhs', bits: 64 }]);
  assert.deepEqual(add.producedValues, [{ bits: 64 }]);
  assert.equal(validateCilEffectFunction(lifted).status, 'valid');
});

test('#4043 int64 constants keep 64-bit width through unary neg and not', () => {
  for (const [opcode, mnemonic] of [[0x65, 'neg'], [0x66, 'not']]) {
    const lifted = lift([...i8(0x100000000n), opcode, 0x26, 0x2a]);
    const op = bundleAt(lifted, 9);
    assert.equal(op.mnemonic, mnemonic);
    assert.equal(op.completeness, 'exact');
    assert.deepEqual(op.consumedValues, [{ id: 'val', bits: 64 }]);
    assert.deepEqual(op.producedValues, [{ bits: 64 }]);
  }
});

test('#4043 int32 arithmetic stays 32-bit exact', () => {
  const lifted = lift([0x16, 0x17, 0x58, 0x26, 0x2a]);
  const add = bundleAt(lifted, 2);
  assert.equal(add.completeness, 'exact');
  assert.deepEqual(add.consumedValues, [{ id: 'rhs', bits: 32 }, { id: 'lhs', bits: 32 }]);
  assert.deepEqual(add.producedValues, [{ bits: 32 }]);
});

test('#4043 shift result width follows the value operand', () => {
  const lifted = lift([...i8(1), 0x17, 0x62, 0x26, 0x2a]);
  const shl = bundleAt(lifted, 10);
  assert.equal(shl.mnemonic, 'shl');
  assert.equal(shl.completeness, 'exact');
  assert.deepEqual(shl.consumedValues, [{ id: 'rhs', bits: 32 }, { id: 'lhs', bits: 64 }]);
  assert.deepEqual(shl.producedValues, [{ bits: 64 }]);
});

test('#4043 unresolved or contradictory operand width never becomes 32-bit exact', () => {
  for (const [label, body, offset] of [
    ['mixed width', [...i8(1), 0x17, 0x58, 0x26, 0x2a], 10],
    ['unresolved local', [0x06, ...i8(2), 0x58, 0x26, 0x2a], 10],
    ['empty stack', [0x58, 0x26, 0x2a], 0],
  ]) {
    const lifted = lift(body);
    const add = bundleAt(lifted, offset);
    assert.equal(add.mnemonic, 'add', label);
    assert.equal(add.completeness, 'partial', label);
    assert.equal(add.consumedValues[0].bits, undefined, label);
    assert.equal(add.consumedValues[1].bits, undefined, label);
    assert.equal(add.producedValues[0].bits, undefined, label);
    assert.ok(add.unknownEffects.some((effect) => effect.reason === 'cil-arithmetic-operand-width-unresolved'), label);
  }
});
