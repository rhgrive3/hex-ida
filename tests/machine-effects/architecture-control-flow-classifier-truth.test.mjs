import assert from 'node:assert/strict';

import { ARM64_ARCHITECTURE, X86_64_ARCHITECTURE } from '../../js/targets/architecture/index.js';

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
for (const mnemonic of ['b.al', 'b.nv', 'B.AL', 'B.NV']) {
  assert.equal(classifyArm64(mnemonic), 'branch', `${mnemonic}: always-true A64 condition is unconditional`);
}
assert.equal(classifyArm64('b.eq'), 'conditional-branch', 'ordinary A64 B.cond remains conditional');
assert.equal(classifyArm64('mov'), 'fallthrough', 'ordinary A64 instructions retain fallthrough');

console.log('architecture control-flow classifier truth: PASS');
