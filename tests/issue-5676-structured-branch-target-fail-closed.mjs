// Issue #5676 regression: textual branch/call target completion in
// decompile-base.js is an evidence boundary. Only a raw primitive string
// operand may become a canonical branchTarget/callTarget; Array/object/number
// payloads would launder through String() into an address token and gain the
// same CFG authority as canonical disassembler text.
import assert from 'node:assert/strict';
import { semanticModelForDecompiler } from '../js/decompile-base.js';

function modelWithTextOperand(payload, { mnemonic = 'b' } = {}) {
  return {
    instructions: [{
      row: 0,
      address: 0x1000n,
      mnemonic,
      branchTarget: null,
      callTarget: null,
      ops: [{ k: 'other', text: payload }],
    }],
  };
}

// Canonical primitive-string operands still complete the target.
{
  const branch = semanticModelForDecompiler(modelWithTextOperand('0x2000'));
  assert.equal(branch.instructions[0].branchTarget, 0x2000n, 'canonical hex string must complete branchTarget');

  const branchPound = semanticModelForDecompiler(modelWithTextOperand('#0x2000'));
  assert.equal(branchPound.instructions[0].branchTarget, 0x2000n, '"#" prefix stays supported');

  const branchDec = semanticModelForDecompiler(modelWithTextOperand('8192'));
  assert.equal(branchDec.instructions[0].branchTarget, 8192n, 'canonical decimal string must complete branchTarget');

  const call = semanticModelForDecompiler(modelWithTextOperand('0x2000', { mnemonic: 'bl' }));
  assert.equal(call.instructions[0].callTarget, 0x2000n, 'canonical hex string must complete callTarget');
}

// Structured / non-string payloads must never mint a target identity.
for (const [label, payload] of [
  ['array', ['0x2000']],
  ['nested array', [['0x2000']]],
  ['custom toString object', { toString() { return '0x2000'; } }],
  ['number', 8192],
  ['boolean', true],
  ['null payload', null],
]) {
  const branch = semanticModelForDecompiler(modelWithTextOperand(payload));
  assert.equal(branch.instructions[0].branchTarget, null, `${label} must not mint branchTarget`);
  const call = semanticModelForDecompiler(modelWithTextOperand(payload, { mnemonic: 'bl' }));
  assert.equal(call.instructions[0].callTarget, null, `${label} must not mint callTarget`);
}

// Non-canonical strings (labels, expressions, negative numbers) stay rejected.
for (const [label, payload] of [
  ['symbol label', 'sym_undecodable_target'],
  ['negative hex', '-0x2000'],
  ['arithmetic expression', '0x2000+4'],
  ['blank string', '   '],
  ['empty string', ''],
]) {
  const branch = semanticModelForDecompiler(modelWithTextOperand(payload));
  assert.equal(branch.instructions[0].branchTarget, null, `${label} must not mint branchTarget`);
}

// Explicit existing targets are never overwritten by the text pass.
{
  const model = modelWithTextOperand('0x2000');
  model.instructions[0].branchTarget = 0x3000n;
  const out = semanticModelForDecompiler(model);
  assert.equal(out.instructions[0].branchTarget, 0x3000n, 'an explicit target stays authoritative');
}

console.log('Issue #5676 structured-branch-target fail-closed regressions PASS');
