import assert from 'node:assert/strict';
import test from 'node:test';
import { RISCV_LP64_ABI, RISCV_LP64F_ABI, RISCV_LP64D_ABI } from '../../../js/targets/abi/riscv-lp64.js';

const profiles = [RISCV_LP64_ABI, RISCV_LP64F_ABI, RISCV_LP64D_ABI];
test('hard-float entry uses the same eight argument registers as call placement', () => {
  for (const [abi, type, bits] of [[RISCV_LP64F_ABI, 'float', 32], [RISCV_LP64D_ABI, 'double', 64]]) {
    const call = abi.classifyArguments({ callPrototype: { args: Array.from({ length: 8 }, () => ({ type, bits })) } });
    for (let index = 0; index < 8; index++) {
      const reg = `f${10 + index}`;
      assert.deepEqual(abi.classifyEntryRegister(reg), { kind: 'argument', reg, abiName: `fa${index}`, index, abiClass: 'float' });
      assert.equal(call.arguments[index].reg, reg);
      assert.equal(call.arguments[index].abiClass, 'float');
    }
    for (const reg of ['f9', 'f18']) assert.equal(abi.classifyEntryRegister(reg).kind, 'incoming-register-state');
  }
});
test('soft-float and integer entry classifications are preserved', () => {
  for (let index = 0; index < 8; index++) {
    assert.equal(RISCV_LP64_ABI.classifyEntryRegister(`f${10 + index}`).kind, 'incoming-register-state');
    for (const abi of profiles) {
      const reg = `x${10 + index}`;
      assert.deepEqual(abi.classifyEntryRegister(reg), { kind: 'argument', reg, abiName: `a${index}`, index, abiClass: 'integer' });
    }
  }
});
test('types wider than ABI_FLEN still follow integer call placement', () => {
  const result = RISCV_LP64F_ABI.classifyArguments({ callPrototype: { args: [{ type: 'double', bits: 64 }] } });
  assert.equal(result.arguments[0].reg, 'x10');
  assert.equal(result.arguments[0].abiClass, 'float-in-integer-register');
  assert.equal(RISCV_LP64F_ABI.classifyEntryRegister(result.arguments[0].reg).abiClass, 'integer');
});
