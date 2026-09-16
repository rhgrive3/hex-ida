import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveABIPlugin } from '../../../js/targets/abi/index.js';

const x32 = resolveABIPlugin({
  architecture: 'x86_64',
  platform: 'unix',
  bits: 32,
  dataModel: 'ilp32',
  pointerBits: 32,
});

function classifyArgs(types) {
  const callPrototype = { args: types.map((type, index) => ({ name: `a${index}`, type })) };
  return x32.classifyArguments({ callPrototype }, { callPrototype }).arguments;
}

test('#8885 x32 keeps signed and unsigned long long arguments at 64 bits', () => {
  const args = classifyArgs(['long long', 'unsigned long long']);
  assert.deepEqual(args.map((arg) => arg.reg), ['rdi', 'rsi']);
  assert.deepEqual(args.map((arg) => arg.bits), [64, 64]);
  assert.deepEqual(args.map((arg) => arg.abiClass), ['integer', 'integer']);
});

test('#8885 x32 keeps signed and unsigned long long returns at 64 bits', () => {
  for (const returnType of ['long long', 'unsigned long long']) {
    const result = x32.classifyFunctionReturn({ returnType, returnsValue: true });
    assert.deepEqual({ reg: result.reg, bits: result.bits }, { reg: 'rax', bits: 64 }, returnType);
  }
});

test('#8885 x32 still narrows single long and pointers while fixed int64 stays 64-bit', () => {
  const args = classifyArgs(['long', 'unsigned long', 'int64']);
  assert.deepEqual(args.map((arg) => arg.bits), [32, 32, 64]);
  const pointerPrototype = { args: [{ name: 'p', type: 'void*', pointer: true }] };
  const pointer = x32.classifyArguments({ callPrototype: pointerPrototype }, { callPrototype: pointerPrototype }).arguments[0];
  assert.equal(pointer.bits, 32);
});
