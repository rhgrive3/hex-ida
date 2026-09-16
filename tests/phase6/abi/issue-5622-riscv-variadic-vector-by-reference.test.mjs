import test from 'node:test';
import assert from 'node:assert/strict';

import { RISCV_LP64D_ABI } from '../../../js/targets/abi/riscv-lp64.js';

// #5622: the standard vector calling convention variant applies its vector
// register allocator to NAMED vector arguments only. "Variadic vector
// arguments are passed by reference": an anonymous variadic vector must be
// replaced by a pointer to the caller copy and allocated through the integer
// convention (next a-register, else stack), never placed in v0/v8..v23.

const VECTOR_CC = 'riscv_vector_cc';

function classify(args, extra = {}) {
  return RISCV_LP64D_ABI.classifyArguments({
    callPrototype: { args, callingConvention: VECTOR_CC, ...extra },
  });
}

function argOf(result, index) {
  const argument = result.arguments.find((entry) => entry?.index === index);
  assert.ok(argument, `argument ${index} must classify`);
  return argument;
}

function vectorRegs(result) {
  return result.arguments.flatMap((entry) => entry.regs ?? (entry.reg && /^v\d+$/.test(entry.reg) ? [entry.reg] : []));
}

test('#5622 control: a named vector argument still allocates from v8', () => {
  const result = classify([{ type: 'vint32m1_t', abiClass: 'vector' }]);
  const arg = argOf(result, 0);
  assert.deepEqual(arg.regs, ['v8']);
  assert.equal(arg.abiClass, 'vector-data');
});

test('#5622 anonymous variadic vector is passed by reference via the integer convention', () => {
  const result = classify(
    [
      { type: 'int', bits: 32 },
      { type: 'vint32m1_t', vector: true, lmul: 1, variadic: true, bits: 128 },
    ],
    { variadic: true, fixedParameterCount: 1 },
  );
  const arg = argOf(result, 1);
  assert.deepEqual(vectorRegs(result), [], 'no vector register may be consumed by a variadic vector');
  assert.equal(arg.location, 'register');
  assert.equal(arg.reg, 'x11', 'the caller-copy pointer takes the next integer argument register (a1)');
  assert.equal(arg.pointer, true);
  assert.equal(arg.bits, 64);
  assert.equal(arg.variadic, true);
});

test('#5622 anonymous variadic mask never takes v0 and is passed by reference', () => {
  const result = classify(
    [{ type: 'vbool64_t', vector: true, mask: true, variadic: true, bits: 128 }],
    { variadic: true, fixedParameterCount: 0 },
  );
  assert.deepEqual(vectorRegs(result), [], 'a variadic mask must not be allocated into v0');
  const arg = argOf(result, 0);
  assert.equal(arg.location, 'register');
  assert.equal(arg.reg, 'x10');
  assert.equal(arg.pointer, true);
});

test('#5622 anonymous variadic tuple vector is passed by reference', () => {
  const result = classify(
    [{ type: 'vint32m2x3_t', vector: true, tupleCount: 3, variadic: true, bits: 128 }],
    { variadic: true, fixedParameterCount: 0 },
  );
  assert.deepEqual(vectorRegs(result), []);
  const arg = argOf(result, 0);
  assert.equal(arg.location, 'register');
  assert.equal(arg.reg, 'x10');
  assert.equal(arg.pointer, true);
});

test('#5622 preceding integer arguments shift the copy pointer to the next integer location', () => {
  const result = classify(
    [
      { type: 'int', bits: 32 },
      { type: 'int', bits: 32 },
      { type: 'vint32m1_t', vector: true, lmul: 1, variadic: true, bits: 128 },
    ],
    { variadic: true, fixedParameterCount: 2 },
  );
  assert.equal(argOf(result, 2).reg, 'x12');
});

test('#5622 exhausted integer registers place the copy pointer on the stack', () => {
  const ints = Array.from({ length: 8 }, () => ({ type: 'int', bits: 32 }));
  const result = classify(
    [...ints, { type: 'vint32m1_t', vector: true, lmul: 1, variadic: true, bits: 128 }],
    { variadic: true, fixedParameterCount: 8 },
  );
  const arg = argOf(result, 8);
  assert.deepEqual(vectorRegs(result), []);
  assert.equal(arg.location, 'stack');
  assert.equal(arg.pointer, true);
  assert.equal(arg.offset, 0);
});

test('#5622 the variadic frontier advances after a by-reference vector', () => {
  const result = classify(
    [
      { type: 'vint32m1_t', vector: true, lmul: 1, variadic: true, bits: 128 },
      { type: 'int', bits: 32, variadic: true },
    ],
    { variadic: true, fixedParameterCount: 0 },
  );
  assert.equal(argOf(result, 0).reg, 'x10');
  const followup = argOf(result, 1);
  assert.equal(followup.location, 'register');
  assert.equal(followup.reg, 'x11', 'the next anonymous argument must follow the consumed pointer slot');
});

test('#5622 unprototyped calls never pass vectors in vector registers', () => {
  const result = RISCV_LP64D_ABI.classifyArguments({ callTarget: 0x1000 });
  assert.deepEqual(vectorRegs(result), []);
  assert.ok(result.arguments.every((entry) => entry.location === 'unknown' || entry.location === 'stack' || entry.possible === true));
});

test('#5622 a conflicting vector descriptor stays fail-closed even when variadic', () => {
  const result = classify(
    [{ type: 'vint32m2_t', lmul: 1, variadic: true, bits: 128 }],
    { variadic: true, fixedParameterCount: 0 },
  );
  const arg = argOf(result, 0);
  assert.equal(arg.exact, false);
  assert.equal(arg.location, 'unknown');
});
