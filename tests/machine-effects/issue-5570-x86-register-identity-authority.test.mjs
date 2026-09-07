import assert from 'node:assert/strict';

import { createX86DecodedInstruction } from '../../js/targets/architecture/x86_64/decoded-instruction.js';
import { x86RegisterDescriptor } from '../../js/targets/architecture/x86_64/registers.js';

const core = globalThis.HexX86Registers;
assert.ok(core, 'x86 core register contract should be installed');

// Canonical primitive strings and register-like objects retain existing lookup behavior.
assert.equal(x86RegisterDescriptor('rax')?.id, 'rax');
assert.equal(x86RegisterDescriptor('%RAX')?.id, 'rax');
assert.equal(x86RegisterDescriptor({ registerId:'rax' })?.id, 'rax');
assert.equal(x86RegisterDescriptor({ name:'RAX' })?.id, 'rax');
assert.equal(x86RegisterDescriptor({ registerId:'cr0' })?.id, 'cr0');
// High XMM/YMM views are decoder-supplementary evidence, not core physical
// state, and therefore must not be promoted by the public descriptor lookup.
assert.equal(x86RegisterDescriptor({ registerId:'xmm16' }), null);
assert.equal(x86RegisterDescriptor({ registerId:'definitely-not-a-register' }), null);
assert.equal(x86RegisterDescriptor(null), null);
assert.equal(x86RegisterDescriptor(undefined), null);

// Structured identity values must not acquire physical-register authority through String coercion.
for (const value of [
  { registerId:['rax'] },
  { registerId:['cr0'] },
  { registerId:['xmm16'] },
  { registerId:true },
  { registerId:1 },
  { registerId:Symbol('rax') },
]) {
  assert.equal(x86RegisterDescriptor(value), null);
  assert.equal(core.registerDescriptor(value), null);
}

let coercions = 0;
const hostile = {
  [Symbol.toPrimitive]() { coercions += 1; return 'dr7'; },
  toString() { coercions += 1; return 'dr7'; },
  valueOf() { coercions += 1; return 'dr7'; },
};
assert.equal(x86RegisterDescriptor({ registerId:hostile }), null);
assert.equal(core.registerDescriptor({ registerId:hostile }), null);
assert.equal(coercions, 0, 'register lookup must not invoke identity coercion hooks');

// The canonical decoded-instruction boundary must not promote malformed nested identity evidence.
assert.throws(() => createX86DecodedInstruction({
  address:0x5570n,
  length:1,
  rawBytes:Uint8Array.of(0x90),
  instructionCode:1,
  instructionFamily:'mov',
  detailStatus:'complete',
  detail:{
    operandCount:1,
    operands:[{
      type:'register',
      access:'read',
      widthBits:64,
      register:{ registerId:['rax'] },
    }],
  },
}), /x86-decoded-instruction-unknown-register/);

console.log('issue-5570 x86 register identity authority: ok');
