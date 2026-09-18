import assert from 'node:assert/strict';
import test from 'node:test';

import { semanticModelForDecompiler } from '../js/decompile-base.js';

// strictTextAddress String()-coerced structured operand text into a definite
// CFG target: text:['0x2000'] became branchTarget 0x2000n exactly like the
// canonical primitive string. Target completion is authority, so only a raw
// primitive string may ground it (#5676).

const insn = (mnemonic, text, extra = {}) => ({
  row: 0,
  address: 0x1000n,
  mnemonic,
  ops: [{ k: 'other', text }],
  ...extra,
});

const model = (instruction) => ({ instructions: [instruction] });

test('#5676: a primitive string target still completes the CFG edge', () => {
  const out = semanticModelForDecompiler(model(insn('b', '0x2000')));
  assert.equal(out.instructions[0].branchTarget, 0x2000n);
  const call = semanticModelForDecompiler(model(insn('bl', '0x3000')));
  assert.equal(call.instructions[0].callTarget, 0x3000n);
});

test('#5676: every canonical numeric spelling completes the target', () => {
  const pound = semanticModelForDecompiler(model(insn('b', '#0x2000')));
  assert.equal(pound.instructions[0].branchTarget, 0x2000n, '"#" prefix stays supported');
  const decimal = semanticModelForDecompiler(model(insn('b', '8192')));
  assert.equal(decimal.instructions[0].branchTarget, 8192n, 'canonical decimal string completes branchTarget');
});

test('#5676: the issue-acceptance direct-control mnemonics all complete targets', () => {
  for (const mnemonic of ['b', 'b.eq', 'cbz', 'cbnz', 'tbz', 'tbnz']) {
    const out = semanticModelForDecompiler(model(insn(mnemonic, '0x2000')));
    assert.equal(out.instructions[0].branchTarget, 0x2000n, `${mnemonic} completes branchTarget`);
    const structured = semanticModelForDecompiler(model(insn(mnemonic, ['0x2000'])));
    assert.equal(structured.instructions[0].branchTarget, undefined, `${mnemonic} never mints a target from structured text`);
  }
});

test('#5676: structured text never becomes a definite target', () => {
  for (const text of [['0x2000'], [['0x2000']], { toString: () => '0x2000' }, 0x2000, true, null]) {
    const out = semanticModelForDecompiler(model(insn('b', text)));
    assert.equal(out.instructions[0].branchTarget, undefined, `text ${JSON.stringify(String(text))} is not target authority`);
  }
  const call = semanticModelForDecompiler(model(insn('bl', [['0x3000']])));
  assert.equal(call.instructions[0].callTarget, undefined);
});

test('#5676: non-address and symbol spellings stay rejected', () => {
  for (const text of ['loc_1000', 'x + 4', '0x2000+4', '-0x2000', '   ', '', '0xg']) {
    const out = semanticModelForDecompiler(model(insn('b', text)));
    assert.equal(out.instructions[0].branchTarget, undefined);
  }
});

test('#5676: an explicitly present target is never overwritten by the text pass', () => {
  const withTarget = insn('b', '0x2000');
  withTarget.branchTarget = 0x3000n;
  const out = semanticModelForDecompiler(model(withTarget));
  assert.equal(out.instructions[0].branchTarget, 0x3000n, 'an explicit target stays authoritative');
});
