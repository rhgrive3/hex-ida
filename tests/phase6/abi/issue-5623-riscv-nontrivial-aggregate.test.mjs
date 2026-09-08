import assert from 'node:assert/strict';
import { RISCV_LP64_ABI, RISCV_LP64F_ABI, RISCV_LP64D_ABI } from '../../../js/targets/abi/riscv-lp64.js';

// Issue #5623: the RISC-V LP64 aggregate classifier applied only size/layout
// rules and ignored C++ call-triviality evidence. The psABI requires
// aggregates with nontrivial copy constructors, destructors, or vtables to be
// passed by reference regardless of size, in arguments and returns.

const layout8 = { bits: 64, bytes: 8, members: [{ name: 'x', bits: 64, bytes: 8, byteOffset: 0 }] };
const layout16 = { bits: 128, bytes: 16, members: [{ bits: 64, bytes: 8, byteOffset: 0 }, { bits: 64, bytes: 8, byteOffset: 8 }] };

function argumentOf(abi, parameter) {
  return abi.classifyArguments({ callPrototype: { args: [parameter] } }).arguments[0];
}

// 1. 8-byte trivial C struct -> direct a0 payload (control).
{
  const arg = argumentOf(RISCV_LP64_ABI, {
    type: 'S', aggregate: true, bits: 64,
    trivialForCalls: true,
    layout: layout8,
  });
  assert.equal(arg.location, 'registers');
  assert.equal(arg.regs[0], 'x10');
  assert.equal(arg.abiClass, 'aggregate-integer-registers');
  assert.equal(arg.pointer, undefined, 'trivial aggregate keeps value passing');
  assert.equal(arg.mustUse, true);
  assert.equal(arg.exact, true);
}

// 2. 8-byte nontrivial-copy C++ class -> pointer in a0.
{
  const arg = argumentOf(RISCV_LP64_ABI, {
    type: 'C', aggregate: true, bits: 64, nonTrivialForCalls: true, layout: layout8,
  });
  assert.equal(arg.location, 'register');
  assert.equal(arg.reg, 'x10');
  assert.equal(arg.abiClass, 'aggregate-by-reference');
  assert.equal(arg.pointer, true);
  assert.equal(arg.hiddenIndirection, true);
  assert.equal(arg.mustUse, true);
  assert.equal(arg.exact, true);
}

// 3. 16-byte nontrivial destructor -> pointer only, never a0+a1 payload.
{
  const arg = argumentOf(RISCV_LP64_ABI, {
    type: 'D', aggregate: true, bits: 128, nonTrivial: true, layout: layout16,
  });
  assert.equal(arg.location, 'register');
  assert.equal(arg.reg, 'x10');
  assert.equal(arg.abiClass, 'aggregate-by-reference');
  assert.equal(arg.pointer, true);
  assert.equal(arg.regs, undefined, 'the payload pair must not be published');
}

// 4. The legacy `nonTrivial` alias is accepted; ambiguity resolves sound.
{
  const both = argumentOf(RISCV_LP64_ABI, {
    type: 'B', aggregate: true, bits: 64,
    nonTrivialForCalls: true, trivialForCalls: true, layout: layout8,
  });
  assert.equal(both.abiClass, 'aggregate-by-reference', 'conflicting triviality resolves to the sound direction');
}

// 5. >16-byte trivial aggregate keeps the existing by-reference rule.
{
  const arg = argumentOf(RISCV_LP64_ABI, {
    type: 'Big', aggregate: true, bits: 192, trivialForCalls: true,
    layout: { bits: 192, bytes: 24, members: layout16.members.concat([{ bits: 64, bytes: 8, byteOffset: 16 }]) },
  });
  assert.equal(arg.abiClass, 'aggregate-by-reference');
  assert.equal(arg.pointer, true);
}

// 6. Absent triviality metadata keeps the documented C-aggregate behavior
// (no invented triviality in either direction).
{
  const arg = argumentOf(RISCV_LP64_ABI, { type: 'S', aggregate: true, bits: 64, layout: layout8 });
  assert.equal(arg.abiClass, 'aggregate-integer-registers');
  assert.equal(arg.exact, true);
}

// 7. Return of the same nontrivial class -> indirect result memory with an
// implicit a0 pointer, on every LP64 profile.
for (const [label, abi] of [['lp64', RISCV_LP64_ABI], ['lp64f', RISCV_LP64F_ABI], ['lp64d', RISCV_LP64D_ABI]]) {
  const ret = abi.classifyFunctionReturn({
    functionPrototype: {
      returnType: 'C', aggregate: true, returnBits: 64, nonTrivialForCalls: true, returnsValue: true,
      layout: layout8,
    },
  });
  assert.equal(ret.indirect, true, `${label} nontrivial return is indirect`);
  assert.equal(ret.resultLocation, 'memory');
  assert.equal(ret.hiddenResultPointer?.input, 'x10', `${label} implicit a0 result pointer`);
  assert.equal(ret.reg, null);

  const retAlias = abi.classifyFunctionReturn({
    functionPrototype: {
      returnType: 'C', aggregate: true, returnBits: 64, returnNonTrivialForCalls: true, returnsValue: true,
      layout: layout8,
    },
  });
  assert.equal(retAlias.indirect, true, `${label} return-side alias is honored`);
}

// 8. The same C++ base rule is shared by all three profiles (arguments).
for (const [label, abi] of [['lp64', RISCV_LP64_ABI], ['lp64f', RISCV_LP64F_ABI], ['lp64d', RISCV_LP64D_ABI]]) {
  const arg = argumentOf(abi, { type: 'C', aggregate: true, bits: 64, nonTrivialForCalls: true, layout: layout8 });
  assert.equal(arg.abiClass, 'aggregate-by-reference', `${label} shares the nontrivial by-reference rule`);
  assert.equal(arg.reg, 'x10');
}

// 9. Nontrivial beats hard-float FP flattening: an FP-member leaf class with
// nontrivial semantics goes by reference, not into fa0/fa1.
{
  const fpLayout = {
    bits: 128, bytes: 16,
    members: [
      { name: 'f', bits: 32, bytes: 4, byteOffset: 0, floating: true },
      { name: 'g', bits: 32, bytes: 4, byteOffset: 8, floating: true },
    ],
  };
  const arg = argumentOf(RISCV_LP64D_ABI, {
    type: 'V', aggregate: true, bits: 128, nonTrivialForCalls: true, layout: fpLayout,
  });
  assert.equal(arg.abiClass, 'aggregate-by-reference', 'nontrivial preempts FP flattening');
  assert.equal(arg.pointer, true);
  assert.equal(String(arg.reg).startsWith('f'), false, 'no FP register is consumed for a nontrivial aggregate');
}

// 10. Nontrivial with an unproven layout still goes by reference (the rule
// does not depend on layout evidence), and without a register the stack
// fallback carries the pointer.
{
  const arg = argumentOf(RISCV_LP64_ABI, { type: 'C', aggregate: true, bits: 64, nonTrivialForCalls: true });
  assert.equal(arg.abiClass, 'aggregate-by-reference');
  assert.equal(arg.pointer, true);
  assert.equal(arg.exact, true);
}

// 11. A nontrivial return remains indirect even without layout evidence.
{
  const ret = RISCV_LP64_ABI.classifyFunctionReturn({
    functionPrototype: { type: 'C', returnType: 'C', aggregate: true, nonTrivialForCalls: true, returnsValue: true },
  });
  assert.equal(ret.indirect, true, 'nontrivial return does not require layout proof');
  assert.equal(ret.resultLocation, 'memory');
  assert.equal(ret.hiddenResultPointer?.input, 'x10');
}

console.log('issue #5623 riscv nontrivial C++ aggregate by-reference regression: PASS');
