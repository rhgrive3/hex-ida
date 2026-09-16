// Regression for #8885: canonical ABI resolution had no x86-64 ILP32 ("x32")
// profile, so an image the loader already proved ELFCLASS32 + EM_X86_64 with
// pointerBits=32/dataModel=ilp32 silently reused the LP64 `sysv-amd64` plugin
// and published 64-bit pointer/long/hidden-result ABI facts against a 32-bit
// data model. The physical AMD64 register bank is unchanged; only the logical
// widths are corrected, and the LP64 / explicit-abiId paths must stay byte-exact.
import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveABIPlugin, findABIPlugin } from '../../../js/targets/abi/index.js';

function classifyArgs(plugin, args, extra = {}) {
  const instruction = { callPrototype: { args, ...extra } };
  return plugin.classifyArguments(instruction, { callPrototype: instruction.callPrototype, ...extra });
}

const lp64 = resolveABIPlugin({ architecture: 'x86_64', platform: 'unix', bits: 64 });
const x32 = resolveABIPlugin({ architecture: 'x86_64', platform: 'unix', bits: 32, dataModel: 'ilp32', pointerBits: 32 });

test('#8885 x86-64 ILP32 resolves to a distinct registered profile, not LP64', () => {
  assert.equal(lp64.id, 'sysv-amd64');
  assert.equal(x32.id, 'sysv-amd64-ilp32');
  assert.equal(x32.supported, true);
  assert.equal(findABIPlugin({ id: 'sysv-amd64-ilp32', architecture: 'x86_64', platform: 'linux' }), x32);
});

test('#8885 an explicit abiId:"sysv-amd64" still resolves to the LP64 plugin exactly', () => {
  const explicit = resolveABIPlugin({ architecture: 'x86_64', platform: 'unix', bits: 32, dataModel: 'ilp32', abiId: 'sysv-amd64' });
  assert.equal(explicit.id, 'sysv-amd64');
});

test('#8885 pointer argument/return keeps the AMD64 carrier but reports 32-bit logical width', () => {
  const arg = classifyArgs(x32, [{ name: 'p', type: 'void*', pointer: true }]).arguments[0];
  assert.equal(arg.reg, 'rdi', 'physical carrier unchanged');
  assert.equal(arg.abiClass, 'pointer');
  assert.equal(arg.bits, 32, 'x32 pointer must not be published as 64-bit');
  const lpArg = classifyArgs(lp64, [{ name: 'p', type: 'void*', pointer: true }]).arguments[0];
  assert.equal(lpArg.bits, 64, 'LP64 pointer width unchanged');

  const ret = x32.classifyFunctionReturn({ returnType: 'void*', returnsValue: true });
  assert.deepEqual({ reg: ret.reg, bits: ret.bits }, { reg: 'rax', bits: 32 });
  assert.deepEqual(lp64.classifyFunctionReturn({ returnType: 'void*', returnsValue: true }), { reg: 'rax', bits: 64 });
});

test('#8885 C long argument/return is 32-bit under ILP32 and still 64-bit under LP64', () => {
  const wide = classifyArgs(x32, [{ name: 'a', type: 'long' }, { name: 'b', type: 'unsigned long' }]).arguments;
  assert.deepEqual(wide.map((a) => a.bits), [32, 32]);
  assert.deepEqual(wide.map((a) => a.reg), ['rdi', 'rsi']);
  assert.deepEqual(classifyArgs(lp64, [{ name: 'a', type: 'long' }]).arguments.map((a) => a.bits), [64]);
  assert.equal(x32.classifyFunctionReturn({ returnType: 'long', returnsValue: true }).bits, 32);
  assert.equal(lp64.classifyFunctionReturn({ returnType: 'long', returnsValue: true }).bits, 64);
});

test('#8885 fixed-width scalars are unaffected by the ILP32 profile', () => {
  const fixed = classifyArgs(x32, [
    { name: 'i', type: 'int' },
    { name: 'w', type: 'int64' },
    { name: 'd', type: 'double' },
  ]).arguments;
  assert.deepEqual(fixed.map((a) => a.bits), [32, 64, 64]);
});

test('#8885 the hidden structure-return pointer retains the 32-bit logical width', () => {
  const classified = classifyArgs(x32, [], { indirectResult: true, returnType: 'struct', returnClass: 'indirect' });
  const hidden = classified.arguments.find((a) => a.role === 'indirect-result');
  assert.ok(hidden, 'an indirect-result argument is present');
  assert.equal(hidden.reg, 'rdi', 'the hidden pointer still uses the AMD64 first integer register');
  assert.equal(hidden.bits, 32, 'x32 hidden result pointer must not be published as 64-bit');
  const lpHidden = classifyArgs(lp64, [], { indirectResult: true, returnType: 'struct', returnClass: 'indirect' })
    .arguments.find((a) => a.role === 'indirect-result');
  assert.equal(lpHidden.bits, 64, 'LP64 hidden pointer unchanged');
});
