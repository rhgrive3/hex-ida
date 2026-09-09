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

test('#5676: structured text never becomes a definite target', () => {
  for (const text of [['0x2000'], { toString: () => '0x2000' }, 0x2000, true, null]) {
    const out = semanticModelForDecompiler(model(insn('b', text)));
    assert.equal(out.instructions[0].branchTarget, undefined, `text ${JSON.stringify(String(text))} is not target authority`);
  }
  const call = semanticModelForDecompiler(model(insn('bl', [['0x3000']])));
  assert.equal(call.instructions[0].callTarget, undefined);
});

test('#5676: non-address and symbol spellings stay rejected', () => {
  for (const text of ['loc_1000', 'x + 4', '', '0xg']) {
    const out = semanticModelForDecompiler(model(insn('b', text)));
    assert.equal(out.instructions[0].branchTarget, undefined);
  }
});
