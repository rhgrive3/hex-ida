import test from 'node:test';
import assert from 'node:assert/strict';

import { RISCV_LP64D_ABI } from '../../../js/targets/abi/riscv-lp64.js';

// #5619: the psABI hardware floating-point convention flattens the FULL
// struct/array hierarchy before applying the one/two floating-point-real
// rules. A nested aggregate used to stop the flattening at the top level and
// fall through to the integer convention while still reporting exact:true.

function classify(args, options = {}) {
  return RISCV_LP64D_ABI.classifyArguments({ callPrototype: { args, ...options } });
}

function piecesOf(result, index) {
  const argument = result.arguments.find((entry) => entry?.index === index);
  assert.ok(argument, `argument ${index} must classify`);
  return argument;
}

const FLOAT = (offset) => ({ type: 'float', floating: true, bits: 32, bytes: 4, byteOffset: offset });

test('#5619 nested struct { struct{float}, float } flattens to two FP reals', () => {
  const outer = {
    type: 'struct Outer', abiClass: 'aggregate', aggregate: true,
    bits: 64, bytes: 8,
    members: [
      { type: 'struct Inner', abiClass: 'aggregate', aggregate: true, bits: 32, bytes: 4, byteOffset: 0,
        members: [FLOAT(0)] },
      FLOAT(4),
    ],
  };
  const result = classify([outer]);
  const argument = piecesOf(result, 0);
  assert.equal(argument.location, 'flattened-registers',
    'the nested FP member must participate in FP flattening');
  assert.deepEqual(argument.regs, ['f10', 'f11'], 'two FP reals take fa0/fa1 (f10/f11)');
  assert.equal(argument.exact, true);
  assert.deepEqual(argument.parts.map((part) => part.byteOffset), [0, 4]);
  assert.deepEqual(argument.parts.map((part) => part.abiClass), ['float', 'float']);
});

test('#5619 the psABI three-level example flattens through the array', () => {
  // struct { struct { float f[1]; } a[2]; } — same as struct { float f0; float f1; }
  const outer = {
    type: 'struct A', abiClass: 'aggregate', aggregate: true,
    bits: 64, bytes: 8,
    members: [{
      type: 'struct Inner[2]', abiClass: 'aggregate', aggregate: true, bits: 64, bytes: 8, byteOffset: 0,
      elements: [
        { type: 'struct Inner', abiClass: 'aggregate', aggregate: true, bits: 32, bytes: 4, byteOffset: 0,
          members: [FLOAT(0)] },
        { type: 'struct Inner', abiClass: 'aggregate', aggregate: true, bits: 32, bytes: 4, byteOffset: 4,
          members: [FLOAT(0)] },
      ],
    }],
  };
  const result = classify([outer]);
  const argument = piecesOf(result, 0);
  assert.equal(argument.location, 'flattened-registers');
  assert.deepEqual(argument.regs, ['f10', 'f11']);
});

test('#5619 mixed nested FP + integer still flattens to FP + GPR', () => {
  const outer = {
    type: 'struct Mixed', abiClass: 'aggregate', aggregate: true,
    bits: 64, bytes: 8,
    members: [
      { type: 'struct Inner', abiClass: 'aggregate', aggregate: true, bits: 32, bytes: 4, byteOffset: 0,
        members: [FLOAT(0)] },
      { type: 'int', bits: 32, bytes: 4, byteOffset: 4 },
    ],
  };
  const result = classify([outer]);
  const argument = piecesOf(result, 0);
  assert.equal(argument.location, 'flattened-registers');
  assert.deepEqual(argument.parts.map((part) => part.abiClass), ['float', 'integer']);
  assert.deepEqual(argument.regs, ['f10', 'x10']);
});

test('#5619 an integer-only nested aggregate keeps the integer convention', () => {
  const outer = {
    type: 'struct Ints', abiClass: 'aggregate', aggregate: true,
    bits: 64, bytes: 8,
    members: [
      { type: 'struct Inner', abiClass: 'aggregate', aggregate: true, bits: 32, bytes: 4, byteOffset: 0,
        members: [{ type: 'int', bits: 32, bytes: 4, byteOffset: 0 }] },
      { type: 'int', bits: 32, bytes: 4, byteOffset: 4 },
    ],
  };
  const result = classify([outer]);
  const argument = piecesOf(result, 0);
  assert.equal(argument.abiClass, 'aggregate-integer-registers',
    'no FP leaf means the integer convention stays authoritative');
});

test('#5619 an unproven nested layout fails closed instead of guessing', () => {
  const outer = {
    type: 'struct Unproven', abiClass: 'aggregate', aggregate: true,
    bits: 64, bytes: 8,
    members: [
      // No member evidence for the nested aggregate: its physical layout is
      // unproven, so no exact FP placement may be minted.
      { type: 'struct Inner', abiClass: 'aggregate', aggregate: true, bits: 32, bytes: 4, byteOffset: 0 },
      FLOAT(4),
    ],
  };
  const result = classify([outer]);
  const argument = result.arguments.find((entry) => entry?.index === 0);
  assert.equal(argument.exact !== true || argument.location === 'unknown', true,
    `a nested layout without member evidence must not produce an exact FP placement: ${JSON.stringify(argument)}`);
});
