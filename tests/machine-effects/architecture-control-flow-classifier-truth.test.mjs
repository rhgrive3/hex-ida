import assert from 'node:assert/strict';

import { partitionDecodedFunction } from '../../js/analysis/semantic-function.js';
import {
  ARM64_ARCHITECTURE,
  ARM64E_ARCHITECTURE,
  X86_64_ARCHITECTURE,
} from '../../js/targets/architecture/index.js';
import { createX86DecodedInstruction } from '../../js/targets/architecture/x86_64/decoded-instruction.js';

const classifyArm64 = (mnemonic) => ARM64_ARCHITECTURE.classifyControlFlow({ mnemonic });
const classifyX86 = (instructionFamily) => X86_64_ARCHITECTURE.classifyControlFlow({ instructionFamily });

// Keep the top-level block classifier aligned with canonical ISA/MachineEffects
// control semantics. A non-fallthrough instruction classified as fallthrough can
// make downstream block construction invent an impossible sequential successor.
for (const family of ['ud2', 'ud0', 'ud1', 'int3', 'int1', 'int']) {
  assert.equal(classifyX86(family), 'unknown', `${family}: trap must terminate fallthrough`);
}

for (const family of ['syscall', 'sysret', 'sysretq']) {
  assert.equal(classifyX86(family), 'branch', `${family}: indirect system transfer must terminate fallthrough`);
}

for (const family of ['iret', 'iretd', 'iretq', 'ljmp', 'sysenter', 'sysexit', 'sysexitq']) {
  assert.equal(classifyX86(family), 'unknown', `${family}: system transfer must fail closed instead of falling through`);
}

assert.equal(classifyX86('mov'), 'fallthrough', 'ordinary x86 instructions retain fallthrough');
assert.equal(classifyX86('je'), 'conditional-branch', 'ordinary x86 Jcc remains conditional');

assert.equal(classifyArm64('hlt'), 'unknown', 'HLT is a trap and must not expose a sequential successor');
for (const mnemonic of ['eret', 'eretaa', 'eretab']) {
  assert.equal(classifyArm64(mnemonic), 'unknown', `${mnemonic}: exception return must terminate fallthrough`);
  assert.equal(ARM64E_ARCHITECTURE.classifyControlFlow({ mnemonic }), 'unknown', `${mnemonic}: arm64e classifier must terminate fallthrough`);
}
for (const mnemonic of ['b.al', 'b.nv', 'B.AL', 'B.NV']) {
  assert.equal(classifyArm64(mnemonic), 'branch', `${mnemonic}: always-true A64 condition is unconditional`);
}
assert.equal(classifyArm64('b.eq'), 'conditional-branch', 'ordinary A64 B.cond remains conditional');
assert.equal(classifyArm64('mov'), 'fallthrough', 'ordinary A64 instructions retain fallthrough');

function assertNoSequentialSuccessor(architecture, instruction, nextInstruction, label) {
  const blocks = partitionDecodedFunction([instruction, nextInstruction], architecture);
  assert.equal(blocks.length, 2, `${label}: non-fallthrough instruction must terminate its block`);
  assert.equal(blocks[0].instructions.length, 1, `${label}: first block must end at the control transfer`);
  assert.deepEqual(blocks[0].successors, [], `${label}: must not synthesize a normal sequential CFG edge`);
  assert.equal(blocks[1].startAddress, BigInt(nextInstruction.address), `${label}: following instruction starts a distinct block`);
}

function x86Decoded(family, bytes, address) {
  return createX86DecodedInstruction({
    instructionId:`architecture-control-flow-truth:x86:${family}:${address.toString(16)}`,
    instructionCode:1,
    instructionFamily:family,
    mnemonic:family,
    address,
    length:bytes.length,
    rawBytes:Uint8Array.from(bytes),
    mode:'long-64',
    detailAvailable:true,
    detailStatus:'complete',
    detail:{
      operandCount:0,
      operands:[],
      prefixes:{ legacy:[], rex:null, vector:null },
      implicitReads:[],
      implicitWrites:[],
      addressSizeBits:64,
    },
  });
}

// Cross-owner regression for #892: use the same decoded instruction through the
// classifier, canonical MachineEffects owner, and semantic-function CFG consumer.
const ud2 = x86Decoded('ud2', [0x0f, 0x0b], 0x1000n);
assert.equal(X86_64_ARCHITECTURE.liftExact(ud2).controlEffect.kind, 'trap', 'UD2 MachineEffects truth is trap');
assert.equal(X86_64_ARCHITECTURE.classifyControlFlow(ud2), 'unknown', 'UD2 classifier must conservatively terminate');
assertNoSequentialSuccessor(
  X86_64_ARCHITECTURE,
  ud2,
  { instructionFamily:'mov', mnemonic:'mov', address:0x1002n, length:1 },
  'x86:ud2',
);

const syscall = x86Decoded('syscall', [0x0f, 0x05], 0x1100n);
assert.equal(X86_64_ARCHITECTURE.liftExact(syscall).controlEffect.kind, 'indirect', 'SYSCALL MachineEffects truth is indirect transfer');
assert.equal(X86_64_ARCHITECTURE.classifyControlFlow(syscall), 'branch', 'SYSCALL classifier must terminate without a direct target');
assertNoSequentialSuccessor(
  X86_64_ARCHITECTURE,
  syscall,
  { instructionFamily:'mov', mnemonic:'mov', address:0x1102n, length:1 },
  'x86:syscall',
);

const hlt = {
  mnemonic:'hlt',
  address:0x2000n,
  length:4,
  instructionId:'architecture-control-flow-truth:arm64:hlt:2000',
  ops:[{ k:'imm', value:0n, text:'#0' }],
  origin:{ instructionIds:['architecture-control-flow-truth:arm64:hlt:2000'] },
};
assert.equal(ARM64_ARCHITECTURE.liftExact(hlt).controlEffect.kind, 'trap', 'A64 HLT MachineEffects truth is trap');
assert.equal(ARM64_ARCHITECTURE.classifyControlFlow(hlt), 'unknown', 'A64 HLT classifier must conservatively terminate');
assertNoSequentialSuccessor(
  ARM64_ARCHITECTURE,
  hlt,
  { mnemonic:'mov', address:0x2004n, length:4 },
  'arm64:hlt',
);

console.log('architecture control-flow classifier truth: PASS');
