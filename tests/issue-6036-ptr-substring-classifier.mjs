import test from 'node:test';
import assert from 'node:assert/strict';
import { parameterClass as msftParameterClass, classifyMicrosoftX64Arguments } from '../js/targets/abi/microsoft-x64.js';
import { classifySysVAMD64Arguments } from '../js/targets/abi/sysv-amd64.js';
import { classifyAAPCS64Arguments } from '../js/targets/abi/aapcs64-core.js';
import { classifyDarwinArm64Arguments } from '../js/targets/abi/darwin-arm64.js';
import { RISCV_LP64_ABI } from '../js/targets/abi/riscv-lp64.js';

test('6036: uintptr_t/intptr_t/ptrdiff_t are integers in parameterClass', () => {
  for (const type of ['uintptr_t', 'intptr_t', 'ptrdiff_t']) {
    const classified = msftParameterClass({ type });
    assert.equal(classified.pointer, false, `${type} must not be a pointer`);
  }
});

test('6036: genuine pointer spellings still classify', () => {
  assert.equal(msftParameterClass({ type: 'int *' }).pointer, true);
  assert.equal(msftParameterClass({ type: 'void *' }).pointer, true);
  assert.equal(msftParameterClass({ pointer: true, type: 'uintptr_t' }).pointer, true);
});

test('6036: fifth stack argument does not poison pointer tracking', () => {
  const ints = Array.from({ length: 4 }, () => ({ type: 'int64_t' }));
  const result = classifyMicrosoftX64Arguments({ callPrototype: { args: [...ints, { type: 'uintptr_t' }] } });
  assert.equal(result.arguments[4].pointer ?? false, false);
  assert.equal(result.stackArgsMayContainPointers, false);
});

test('6036: sysv/aapcs64/darwin/riscv agree on integer typedefs', () => {
  const sysv = classifySysVAMD64Arguments({ callPrototype: { args: [{ type: 'uintptr_t' }] } });
  assert.equal(sysv.arguments[0].pointer ?? false, false);
  const aapcs = classifyAAPCS64Arguments({ callPrototype: { args: [{ type: 'intptr_t' }] } });
  assert.equal(aapcs.arguments[0].pointer ?? false, false);
  const darwin = classifyDarwinArm64Arguments({ callPrototype: { args: [{ type: 'ptrdiff_t' }] } });
  assert.equal(darwin.arguments[0].pointer ?? false, false);
  const riscv = RISCV_LP64_ABI.classifyArguments({ callPrototype: { args: [{ type: 'uintptr_t' }] } });
  assert.equal(riscv.arguments[0].pointer ?? false, false);
});
