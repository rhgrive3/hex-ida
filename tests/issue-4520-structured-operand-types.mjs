import assert from 'node:assert/strict';
import { fingerprintFunction, normalizeInstruction } from '../js/fingerprint/index.js';

const validParsed = [
  { k: 'reg', text: 'x0' },
  { k: 'reg', text: 'x1' },
  { k: 'imm', value: 1n, text: '#1' },
];

const valid = normalizeInstruction({ mnemonic: 'add', parsedOperands: validParsed });
assert.deepEqual(valid, normalizeInstruction('add x0, x1, #1'));
assert.deepEqual(
  normalizeInstruction({ mnemonic: 'add', parsedOperands: [{ k: 'reg', text: 'x0', shift: { op: 'lsl', amount: 12 } }] }),
  normalizeInstruction('add x0, lsl #12'),
);
assert.deepEqual(
  normalizeInstruction({ mnemonic: 'b.eq', parsedOperands: [{ k: 'cond', text: 'eq' }] }),
  { mnemonic: 'b.eq', operands: 'eq' },
);
assert.deepEqual(
  normalizeInstruction({
    mnemonic: 'fmov',
    parsedOperands: [{ k: 'reg', text: 'd0' }, { k: 'imm', value: null, float: 1.5, text: '#1.5' }],
  }),
  normalizeInstruction('fmov d0, #1.5'),
);

for (const [label, parsedOperands] of [
  ['register text', [{ k: 'reg', text: ['x0'] }]],
  ['immediate value', [{ k: 'imm', value: ['1'], text: '#1' }]],
  ['immediate text', [{ k: 'imm', value: 1n, text: ['#1'] }]],
  ['condition text', [{ k: 'cond', text: ['eq'] }]],
  ['shift amount', [{ k: 'reg', text: 'x0', shift: { op: 'lsl', amount: ['12'] } }]],
  ['shift op', [{ k: 'reg', text: 'x0', shift: { op: ['lsl'], amount: 12 } }]],
  ['float value', [{ k: 'imm', value: null, float: ['1'], text: '#1' }]],
]) {
  assert.equal(
    normalizeInstruction({ mnemonic: 'add', parsedOperands }),
    null,
    `${label} must fail closed instead of becoming a canonical operand`,
  );
}

const canonical = fingerprintFunction({
  architecture: 'arm64', size: 4,
  instructions: [{ mnemonic: 'add', parsedOperands: validParsed }],
});
const malformed = fingerprintFunction({
  architecture: 'arm64', size: 4,
  instructions: [{ mnemonic: 'add', parsedOperands: [{ k: 'reg', text: ['x0'] }] }],
});
assert.ok(canonical.normalizedOperandsHash);
assert.equal(malformed.normalizedOperandsHash, null);
assert.equal(malformed.instructionSequenceHash, null);

// Raw textual parsing remains available for legacy callers.
assert.deepEqual(normalizeInstruction('add x0, x1, #0x20'), { mnemonic: 'add', operands: 'xR0, xR0, #32' });

console.log('issue-4520-structured-operand-types: PASS');
