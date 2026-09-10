import assert from 'node:assert/strict';
import { RISCV_LP64_ABI, RISCV_LP64F_ABI, RISCV_LP64D_ABI } from '../../../js/targets/abi/riscv-lp64.js';

// Issue #5713: the RISC-V LP64 argument/return classifiers degraded every
// vector-typed parameter to `vector-calling-convention-unknown` whenever the
// call did not select `riscv_vector_cc`, even for *fixed-length* vectors.
// The psABI base integer calling convention states: "Fixed-length vectors
// are treated as aggregates." A fixed-length vector under the standard
// convention therefore follows the aggregate size rules (a0-a7 / stack /
// by-reference; returns a0/a1 or the hidden memory result pointer), while
// scalable RVV vectors still require the vector calling convention variant.

const fixedVector = (bits) => ({ type:'fixed vector', vector:true, fixedLengthVector:true, bits });
const int = { type:'int' };

// 1. 64-bit fixed-length vector first argument -> one a-register (a0).
{
  for (const abi of [RISCV_LP64_ABI, RISCV_LP64F_ABI, RISCV_LP64D_ABI]) {
    const arg = abi.classifyArguments({ callPrototype:{ args:[fixedVector(64)] } }).arguments[0];
    assert.equal(arg.location, 'registers', `${abi.id}: 64-bit fixed vector is an integer-convention aggregate`);
    assert.deepEqual(arg.regs, ['x10'], `${abi.id}: 64-bit fixed vector occupies a0`);
    assert.equal(arg.exact, true, `${abi.id}: placement is exact`);
    assert.equal(arg.mustUse, true);
    assert.equal(arg.abiClass, 'aggregate-integer-registers');
    assert.equal(arg.bits, 64);
  }
}

// 2. 128-bit fixed-length vector first argument -> a0+a1.
{
  for (const abi of [RISCV_LP64_ABI, RISCV_LP64F_ABI, RISCV_LP64D_ABI]) {
    const arg = abi.classifyArguments({ callPrototype:{ args:[fixedVector(128)] } }).arguments[0];
    assert.deepEqual(arg.regs, ['x10', 'x11'], `${abi.id}: 128-bit fixed vector occupies a0-a1`);
    assert.equal(arg.abiClass, 'aggregate-integer-registers');
    assert.equal(arg.bits, 128);
    assert.equal(arg.exact, true);
  }
}

// 3. One a-register remaining + 128-bit fixed vector -> register+stack split.
{
  for (const abi of [RISCV_LP64_ABI, RISCV_LP64D_ABI]) {
    const result = abi.classifyArguments({ callPrototype:{ args:[int, int, int, int, int, int, int, fixedVector(128)] } });
    const arg = result.arguments[7];
    assert.equal(arg.location, 'register-and-stack', `${abi.id}: split aggregate crosses the register boundary`);
    assert.equal(arg.reg, 'x17', `${abi.id}: low eightbyte rides a7`);
    assert.equal(arg.pieces[0].abiClass, 'aggregate-integer');
    assert.equal(arg.pieces[1].abiClass, 'aggregate-memory');
    assert.equal(arg.pieces[1].byteOffset, 8);
    assert.deepEqual(result.stackArguments.map((entry) => ({ offset:entry.offset, bits:entry.bits })),
      [{ offset:0, bits:64 }], `${abi.id}: high eightbyte lands on the stack`);
  }
}

// 4. a-registers exhausted + 128-bit fixed vector -> stack aggregate.
{
  for (const abi of [RISCV_LP64_ABI, RISCV_LP64D_ABI]) {
    const result = abi.classifyArguments({ callPrototype:{ args:[int, int, int, int, int, int, int, int, fixedVector(128)] } });
    const arg = result.arguments[8];
    assert.equal(arg.location, 'stack', `${abi.id}: no register remains, aggregate goes to the stack`);
    assert.equal(arg.offset, 0);
    assert.equal(arg.bytes, 16);
    assert.deepEqual(arg.pieces.map((piece) => piece.byteOffset), [0, 8]);
    assert.equal(result.stackArguments.length, 1);
  }
}

// 5. >2*XLEN fixed-length vector -> by-reference pointer.
{
  const arg = RISCV_LP64_ABI.classifyArguments({ callPrototype:{ args:[fixedVector(256)] } }).arguments[0];
  assert.equal(arg.location, 'register');
  assert.equal(arg.reg, 'x10');
  assert.equal(arg.abiClass, 'aggregate-by-reference');
  assert.equal(arg.pointer, true);
  assert.equal(arg.pointeeBits, 256);
  assert.equal(arg.hiddenIndirection, true);
  // Same rule on the stack when the registers are exhausted.
  const stackArg = RISCV_LP64_ABI.classifyArguments({
    callPrototype:{ args:[int, int, int, int, int, int, int, int, fixedVector(256)] },
  }).arguments[8];
  assert.equal(stackArg.location, 'stack');
  assert.equal(stackArg.abiClass, 'aggregate-by-reference');
  assert.equal(stackArg.bytes, 8);
}

// 6. Returns: <=2*XLEN fixed vector in a0/a1, larger in memory (hidden a0).
{
  const small = RISCV_LP64_ABI.classifyFunctionReturn({
    functionPrototype:{ returnType:'fixed vector', returnVector:{ vector:true, fixedLengthVector:true }, bits:128 },
  });
  assert.deepEqual(small.regs, ['x10', 'x11'], '128-bit fixed vector returns in a0-a1');
  assert.equal(small.aggregate, true);
  assert.equal(small.bits, 128);
  assert.equal(small.fixedVectorAggregate, true);
  assert.equal(small.indirect, undefined);

  const large = RISCV_LP64_ABI.classifyFunctionReturn({
    functionPrototype:{ returnType:'fixed vector', returnVector:{ vector:true, fixedLengthVector:true }, bits:256 },
  });
  assert.equal(large.indirect, true, '256-bit fixed vector returns in memory');
  assert.equal(large.hiddenResultPointer.input, 'x10');
  // The derived hidden result pointer consumes a0 for the argument list.
  const shifted = RISCV_LP64_ABI.classifyArguments({
    callPrototype:{ returnType:'fixed vector', returnVector:{ vector:true, fixedLengthVector:true }, returnBits:256, args:[int] },
  });
  assert.equal(shifted.arguments[0].role, 'indirect-result', 'hidden result pointer is derived');
  assert.equal(shifted.arguments[1].reg, 'x11', 'user argument shifts to a1');
}

// 7. Scalable RVV vector without the variant still degrades to unknown —
//    the standard convention must not fabricate a vector-register location.
{
  const arg = RISCV_LP64_ABI.classifyArguments({ callPrototype:{ args:[{ type:'vint32m1_t', vector:true, bits:128 }] } }).arguments[0];
  assert.equal(arg.location, 'unknown');
  assert.equal(arg.abiClass, 'vector-calling-convention-unknown');
  assert.equal(arg.exact, false);
  const ret = RISCV_LP64_ABI.classifyFunctionReturn({
    functionPrototype:{ returnType:'vint32m1_t', returnVector:{ vector:true }, bits:128 },
  });
  assert.equal(ret.reason, 'vector-return-calling-convention-unknown');
}

// 8. `riscv_vector_cc` keeps the vector-variant rules: scalable vectors
//    allocate vector registers, and a fixed-length vector without ABI_VLEN
//    evidence stays fail-closed partial (never integer registers).
{
  const arg = RISCV_LP64_ABI.classifyArguments({
    callPrototype:{ callingConvention:'riscv_vector_cc', args:[{ type:'vint32m1_t', vector:true, bits:128 }] },
  }).arguments[0];
  assert.equal(arg.reg, 'v8', 'variant convention still allocates vector registers');
  assert.equal(arg.abiClass, 'vector-data');
  const fixedVariant = RISCV_LP64_ABI.classifyArguments({
    callPrototype:{ callingConvention:'riscv_vector_cc', args:[fixedVector(128)] },
  }).arguments[0];
  assert.equal(fixedVariant.location, 'unknown', 'fixed-length vector under the variant needs ABI_VLEN');
  assert.equal(fixedVariant.abiClass, 'vector-register-allocation-unproven');
  assert.equal(fixedVariant.exact, false);
}

// 9. Malformed/unproven fixed-vector width never mints an exact placement.
{
  for (const parameter of [
    { type:'fixed vector', vector:true, fixedLengthVector:true },
    { type:'fixed vector', vector:true, fixedLengthVector:true, bits:0 },
    { type:'fixed vector', vector:true, fixedLengthVector:true, bits:-64 },
  ]) {
    const arg = RISCV_LP64_ABI.classifyArguments({ callPrototype:{ args:[parameter] } }).arguments[0];
    assert.equal(arg.location, 'unknown', `unproven width ${parameter.bits} stays unknown`);
    assert.equal(arg.abiClass, 'fixed-length-vector-size-unproven');
    assert.equal(arg.exact, false);
  }
  const ret = RISCV_LP64_ABI.classifyFunctionReturn({
    functionPrototype:{ returnType:'fixed vector', returnVector:{ vector:true, fixedLengthVector:true } },
  });
  assert.equal(ret.reason, 'fixed-vector-return-size-unproven');
  // Structured width evidence trips the registry's fail-closed guard.
  const structured = RISCV_LP64_ABI.classifyArguments({
    callPrototype:{ args:[{ type:'fixed vector', vector:true, fixedLengthVector:true, bits:[128] }] },
  });
  assert.equal(structured.partial, true);
  assert.equal(structured.arguments.every((arg) => arg.exact === false && arg.mustUse === false), true,
    'structured width must not mint an exact placement');
  // Conflicting descriptor evidence stays fail-closed under the standard CC.
  const conflict = RISCV_LP64_ABI.classifyArguments({
    callPrototype:{ args:[{ type:'vint32m3x2_t', vector:true, fixedLengthVector:true, bits:192 }] },
  }).arguments[0];
  assert.equal(conflict.abiClass, 'vector-descriptor-conflict');
  assert.equal(conflict.exact, false);
}
