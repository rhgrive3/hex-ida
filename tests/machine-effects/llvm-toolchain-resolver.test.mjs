import assert from 'node:assert/strict';

import { LLVM18_VERSION, resolveLlvmTool18 } from './helpers/llvm-toolchain.mjs';

const frozenTool = '/frozen/bin/llvm-mc-18';
const olderTool = '/system/bin/llvm-mc';
const versions = new Map([
  [frozenTool, `Ubuntu LLVM version ${LLVM18_VERSION}`],
  [olderTool, 'Ubuntu LLVM version 14.0.6'],
]);
const probe = (candidate) => ({ status:0, output:versions.get(candidate) });
const isExecutable = (candidate) => versions.has(candidate);

assert.equal(resolveLlvmTool18('llvm-mc', {
  env:{ PATH:'/frozen/bin:/system/bin' },
  isExecutable,
  probe,
}), frozenTool, 'PATH must select the supplied LLVM 18 toolchain');

assert.throws(() => resolveLlvmTool18('llvm-mc', {
  candidates:[olderTool],
  isExecutable,
  probe,
}), /exact version found/, 'an older LLVM must never be accepted as the frozen oracle');

versions.set(frozenTool, 'Ubuntu LLVM version 18.1.30');
assert.throws(() => resolveLlvmTool18('llvm-mc', {
  candidates:[frozenTool],
  isExecutable,
  probe,
}), /exact version found/, 'a nearby LLVM version must not satisfy the frozen identity');

console.log('LLVM 18 toolchain resolver: PASS');
