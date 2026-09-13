import assert from 'node:assert/strict';
import { RISCV_LP64_ABI, RISCV_LP64F_ABI, RISCV_LP64D_ABI } from '../../../js/targets/abi/riscv-lp64.js';

// Issue #6018: the RISC-V LP64 vectorDescriptor() type recognizer did not
// accept the standard RVV vector tuple spellings (`vint32m1x2_t`, LMUL x
// NFIELDS) or the vector mask spellings (`vbool<N>_t`). Under a confirmed
// `riscv_vector_cc` calling convention those arguments fell through to the
// integer convention (x10/a0) and were published as exact, must-use integer
// arguments — the wrong physical register identity propagates into def-use,
// prototype recovery, SSA, and the decompiler. Per the psABI standard vector
// calling convention variant: first mask argument -> v0, vector data/tuple
// arguments -> LMUL-aligned groups in v8..v23, tuple type consuming
// LMUL x NFIELDS registers.

const CC = 'riscv_vector_cc';

function argumentOf(abi, parameter, index = 0) {
  const result = abi.classifyArguments({ callPrototype: { callingConvention: CC, args: [parameter] } });
  return result.arguments[index];
}

function argumentsOf(abi, parameters) {
  return abi.classifyArguments({ callPrototype: { callingConvention: CC, args: parameters } }).arguments;
}

// 1. Standard vector tuple type vint32m1x2_t (LMUL=1, NFIELDS=2) -> v8,v9.
{
  for (const abi of [RISCV_LP64_ABI, RISCV_LP64F_ABI, RISCV_LP64D_ABI]) {
    const arg = argumentOf(abi, { type: 'vint32m1x2_t' });
    assert.equal(arg.location, 'registers', `${abi.id}: tuple type must take the vector path`);
    assert.deepEqual(arg.regs, ['v8', 'v9'], `${abi.id}: LMUL=1 NFIELDS=2 tuple occupies v8-v9`);
    assert.equal(arg.abiClass, 'vector-data');
    assert.equal(arg.reg, undefined, 'multi-register argument has no single reg');
    assert.equal(arg.vector.mask, false);
    assert.equal(arg.vector.lmul, 1);
    assert.equal(arg.vector.tupleCount, 2);
    assert.equal(arg.mustUse, true);
    assert.equal(arg.exact, true);
  }
}

// 2. Four-register tuple group vint32m2x2_t (LMUL=2, NFIELDS=2) -> v8..v11.
{
  const arg = argumentOf(RISCV_LP64D_ABI, { type: 'vint32m2x2_t' });
  assert.deepEqual(arg.regs, ['v8', 'v9', 'v10', 'v11']);
  assert.equal(arg.vector.lmul, 2);
  assert.equal(arg.vector.tupleCount, 2);
}

// 3. First vector mask argument vbool8_t -> v0.
{
  for (const type of ['vbool1_t', 'vbool2_t', 'vbool4_t', 'vbool8_t', 'vbool16_t', 'vbool32_t', 'vbool64_t']) {
    const arg = argumentOf(RISCV_LP64D_ABI, { type });
    assert.equal(arg.location, 'register', `${type}: mask spelling must be recognized`);
    assert.equal(arg.reg, 'v0', `${type}: first mask argument is v0`);
    assert.equal(arg.abiClass, 'vector-mask');
    assert.equal(arg.vector.mask, true);
    assert.equal(arg.exact, true);
  }
}

// 4. Later mask arguments are ordinary vector-data allocations from v8
//    (only the FIRST mask argument claims v0 — psABI / #5615 contract).
{
  const args = argumentsOf(RISCV_LP64D_ABI, [{ type: 'vbool8_t' }, { type: 'vbool16_t' }]);
  assert.equal(args[0].reg, 'v0');
  assert.equal(args[1].abiClass, 'vector-mask');
  assert.equal(args[1].regs[0], 'v8');
}

// 5. Fractional-LMUL tuple vint8mf8x2_t occupies one register per field (2).
{
  const arg = argumentOf(RISCV_LP64D_ABI, { type: 'vint8mf8x2_t' });
  assert.deepEqual(arg.regs, ['v8', 'v9']);
  assert.equal(arg.vector.lmul, 1, 'fractional tuple occupancy normalizes to 1 register per field');
  assert.equal(arg.vector.tupleCount, 2);
}

// 6. Explicit descriptor metadata agreeing with the spelling stays exact.
{
  const arg = argumentOf(RISCV_LP64D_ABI, { type: 'vint32m1x2_t', vector: true, lmul: 1, tupleCount: 2 });
  assert.deepEqual(arg.regs, ['v8', 'v9']);
  assert.equal(arg.vector.conflict, undefined);
}

// 7. Explicit metadata contradicting the spelling fails closed (no exact).
{
  const arg = argumentOf(RISCV_LP64D_ABI, { type: 'vint32m1x2_t', lmul: 2 });
  assert.equal(arg.location, 'unknown');
  assert.equal(arg.abiClass, 'vector-descriptor-conflict');
  assert.equal(arg.exact, false);
  assert.equal(arg.mustUse, false);
}

// 8. Malformed tuple suffixes must not mint ANY exact proof — neither an
//    exact vector group nor an integer-convention exact argument (#6018
//    requirement 7). Out-of-range NFIELDS (x9, x0), nonstandard LMUL
//    tuple shapes (m3x2), and tuples whose EMUL x NFIELDS product exceeds
//    the RVV 8-register bound (m8x2 = 16) all fail closed as
//    vector-descriptor-conflict.
{
  for (const type of ['vint32m1x9_t', 'vint32m1x0_t', 'vint32m3x2_t', 'vint32m9x2_t', 'vint32m8x2_t']) {
    const arg = argumentOf(RISCV_LP64D_ABI, { type });
    assert.equal(arg.location, 'unknown', `${type}: malformed tuple must not become exact`);
    assert.equal(arg.abiClass, 'vector-descriptor-conflict', `${type}: fail closed`);
    assert.equal(arg.exact, false);
    assert.equal(arg.mustUse, false);
    assert.equal(arg.reg, undefined, `${type}: no integer register identity either`);
    assert.equal(arg.x10, undefined);
  }
}

// 9. Non-vector opaque scalar type keeps the integer convention (control —
//    type-recognition failure for genuinely non-vector names must not
//    change; only standard RVV spellings route to the vector allocator).
{
  const arg = argumentOf(RISCV_LP64D_ABI, { type: 'my_scalar_t' });
  assert.equal(arg.location, 'register');
  assert.equal(arg.reg, 'x10');
  assert.equal(arg.abiName, 'a0');
  assert.equal(arg.abiClass, 'integer');
  assert.equal(arg.exact, true);
}

// 10. Plain vector data spelling keeps working (pre-#6018 behavior preserved).
{
  const arg = argumentOf(RISCV_LP64D_ABI, { type: 'vint32m1_t' });
  assert.equal(arg.reg, 'v8');
  assert.equal(arg.abiClass, 'vector-data');
  assert.equal(arg.vector.lmul, 1);
  assert.equal(arg.vector.tupleCount, 1);
  const argF = argumentOf(RISCV_LP64D_ABI, { type: 'vfloat64mf2_t' });
  assert.equal(argF.reg, 'v8');
}

console.log('issue #6018 riscv vector tuple/mask type recognition regression: PASS');
