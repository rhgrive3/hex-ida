import assert from 'node:assert/strict';
import { mnemonicClass } from '../js/format.js';

// --- Test 1: #6218 x86_64 control flow mnemonics ---
{
  assert.equal(mnemonicClass('jmp'), 'flow');
  assert.equal(mnemonicClass('JMP'), 'flow');
  assert.equal(mnemonicClass('call'), 'flow');
  assert.equal(mnemonicClass('CALL'), 'flow');
  assert.equal(mnemonicClass('ret'), 'flow');
  assert.equal(mnemonicClass('retn'), 'flow');
  assert.equal(mnemonicClass('retf'), 'flow');

  const jcc = ['je', 'jne', 'jz', 'jnz', 'ja', 'jae', 'jb', 'jbe', 'jg', 'jge', 'jl', 'jle', 'jo', 'jno', 'js', 'jns', 'jp', 'jnp', 'jcxz', 'jecxz', 'jrcxz'];
  for (const mn of jcc) {
    assert.equal(mnemonicClass(mn), 'flow', `mnemonicClass('${mn}') must be 'flow'`);
    assert.equal(mnemonicClass(mn.toUpperCase()), 'flow', `mnemonicClass('${mn.toUpperCase()}') must be 'flow'`);
  }

  // Non-flow x86 mnemonics
  const nonFlow = ['mov', 'add', 'sub', 'xor', 'and', 'lea', 'nop', 'push', 'pop', 'test', 'cmp'];
  for (const mn of nonFlow) {
    assert.equal(mnemonicClass(mn), '', `mnemonicClass('${mn}') must be empty`);
  }
  console.log('✔ #6218 x86_64 control-flow classification passed');
}

// --- Test 2: #6161 ARM64e authenticated branch/exception-return mnemonics ---
{
  const pauth = ['braa', 'brab', 'braaz', 'brabz', 'blraa', 'blrab', 'blraaz', 'blrabz', 'retaa', 'retab', 'eret', 'eretaa', 'eretab'];
  for (const mn of pauth) {
    assert.equal(mnemonicClass(mn), 'flow', `mnemonicClass('${mn}') must be 'flow'`);
    assert.equal(mnemonicClass(mn.toUpperCase()), 'flow', `mnemonicClass('${mn.toUpperCase()}') must be 'flow'`);
  }

  // Classic ARM64 branch mnemonics
  const armClassic = ['b', 'bl', 'blr', 'br', 'cbz', 'cbnz', 'tbz', 'tbnz', 'b.eq', 'b.ne', 'b.gt', 'b.lt', 'svc', 'brk', 'hlt', 'bti'];
  for (const mn of armClassic) {
    assert.equal(mnemonicClass(mn), 'flow', `mnemonicClass('${mn}') must be 'flow'`);
  }

  // Non-flow ARM mnemonics
  const armNonFlow = ['mov', 'add', 'ldr', 'str', 'stp', 'ldp', 'adrp', 'csel'];
  for (const mn of armNonFlow) {
    assert.equal(mnemonicClass(mn), '', `mnemonicClass('${mn}') must be empty`);
  }
  console.log('✔ #6161 ARM64e authenticated branch aliases passed');
}

// --- Test 3: Edge cases ---
{
  assert.equal(mnemonicClass(null), '');
  assert.equal(mnemonicClass(undefined), '');
  assert.equal(mnemonicClass(''), '');
  assert.equal(mnemonicClass('.byte'), 'data');
  console.log('✔ Edge cases passed');
}

console.log('\nAll format mnemonic-class tests PASSED!');
