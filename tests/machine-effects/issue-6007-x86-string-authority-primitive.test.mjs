import assert from 'node:assert/strict';
import { createX86DecodedInstruction } from '../../js/targets/architecture/x86_64/decoded-instruction.js';

// Structured decoder records are the exact-detail trust boundary. Semantic
// allow-list tokens must be primitive strings: `String()` coercion let
// arbitrary objects mint canonical `register`/`write`/`long-64`/`call`
// authority from their `toString()` alone.
const as = (value) => ({ toString() { return value; } });

const base = {
  address: 0x1000n,
  length: 1,
  rawBytes: [0x90],
  mode: 'long-64',
  instructionCode: 1,
  instructionFamily: 'mov',
};

assert.throws(
  () => createX86DecodedInstruction({
    ...base,
    detailStatus: 'complete',
    detail: { operandCount: 1, operands: [{ type: as('register'), access: as('write'), register: 'rax', widthBits: 64 }] },
  }),
  /x86-decoded-instruction-invalid-operand-type/,
);

assert.throws(
  () => createX86DecodedInstruction({ ...base, mode: as('long-64'), detail: { operandCount: 0, operands: [] } }),
  /x86-decoded-instruction-mode-required/,
);

assert.throws(
  () => createX86DecodedInstruction({ ...base, instructionFamily: as('call'), detail: { operandCount: 0, operands: [] } }),
  /x86-decoded-instruction-family-required/,
);

assert.throws(
  () => createX86DecodedInstruction({
    ...base,
    instructionFamily: 'jcc',
    detail: { operandCount: 0, operands: [], conditionCode: as('je') },
  }),
  /x86-decoded-instruction-invalid-condition-code/,
);

assert.throws(
  () => createX86DecodedInstruction({
    ...base,
    instructionFamily: 'call',
    detail: { operandCount: 0, operands: [], implicitReads: [as('rsp')] },
  }),
  /x86-decoded-instruction-unknown-implicit-read/,
);

// Primitive string tokens keep working, and lookup-style register objects
// (`{ id: 'rax' }`) stay supported through the register descriptor path.
const canonical = createX86DecodedInstruction({
  ...base,
  // A condition code is only valid when the family carries the same
  // condition suffix. Keep the primitive-string coverage while using a
  // canonical branch record accepted by the strict decoder boundary.
  instructionFamily: 'je',
  detailStatus: 'complete',
  detail: {
    operandCount: 1,
    operands: [{ type: 'register', access: 'write', register: 'rax', widthBits: 64 }],
    implicitReads: [{ id: 'rsp' }],
    conditionCode: 'e',
  },
});
assert.equal(canonical.detailAvailable, true);
assert.equal(canonical.detail.operands[0].type, 'register');
assert.equal(canonical.detail.operands[0].access, 'write');
assert.equal(canonical.detail.implicitReads[0].id, 'rsp');
assert.equal(canonical.detail.conditionCode, 'e');
assert.equal(canonical.instructionFamily, 'je');
assert.equal(canonical.mode, 'long-64');

console.log('issue-6007-x86-string-authority-primitive: PASS');
