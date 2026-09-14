import test from 'node:test';
import assert from 'node:assert/strict';

import { RISCV_LP64D_ABI } from '../../../js/targets/abi/riscv-lp64.js';

const VECTOR_CC = 'riscv_vector_cc';

const fixedVector = (bits, extra = {}) => ({
  type: 'fixed vector',
  vector: true,
  fixedLengthVector: true,
  bits,
  ...extra,
});

function classifyArgs(args, options = {}) {
  return RISCV_LP64D_ABI.classifyArguments({
    callPrototype: { args, callingConvention: VECTOR_CC },
    abiVlen: 128,
    ...options,
  });
}

function classifyRet(bits, options = {}, extraProto = {}) {
  return RISCV_LP64D_ABI.classifyFunctionReturn({
    functionPrototype: {
      returnType: 'fixed vector',
      returnVector: { vector: true, fixedLengthVector: true, ...extraProto },
      callingConvention: VECTOR_CC,
      bits,
    },
    abiVlen: 128,
    ...options,
  });
}

function regsOf(result, index) {
  const argument = result.arguments.find((entry) => entry?.index === index);
  assert.ok(argument, `argument ${index} must classify`);
  return argument.regs ?? (argument.reg ? [argument.reg] : []);
}

test('#5616 fixed-length vector register group size derived from bits and ABI_VLEN=128', () => {
  // 64, 96, 128 -> 1 register
  for (const bits of [64, 96, 128]) {
    const res = classifyArgs([fixedVector(bits)]);
    assert.deepEqual(regsOf(res, 0), ['v8'], `bits=${bits} must occupy 1 register (v8)`);
    assert.equal(res.arguments[0].exact, true);
  }

  // 192, 256 -> 2 registers
  for (const bits of [192, 256]) {
    const res = classifyArgs([fixedVector(bits)]);
    assert.deepEqual(regsOf(res, 0), ['v8', 'v9'], `bits=${bits} must occupy 2 registers (v8, v9)`);
    assert.equal(res.arguments[0].exact, true);
  }

  // 384, 512 -> 4 registers
  for (const bits of [384, 512]) {
    const res = classifyArgs([fixedVector(bits)]);
    assert.deepEqual(regsOf(res, 0), ['v8', 'v9', 'v10', 'v11'], `bits=${bits} must occupy 4 registers (v8-v11)`);
    assert.equal(res.arguments[0].exact, true);
  }

  // 1024 -> 8 registers
  {
    const res = classifyArgs([fixedVector(1024)]);
    assert.deepEqual(
      regsOf(res, 0),
      ['v8', 'v9', 'v10', 'v11', 'v12', 'v13', 'v14', 'v15'],
      '1024 bits must occupy 8 registers (v8-v15)',
    );
    assert.equal(res.arguments[0].exact, true);
  }

  // > 8 * ABI_VLEN -> fail closed / cannot allocate exact registers
  {
    const res = classifyArgs([fixedVector(2048)]);
    assert.equal(res.arguments[0].exact, false, '>8xVLEN must fail closed');
    assert.equal(res.arguments[0].partial, true);
  }
});

test('#5616 argument register start obeys derived group alignment and hole reuse', () => {
  // Arg 0: 128 bits -> group 1 -> v8.
  // Arg 1: 256 bits -> group 2 -> must align to multiple of 2; v9 is skipped, takes v10, v11.
  // Arg 2: 128 bits -> group 1 -> re-scans and takes v9.
  const res = classifyArgs([fixedVector(128), fixedVector(256), fixedVector(128)]);
  assert.deepEqual(regsOf(res, 0), ['v8']);
  assert.deepEqual(regsOf(res, 1), ['v10', 'v11']);
  assert.deepEqual(regsOf(res, 2), ['v9']);
});

test('#5616 return register group uses same derived count', () => {
  const ret128 = classifyRet(128);
  assert.deepEqual(ret128.regs, ['v8']);

  const ret256 = classifyRet(256);
  assert.deepEqual(ret256.regs, ['v8', 'v9'], '256-bit return must occupy 2 registers (v8, v9)');

  const ret512 = classifyRet(512);
  assert.deepEqual(ret512.regs, ['v8', 'v9', 'v10', 'v11'], '512-bit return must occupy 4 registers');
});

test('#5616 ABI_VLEN=64 and 256 change derived group thresholds', () => {
  // At ABI_VLEN=64: 128 bits -> 2 registers; 256 bits -> 4 registers.
  const res64_128 = classifyArgs([fixedVector(128)], { abiVlen: 64 });
  assert.deepEqual(regsOf(res64_128, 0), ['v8', 'v9']);

  const res64_256 = classifyArgs([fixedVector(256)], { abiVlen: 64 });
  assert.deepEqual(regsOf(res64_256, 0), ['v8', 'v9', 'v10', 'v11']);

  // At ABI_VLEN=256: 256 bits -> 1 register; 512 bits -> 2 registers.
  const res256_256 = classifyArgs([fixedVector(256)], { abiVlen: 256 });
  assert.deepEqual(regsOf(res256_256, 0), ['v8']);

  const res256_512 = classifyArgs([fixedVector(512)], { abiVlen: 256 });
  assert.deepEqual(regsOf(res256_512, 0), ['v8', 'v9']);
});

test('#5616 explicit conflicting lmul fails closed as conflict', () => {
  // 256 bits on ABI_VLEN=128 derives group 2; explicit lmul: 1 contradicts it.
  const res = classifyArgs([fixedVector(256, { lmul: 1 })]);
  assert.equal(res.arguments[0].exact, false);
  assert.equal(res.arguments[0].partial, true);
  assert.equal(res.arguments[0].abiClass, 'vector-descriptor-conflict');

  const ret = classifyRet(256, {}, { lmul: 1 });
  assert.equal(ret.partial, true);
  assert.equal(ret.reason, 'vector-return-descriptor-conflict');
});

test('fixed-length vectors cannot also claim the v0 mask register', () => {
  const argument = classifyArgs([fixedVector(256, { mask:true })]);
  assert.equal(argument.arguments[0].exact, false);
  assert.equal(argument.arguments[0].partial, true);
  assert.equal(argument.arguments[0].abiClass, 'vector-descriptor-conflict');

  const result = classifyRet(256, {}, { mask:true });
  assert.equal(result.partial, true);
  assert.equal(result.reason, 'vector-return-descriptor-conflict');
});
