import test from 'node:test';
import assert from 'node:assert/strict';
import { mnemonicClass } from '../js/format.js';

test('issue 6218: classifies x86_64 control flow mnemonics as flow', () => {
  // Unconditional branches and calls
  assert.equal(mnemonicClass('jmp'), 'flow');
  assert.equal(mnemonicClass('ljmp'), 'flow');
  assert.equal(mnemonicClass('call'), 'flow');
  assert.equal(mnemonicClass('lcall'), 'flow');
  assert.equal(mnemonicClass('ret'), 'flow');
  assert.equal(mnemonicClass('retf'), 'flow');
  assert.equal(mnemonicClass('syscall'), 'flow');

  // Conditional branches (Jcc)
  const jcc = [
    'je', 'jne', 'jz', 'jnz', 'ja', 'jae', 'jb', 'jbe',
    'jg', 'jge', 'jl', 'jle', 'jo', 'jno', 'js', 'jns',
    'jp', 'jnp', 'jcxz', 'jecxz', 'jrcxz',
  ];
  for (const mn of jcc) {
    assert.equal(mnemonicClass(mn), 'flow', `mnemonic ${mn} should be classified as flow`);
  }

  // Loop mnemonics
  assert.equal(mnemonicClass('loop'), 'flow');
  assert.equal(mnemonicClass('loope'), 'flow');
  assert.equal(mnemonicClass('loopne'), 'flow');
});

test('issue 6218: preserves existing ARM64 control flow classification', () => {
  const armFlow = [
    'b', 'bl', 'blr', 'br', 'ret', 'cbz', 'cbnz', 'tbz', 'tbnz',
    'b.eq', 'b.ne', 'b.gt', 'b.lt', 'b.ge', 'b.le', 'b.cs', 'b.cc',
    'svc', 'brk', 'hlt', 'eret', 'bti',
  ];
  for (const mn of armFlow) {
    assert.equal(mnemonicClass(mn), 'flow', `ARM64 mnemonic ${mn} should be classified as flow`);
  }
});

test('issue 6218: non-flow and data instructions are not classified as flow', () => {
  const nonFlow = ['mov', 'add', 'sub', 'xor', 'lea', 'cmp', 'test', 'nop', 'push', 'pop'];
  for (const mn of nonFlow) {
    assert.equal(mnemonicClass(mn), '', `instruction ${mn} should not be classified as flow`);
  }
  assert.equal(mnemonicClass('.byte'), 'data');
  assert.equal(mnemonicClass(''), '');
  assert.equal(mnemonicClass(null), '');
  assert.equal(mnemonicClass(undefined), '');
});
