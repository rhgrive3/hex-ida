import assert from 'node:assert/strict';
import test from 'node:test';

import { createX86DecodedInstruction } from '../../js/targets/architecture/x86_64/decoded-instruction.js';
import { liftX86ControlEffects } from '../../js/targets/architecture/x86_64/effects/control.js';

// `detail.conditionCode` is derived from the opcode family by the structured
// producer. When both are present they must agree: `je` + `ne` would let the
// control lifter invert the branch predicate (JE acting on !ZF) (#5981).

const base = {
  address: 0x1000n,
  length: 2,
  rawBytes: Uint8Array.from([0x74, 0]),
  mode: 'long-64',
  instructionCode: 1,
  instructionId: 'i0',
  detail: {
    addressSizeBits: 64,
    operandCount: 1,
    operands: [{ type: 'immediate', access: 'read', widthBits: 8, value: 0x1002n }],
    implicitReads: [],
    implicitWrites: [],
  },
};

const build = (family, conditionCode) => createX86DecodedInstruction({
  ...base,
  instructionFamily: family,
  detail: { ...base.detail, conditionCode },
});

test('#5981: agreeing condition codes and aliases are accepted', () => {
  for (const [family, code] of [['je', 'e'], ['je', 'z'], ['jne', 'ne'], ['jne', 'nz'], ['jna', 'be'], ['setz', 'z'], ['cmovnz', 'nz'], ['jcxz', 'cxz']]) {
    assert.equal(build(family, code).detail.conditionCode, code, `${family}+${code}`);
  }
});

test('#5981: whitespace-padded instruction families use one normalized authority', () => {
  const decoded = build(' je ', 'e');
  assert.equal(decoded.instructionFamily, 'je');
  assert.equal(decoded.detail.conditionCode, 'e');
});

test('#5981: inverted condition codes are rejected', () => {
  for (const [family, code] of [['je', 'ne'], ['jne', 'e'], ['jcxz', 'e']]) {
    assert.throws(
      () => build(family, code),
      (error) => error?.message === 'x86-decoded-instruction-condition-code-family-mismatch',
      `${family}+${code} must not mint exact branch semantics`,
    );
  }
});

test('#5981: unexpected condition codes on non-condition families are rejected', () => {
  for (const family of ['mov', 'add', 'jmp']) {
    assert.throws(
      () => build(family, 'e'),
      (error) => error?.message === 'x86-decoded-instruction-unexpected-condition-code',
      `${family} carries no condition suffix`,
    );
  }
});

test('#5981: a missing conditionCode keeps the family fallback', () => {
  const decoded = build('je', null);
  assert.equal(decoded.detail.conditionCode, null);
  const bundle = liftX86ControlEffects(decoded, {});
  assert.equal(bundle.completeness, 'exact');
  assert.ok(bundle.controlEffect.condition, 'the JE condition is derived from the family (ZF)');
});

test('#5981: an inverted record can no longer produce exact inverted semantics', () => {
  assert.throws(() => liftX86ControlEffects(createX86DecodedInstruction({
    ...base,
    instructionFamily: 'je',
    detail: { ...base.detail, conditionCode: 'ne' },
  }), {}));
});
