import assert from 'node:assert/strict';

import { compareFingerprints, fingerprintFunction, fingerprintFunctionFast, normalizeInstruction } from '../js/fingerprint/index.js';

const valid = {
  mnemonic: 'add',
  parsedOperands: [
    { k: 'reg', text: 'x0' },
    { k: 'reg', text: 'x1' },
    { k: 'imm', value: 1n, text: '#1' },
  ],
};

assert.deepEqual(normalizeInstruction(valid), {
  mnemonic: 'add',
  operands: 'xR0, xR0, #1',
});
assert.deepEqual(normalizeInstruction('add x0, x1, #1'), {
  mnemonic: 'add',
  operands: 'xR0, xR0, #1',
});

const malformed = [
  {
    mnemonic: 'add',
    parsedOperands: [{ k: 'reg', text: ['x0'] }],
  },
  {
    mnemonic: 'add',
    parsedOperands: [{ k: 'imm', value: ['1'], text: '#forged' }],
  },
  {
    mnemonic: 'b.eq',
    parsedOperands: [{ k: 'cond', text: ['eq'] }],
  },
  {
    mnemonic: 'add',
    parsedOperands: [{ k: 'reg', text: 'x0', shift: { op: 'lsl', amount: ['12'] } }],
  },
  {
    mnemonic: 'fadd',
    parsedOperands: [{ k: 'imm', float: ['1.5'], text: '#forged' }],
  },
];
for (const index of [0, 2, 3]) assert.equal(normalizeInstruction(malformed[index]), null);
assert.deepEqual(normalizeInstruction(malformed[1]), { mnemonic: 'add', operands: '#forged' });
assert.deepEqual(normalizeInstruction(malformed[4]), { mnemonic: 'fadd', operands: '#forged' });
assert.deepEqual(normalizeInstruction({
  mnemonic: 'add',
  operands: 'x0, x1, #1',
  parsedOperands: malformed[1].parsedOperands,
}), { mnemonic: 'add', operands: '#forged' });

const validStructured = [
  normalizeInstruction({ mnemonic: 'b.eq', parsedOperands: [{ k: 'cond', text: 'eq' }] }),
  normalizeInstruction({ mnemonic: 'add', parsedOperands: [{ k: 'reg', text: 'x0', shift: { op: 'lsl', amount: 12 } }] }),
  normalizeInstruction({ mnemonic: 'fadd', parsedOperands: [{ k: 'imm', float: 1.5, text: '#1.5' }] }),
];
assert.deepEqual(validStructured.map((item) => item?.operands), ['eq', 'xR0,lsl #12', '1.5']);

const canonicalFingerprint = fingerprintFunction({ architecture: 'arm64', size: 4, instructions: [valid] });
const malformedFingerprint = fingerprintFunction({
  architecture: 'arm64',
  size: 4,
  instructionSequenceHash: 'forged-sequence',
  normalizedOperandsHash: 'forged-operands',
  instructions: [malformed[0]],
});
const malformedFastFingerprint = fingerprintFunctionFast({
  architecture: 'arm64',
  size: 4,
  instructionSequenceHash: 'forged-sequence',
  normalizedOperandsHash: 'forged-operands',
  instructions: [malformed[0]],
});
assert.ok(canonicalFingerprint.instructionSequenceHash);
assert.ok(canonicalFingerprint.normalizedOperandsHash);
assert.equal(malformedFingerprint.instructionSequenceHash, null);
assert.equal(malformedFingerprint.normalizedOperandsHash, null);
assert.equal(malformedFastFingerprint.instructionSequenceHash, null);
assert.equal(malformedFastFingerprint.normalizedOperandsHash, null);
assert.notEqual(
  compareFingerprints(
    { architecture: 'arm64', size: 4, instructions: [valid] },
    { architecture: 'arm64', size: 4, instructions: [malformed[0]] },
  ).identity,
  'normalized-identical',
);

console.log('issue-4520 fingerprint structured operands: PASS');
