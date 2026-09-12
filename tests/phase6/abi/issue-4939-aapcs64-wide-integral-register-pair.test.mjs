import assert from 'node:assert/strict';
import test from 'node:test';

import { classifyCallArguments } from '../../../js/architecture/compat/ir-core-arm64-aapcs64-v1.js';

/* AAPCS64 Stage C rules C.10/C.11: a 16-byte Integral Type rounds NGRN up to
 * an even register and consumes the consecutive pair x[NGRN]/x[NGRN+1]; with
 * no fitting pair the argument (and NGRN) moves to the stack. The compat v1
 * lifter spent exactly one GP register for every non-FP argument, so a
 * 128-bit integral claimed a single x-register while its metadata said 128
 * bits (#4939). */

const WIDE = { type: '__int128', bits: 128 };

test('a 128-bit integral after one GP argument takes the even pair x2/x3', () => {
  const out = classifyCallArguments({
    callPrototype: {
      args: [
        { type: 'uint64_t', bits: 64 },
        WIDE,
      ],
    },
  }, {});
  const arg1 = out.arguments[1];
  assert.deepEqual(arg1.regs, ['x2', 'x3']);
  assert.equal(arg1.reg, 'x2');
  assert.equal(arg1.location, 'registers');
  assert.equal(arg1.abiClass, 'wide-integer');
  assert.equal(arg1.bits, 128);
  assert.deepEqual(out.srcs.filter((s) => s.reg === 'x2' || s.reg === 'x3').map((s) => s.reg), ['x2', 'x3']);
});

test('a 128-bit integral at NGRN=0 takes the aligned pair x0/x1', () => {
  const out = classifyCallArguments({
    callPrototype: { args: [WIDE] },
  }, {});
  assert.deepEqual(out.arguments[0].regs, ['x0', 'x1']);
});

test('an odd NGRN is rounded up before the pair is allocated', () => {
  const out = classifyCallArguments({
    callPrototype: {
      args: [
        { type: 'uint64_t', bits: 64 },
        { type: 'uint32_t', bits: 32 },
        WIDE,
      ],
    },
  }, {});
  assert.equal(out.arguments[0].reg, 'x0');
  assert.equal(out.arguments[1].reg, 'x1');
  assert.deepEqual(out.arguments[2].regs, ['x2', 'x3']);
});

test('without a fitting pair the wide integral and NGRN move to the stack', () => {
  const out = classifyCallArguments({
    callPrototype: {
      args: [
        { type: 'uint64_t', bits: 64 },
        { type: 'uint64_t', bits: 64 },
        { type: 'uint64_t', bits: 64 },
        { type: 'uint64_t', bits: 64 },
        { type: 'uint64_t', bits: 64 },
        { type: 'uint64_t', bits: 64 },
        { type: 'uint64_t', bits: 64 },
        WIDE,
      ],
    },
  }, {});
  const wide = out.arguments[7];
  assert.equal(wide.location, 'stack');
  assert.equal(wide.bytes, 16);
  assert.equal(out.arguments[0].reg, 'x0');
  assert.equal(out.arguments[6].reg, 'x6');
});

test('a wide integral at NGRN=6 takes the last legal pair x6/x7', () => {
  const out = classifyCallArguments({
    callPrototype: {
      args: [
        { type: 'uint64_t', bits: 64 },
        { type: 'uint64_t', bits: 64 },
        { type: 'uint64_t', bits: 64 },
        { type: 'uint64_t', bits: 64 },
        { type: 'uint64_t', bits: 64 },
        { type: 'uint64_t', bits: 64 },
        WIDE,
      ],
    },
  }, {});
  assert.deepEqual(out.arguments[6].regs, ['x6', 'x7']);
});

test('a wide integral at odd NGRN=7 cannot split a phantom x8 half and moves to the stack', () => {
  const out = classifyCallArguments({
    callPrototype: {
      args: [
        { type: 'uint64_t', bits: 64 },
        { type: 'uint64_t', bits: 64 },
        { type: 'uint64_t', bits: 64 },
        { type: 'uint64_t', bits: 64 },
        { type: 'uint64_t', bits: 64 },
        { type: 'uint64_t', bits: 64 },
        { type: 'uint64_t', bits: 64 },
        WIDE,
      ],
    },
  }, {});
  const wide = out.arguments[7];
  assert.equal(wide.location, 'stack', 'NGRN=7 rounds up to 8 with no pair; stack required');
  assert.equal(wide.bytes, 16);
});

test('a 128-bit aggregate argument is not reclassified as a wide integral', () => {
  const out = classifyCallArguments({
    callPrototype: {
      args: [
        { type: 'uint64_t', bits: 64 },
        { type: 'struct16', bits: 128, abiClass: 'aggregate', aggregate: true },
      ],
    },
  }, {});
  const composite = out.arguments[1];
  assert.notDeepEqual(composite.regs ?? null, ['x2', 'x3'], 'width alone must not open the C.10/C.11 pair path for a composite');
  assert.equal(composite.reg, 'x1', 'a 128-bit composite keeps the ordinary conservative single-register record');
  assert.equal(composite.abiClass, 'integer', 'the composite is not relabelled wide-integer');

  const membersComposite = classifyCallArguments({
    callPrototype: {
      args: [
        { type: 'uint64_t', bits: 64 },
        { type: 'struct16', bits: 128, members: 2 },
      ],
    },
  }, {});
  assert.notDeepEqual(membersComposite.arguments[1].regs ?? null, ['x2', 'x3'], 'member-carrying composites are not Integral Types');
});

test('ordinary 64-bit integral allocation is unchanged', () => {
  const out = classifyCallArguments({
    callPrototype: {
      args: [
        { type: 'uint64_t', bits: 64 },
        { type: 'uint64_t', bits: 64 },
      ],
    },
  }, {});
  assert.equal(out.arguments[0].reg, 'x0');
  assert.equal(out.arguments[1].reg, 'x1');
  assert.equal(out.arguments[1].location, 'register');
});
