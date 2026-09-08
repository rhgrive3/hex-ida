// Issue #5713 regression: the RISC-V psABI base integer calling convention
// states "fixed-length vectors are treated as aggregates". A fixed-length
// vector argument/return under the standard LP64/LP64F/LP64D convention must
// therefore take the integer convention's aggregate placement (a0/a1 or the
// hidden memory result) instead of failing closed to
// 'vector-calling-convention-unknown'.
import assert from 'node:assert/strict';
import { RISCV_LP64_ABI, RISCV_LP64D_ABI } from '../js/targets/abi/riscv-lp64.js';

// 128-bit fixed-length vector first argument: aggregate of 2*XLEN bits, so it
// splits across a0 (low 64) and a1 (high 64) — the exact placement demanded in
// the issue.
{
  const classified = RISCV_LP64_ABI.classifyArguments({
    callPrototype: {
      args: [{ type: 'fixed vector', vector: true, fixedLengthVector: true, bits: 128 }],
    },
  });
  const first = classified.arguments[0];
  assert.equal(first.location, 'registers', `128-bit fixed vector must use integer registers, got ${first.location}`);
  assert.deepEqual(first.regs, ['x10', 'x11'], '128-bit fixed vector must split across a0/a1');
  assert.deepEqual(first.abiNames, ['a0', 'a1']);
  assert.equal(first.abiClass, 'aggregate-integer-registers');
  assert.equal(first.bits, 128);
  assert.equal(first.pieces[0].reg, 'x10');
  assert.equal(first.pieces[0].byteOffset, 0);
  assert.equal(first.pieces[1].reg, 'x11');
  assert.equal(first.pieces[1].byteOffset, 8);
  assert.equal(classified.partial, false, 'the placement is fully proven by the psABI rule');
  assert.equal(classified.completeness, 'exact');
  assert.equal(classified.callingConvention, 'lp64', 'standard convention is not the vector variant');
}

// 64-bit fixed-length vector: single XLEN-sized aggregate in a0.
{
  const classified = RISCV_LP64_ABI.classifyArguments({
    callPrototype: {
      args: [{ type: 'fixed vector', vector: true, fixedLengthVector: true, bits: 64 }],
    },
  });
  const first = classified.arguments[0];
  assert.equal(first.location, 'registers');
  assert.deepEqual(first.regs, ['x10']);
  assert.equal(first.bytes, 8);
}

// 256-bit fixed-length vector: larger than 2*XLEN, passed by reference in a0.
{
  const classified = RISCV_LP64_ABI.classifyArguments({
    callPrototype: {
      args: [{ type: 'fixed vector', vector: true, fixedLengthVector: true, bits: 256 }],
    },
  });
  const first = classified.arguments[0];
  assert.equal(first.location, 'register');
  assert.equal(first.abiClass, 'aggregate-by-reference');
  assert.equal(first.reg, 'x10');
  assert.equal(first.hiddenIndirection, true);
}

// A fixed-length vector after an integer argument consumes the next slots.
{
  const classified = RISCV_LP64_ABI.classifyArguments({
    callPrototype: {
      args: [
        { type: 'unsigned long long', bits: 64 },
        { type: 'fixed vector', vector: true, fixedLengthVector: true, bits: 128 },
      ],
    },
  });
  assert.equal(classified.arguments[0].reg, 'x10');
  assert.equal(classified.arguments[1].location, 'registers');
  assert.deepEqual(classified.arguments[1].regs, ['x11', 'x12']);
}

// Variable-length vector classes still require the vector calling convention.
{
  const classified = RISCV_LP64_ABI.classifyArguments({
    callPrototype: {
      args: [{ type: 'vint32m1_t', vector: true, lmul: 1, tupleCount: 1 }],
    },
  });
  assert.equal(classified.arguments[0].location, 'unknown');
  assert.equal(classified.arguments[0].abiClass, 'vector-calling-convention-unknown');
}

// With the vector variant convention, vector registers still win for
// fixed-length vectors when ABI VLEN is declared.
{
  const classified = RISCV_LP64D_ABI.classifyArguments({
    callingConvention: 'riscv-vector-variant',
    callPrototype: {
      callingConvention: 'riscv-vector-variant',
      args: [{ type: 'fixed vector', vector: true, fixedLengthVector: true, bits: 128 }],
    },
  }, { abiVlen: 128 });
  assert.equal(classified.arguments[0].abiClass, 'vector-data');
  assert.equal(classified.arguments[0].reg, 'v8');
}

// 128-bit fixed-length vector return: a0/a1 aggregate pair.
{
  const ret = RISCV_LP64_ABI.classifyFunctionReturn({
    functionPrototype: {
      returnType: 'fixed vector', vectorReturn: true, returnVector: { fixedLengthVector: true }, returnBits: 128,
    },
  });
  assert.equal(ret.reg, 'x10');
  assert.deepEqual(ret.regs, ['x10', 'x11']);
  assert.deepEqual(ret.abiNames, ['a0', 'a1']);
  assert.equal(ret.aggregate, true);
  assert.equal(ret.bits, 128);
  assert.equal(ret.partial, undefined);
}

// 64-bit fixed-length vector return: a0 only.
{
  const ret = RISCV_LP64_ABI.classifyFunctionReturn({
    functionPrototype: {
      returnType: 'fixed vector', vectorReturn: true, returnVector: { fixedLengthVector: true }, returnBits: 64,
    },
  });
  assert.equal(ret.reg, 'x10');
  assert.deepEqual(ret.regs, ['x10']);
  assert.equal(ret.bytes, 8);
}

// 512-bit fixed-length vector return: memory result via the hidden a0 pointer.
{
  const ret = RISCV_LP64_ABI.classifyFunctionReturn({
    functionPrototype: {
      returnType: 'fixed vector', vectorReturn: true, returnVector: { fixedLengthVector: true }, returnBits: 512,
    },
  });
  assert.equal(ret.indirect, true);
  assert.equal(ret.resultLocation, 'memory');
  assert.deepEqual(ret.hiddenResultPointer, { input: 'x10', location: 'register', pointerBits: 64 });
}

// Variable-length vector returns still fail closed without the vector variant.
{
  const ret = RISCV_LP64_ABI.classifyFunctionReturn({
    functionPrototype: {
      returnType: 'vector', vectorReturn: true, returnVector: { vector: true, lmul: 1, tupleCount: 1 }, returnBits: 128,
    },
  });
  assert.equal(ret.location, 'unknown');
  assert.equal(ret.reason, 'vector-return-calling-convention-unknown');
}

// Integer registers exhausted: a large fixed vector goes by reference on the
// incoming stack, and the stack entry must be projected into stackArguments.
{
  const classified = RISCV_LP64_ABI.classifyArguments({
    callPrototype: {
      args: [
        ...Array.from({ length: 8 }, () => ({ type: 'unsigned long long', bits: 64 })),
        { type: 'fixed vector', vector: true, fixedLengthVector: true, bits: 256 },
      ],
    },
  });
  const byRef = classified.arguments[8];
  assert.equal(byRef.location, 'stack');
  assert.equal(byRef.abiClass, 'aggregate-by-reference');
  assert.equal(byRef.offset, 0);
  assert.equal(byRef.bytes, 8);
  assert.equal(byRef.hiddenIndirection, true);
  assert.equal(byRef.pointeeBits, 256);
  assert.equal(classified.stackArguments.length, 1, 'by-reference stack entry must appear in stackArguments');
  assert.equal(classified.stackArguments[0], byRef);
  assert.equal(classified.stackArgsMayContainPointers, true);
}

// Fully-stack fixed vector: an XLEN-sized vector with no registers left is a
// memory aggregate on the incoming stack, projected into stackArguments.
{
  const classified = RISCV_LP64_ABI.classifyArguments({
    callPrototype: {
      args: [
        ...Array.from({ length: 8 }, () => ({ type: 'unsigned long long', bits: 64 })),
        { type: 'fixed vector', vector: true, fixedLengthVector: true, bits: 64 },
      ],
    },
  });
  const stackArg = classified.arguments[8];
  assert.equal(stackArg.location, 'stack');
  assert.equal(stackArg.abiClass, 'aggregate-memory');
  assert.equal(stackArg.offset, 0);
  assert.equal(stackArg.bytes, 8);
  assert.equal(stackArg.aggregate, true);
  assert.equal(classified.stackArguments.length, 1);
  assert.equal(classified.stackArguments[0], stackArg);
}

// One register left: the 128-bit fixed vector splits into a register and the
// high tail on the stack; the tail must be projected into stackArguments.
{
  const classified = RISCV_LP64_ABI.classifyArguments({
    callPrototype: {
      args: [
        ...Array.from({ length: 7 }, () => ({ type: 'unsigned long long', bits: 64 })),
        { type: 'fixed vector', vector: true, fixedLengthVector: true, bits: 128 },
      ],
    },
  });
  const split = classified.arguments[7];
  assert.equal(split.location, 'register-and-stack');
  assert.equal(split.reg, 'x16');
  assert.equal(split.stackOffset, 0);
  assert.equal(split.bytes, 16);
  assert.equal(classified.stackArguments.length, 1, 'the split high tail must appear in stackArguments');
  assert.equal(classified.stackArguments[0].location, 'stack');
  assert.equal(classified.stackArguments[0].offset, 0);
  assert.equal(classified.stackArguments[0].bits, 64);
}

// The fix must hold for every standard RISC-V profile, not just lp64.
for (const abi of [RISCV_LP64_ABI, RISCV_LP64D_ABI]) {
  const classified = abi.classifyArguments({
    callPrototype: {
      args: [{ type: 'fixed vector', vector: true, fixedLengthVector: true, bits: 128 }],
    },
  });
  assert.deepEqual(classified.arguments[0].regs, ['x10', 'x11']);
}

console.log('Issue #5713 fixed-length-vector aggregate convention regressions PASS');
