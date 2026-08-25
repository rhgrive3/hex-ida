import assert from 'node:assert/strict';

import { createRegisterValue } from '../../../js/semantics/effects/index.js';
import { createPhysicalStateVariable } from '../../../js/semantics/ir/normalize-effects.js';
import {
  X86_MODELED_FLAGS,
  X86_PHYSICAL_REGISTERS,
  X86_PHYSICAL_STATE_CONTRACT_VERSION,
  X86_REGISTER_DESCRIPTORS,
  normalizeX86RegisterName,
  x86RegisterDescriptor,
  x86RegisterFile,
} from '../../../js/targets/architecture/x86_64/registers.js';

assert.equal(X86_PHYSICAL_STATE_CONTRACT_VERSION, 'x86-physical-state/v2');
assert.equal(normalizeX86RegisterName('  %EAX '), 'eax');
assert.equal(x86RegisterDescriptor({ registerId:'%R9D' }).id, 'r9d');
assert.equal(x86RegisterDescriptor('not-a-register'), null);

function descriptor(name, expected) {
  const actual = x86RegisterDescriptor(name);
  assert.ok(actual, `${name} must have a canonical register-view descriptor`);
  assert.deepEqual(actual, { id:name, ...expected });
  assert.equal(Object.isFrozen(actual), true, `${name} descriptor must be immutable`);
  return actual;
}

for (const [full,dword,word,low,high] of [
  ['rax','eax','ax','al','ah'],
  ['rbx','ebx','bx','bl','bh'],
  ['rcx','ecx','cx','cl','ch'],
  ['rdx','edx','dx','dl','dh'],
]) {
  descriptor(full, { physicalId:full, physicalBits:64, viewBits:64, lsb:0, writePolicy:'replace', kind:'gp' });
  descriptor(dword, { physicalId:full, physicalBits:64, viewBits:32, lsb:0, writePolicy:'zero-extend-32', kind:'gp' });
  descriptor(word, { physicalId:full, physicalBits:64, viewBits:16, lsb:0, writePolicy:'preserve-unaffected', kind:'gp' });
  descriptor(low, { physicalId:full, physicalBits:64, viewBits:8, lsb:0, writePolicy:'preserve-unaffected', kind:'gp' });
  descriptor(high, { physicalId:full, physicalBits:64, viewBits:8, lsb:8, writePolicy:'preserve-unaffected', kind:'gp' });
}

for (const [full,dword,word,low,kind] of [
  ['rsi','esi','si','sil','gp'],
  ['rdi','edi','di','dil','gp'],
  ['rbp','ebp','bp','bpl','gp'],
  ['rsp','esp','sp','spl','stack-pointer'],
]) {
  descriptor(full, { physicalId:full, physicalBits:64, viewBits:64, lsb:0, writePolicy:'replace', kind });
  descriptor(dword, { physicalId:full, physicalBits:64, viewBits:32, lsb:0, writePolicy:'zero-extend-32', kind });
  descriptor(word, { physicalId:full, physicalBits:64, viewBits:16, lsb:0, writePolicy:'preserve-unaffected', kind });
  descriptor(low, { physicalId:full, physicalBits:64, viewBits:8, lsb:0, writePolicy:'preserve-unaffected', kind });
}

for (let index = 8; index <= 15; index++) {
  const full = `r${index}`;
  descriptor(full, { physicalId:full, physicalBits:64, viewBits:64, lsb:0, writePolicy:'replace', kind:'gp' });
  descriptor(`${full}d`, { physicalId:full, physicalBits:64, viewBits:32, lsb:0, writePolicy:'zero-extend-32', kind:'gp' });
  descriptor(`${full}w`, { physicalId:full, physicalBits:64, viewBits:16, lsb:0, writePolicy:'preserve-unaffected', kind:'gp' });
  descriptor(`${full}b`, { physicalId:full, physicalBits:64, viewBits:8, lsb:0, writePolicy:'preserve-unaffected', kind:'gp' });
}

descriptor('rip', { physicalId:'rip', physicalBits:64, viewBits:64, lsb:0, writePolicy:'replace', kind:'program-counter' });
descriptor('eip', { physicalId:'rip', physicalBits:64, viewBits:32, lsb:0, writePolicy:'zero-extend-32', kind:'program-counter' });
descriptor('ip', { physicalId:'rip', physicalBits:64, viewBits:16, lsb:0, writePolicy:'preserve-unaffected', kind:'program-counter' });

descriptor('rflags', { physicalId:'rflags', physicalBits:64, viewBits:64, lsb:0, writePolicy:'replace', kind:'flags' });
descriptor('eflags', { physicalId:'rflags', physicalBits:64, viewBits:32, lsb:0, writePolicy:'preserve-unaffected', kind:'flags' });
descriptor('flags', { physicalId:'rflags', physicalBits:64, viewBits:16, lsb:0, writePolicy:'preserve-unaffected', kind:'flags' });
assert.deepEqual([...X86_MODELED_FLAGS], ['CF','PF','AF','ZF','SF','OF','DF']);
assert.equal(Object.isFrozen(X86_MODELED_FLAGS), true);

descriptor('mxcsr', { physicalId:'mxcsr', physicalBits:32, viewBits:32, lsb:0, writePolicy:'replace', kind:'fp-environment' });

for (let index = 0; index < 32; index++) {
  const zmm = x86RegisterDescriptor(`zmm${index}`);
  assert.ok(zmm, `zmm${index} must have a composite descriptor`);
  assert.equal(zmm.viewBits, 512);
  assert.equal(zmm.kind, 'vector');
  assert.deepEqual(zmm.compositeParts, [
    { physicalId:`ymm${index}`, bits:256, lsb:0 },
    { physicalId:`zmmh${index}`, bits:256, lsb:256 },
  ]);
  const physicalId = `ymm${index}`;
  const extended = index >= 16 ? { evexOnly:true, modeled:true } : {};
  const xmm = descriptor(`xmm${index}`, {
    physicalId,
    physicalBits:256,
    viewBits:128,
    lsb:0,
    writePolicy:'encoding-dependent-upper-lanes',
    kind:'vector',
    ...extended,
  });
  const ymm = descriptor(physicalId, {
    physicalId,
    physicalBits:256,
    viewBits:256,
    lsb:0,
    writePolicy:'replace',
    kind:'vector',
    ...extended,
  });
  assert.equal(xmm.physicalId, ymm.physicalId, `xmm${index}/ymm${index} must share physical identity`);
}

for (let index = 0; index < 8; index++) {
  descriptor(`k${index}`, { physicalId:`k${index}`, physicalBits:64, viewBits:64, lsb:0, writePolicy:'replace', kind:'opmask' });
  descriptor(`mm${index}`, { physicalId:'x87-stack', physicalBits:640, viewBits:64, lsb:index * 80, writePolicy:'preserve-unaffected', kind:'mmx' });
  const st = x86RegisterDescriptor(`st(${index})`);
  assert.ok(st);
  assert.equal(st.physicalId, 'x87-stack');
  assert.equal(st.viewBits, 80);
  assert.equal(st.writePolicy, 'x87-top-relative');
  assert.deepEqual(st.dynamicView, {
    kind:'x87-top-relative', logicalIndex:index, topRegister:'fpsw', topLsb:11, topBits:3, slotWidthBits:80, slotCount:8,
  });
}
for (const [name,bits,kind] of [
  ['fpcw',16,'x87-control'], ['fpsw',16,'x87-status'], ['fptw',16,'x87-tag'], ['fop',16,'x87-opcode'],
  ['fip',64,'x87-pointer'], ['fdp',64,'x87-pointer'],
]) descriptor(name, { physicalId:name, physicalBits:bits, viewBits:bits, lsb:0, writePolicy:'replace', kind });

// The target converts every fixed view to its physicalId before generic SSA. Width
// and spelling stay access metadata and cannot create a second SSA cell.
for (const [leftName,rightName] of [
  ['rax','eax'], ['rax','ax'], ['rax','al'], ['rax','ah'],
  ['rsp','esp'], ['r8','r8d'], ['rip','eip'], ['rflags','eflags'],
  ['xmm0','ymm0'], ['xmm15','ymm15'], ['xmm16','ymm16'], ['xmm31','ymm31'],
]) {
  const left = x86RegisterDescriptor(leftName);
  const right = x86RegisterDescriptor(rightName);
  const leftState = createPhysicalStateVariable(createRegisterValue(left.physicalId, left.physicalBits, { view:left.id }));
  const rightState = createPhysicalStateVariable(createRegisterValue(right.physicalId, right.physicalBits, { view:right.id }));
  assert.equal(leftState.key, rightState.key, `${leftName}/${rightName} must become one generic SSA physical variable`);
  assert.deepEqual(leftState.physicalIdentity, rightState.physicalIdentity);
}

const physicalFile = x86RegisterFile();
assert.notEqual(physicalFile, X86_PHYSICAL_REGISTERS, 'registerFile must return a defensive array');
assert.equal(Object.isFrozen(physicalFile), true);
assert.equal(new Set(physicalFile.map((entry) => entry.id)).size, physicalFile.length);
assert.equal(physicalFile.some((entry) => entry.id.startsWith('xmm')), false,
  'XMM spelling must not become a second physical vector cell');
assert.equal(physicalFile.filter((entry) => entry.id.startsWith('ymm')).length, 32);
assert.equal(physicalFile.filter((entry) => entry.id.startsWith('zmmh')).length, 32);
assert.equal(physicalFile.filter((entry) => /^k[0-7]$/.test(entry.id)).length, 8);
assert.equal(physicalFile.filter((entry) => entry.id === 'x87-stack').length, 1);
assert.equal(physicalFile.filter((entry) => entry.id === 'mxcsr').length, 1);
assert.equal(X86_REGISTER_DESCRIPTORS.length, 178);
assert.equal(X86_PHYSICAL_REGISTERS.length, 98);
assert.equal(Object.isFrozen(X86_REGISTER_DESCRIPTORS), true);
assert.equal(Object.isFrozen(X86_PHYSICAL_REGISTERS), true);

console.log('phase5 x86 physical register-state contract passed');
