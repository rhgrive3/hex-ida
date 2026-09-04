import test from 'node:test';
import assert from 'node:assert/strict';
import { createX86DecodedInstruction } from '../js/targets/architecture/x86_64/decoded-instruction.js';
import { liftX86ControlEffects } from '../js/targets/architecture/x86_64/effects/control.js';

function decoded({ family, mnemonic, rawBytes, operands }) {
  return createX86DecodedInstruction({
    address: 0x1000n,
    length: rawBytes.length,
    rawBytes: Uint8Array.from(rawBytes),
    mode: 'long-64',
    instructionId: `audit-${family}`,
    instructionCode: 1,
    instructionFamily: family,
    mnemonic,
    detailAvailable: true,
    detailStatus: 'complete',
    detail: {
      addressSizeBits: 64,
      operandCount: operands.length,
      operands,
      implicitReads: [],
      implicitWrites: [],
    },
  });
}

const reg32 = (id) => ({ type: 'register', access: 'unknown', widthBits: 32, registerId: id });

function assertTrap(bundle, family) {
  assert.ok(bundle, 'expected a bundle');
  assert.equal(bundle.completeness, 'exact');
  assert.equal(bundle.controlEffect?.kind, 'trap');
  assert.equal(bundle.controlEffect?.reason, `x86-${family}-invalid-opcode`);
}

test('6055: canonical UD0/UD1 two-operand forms trap exactly', () => {
  assertTrap(
    liftX86ControlEffects(decoded({ family: 'ud0', mnemonic: 'ud0', rawBytes: [0x0f, 0xff, 0xc0], operands: [reg32('eax'), reg32('eax')] })),
    'ud0',
  );
  assertTrap(
    liftX86ControlEffects(decoded({ family: 'ud1', mnemonic: 'ud1', rawBytes: [0x0f, 0xb9, 0xc0], operands: [reg32('eax'), reg32('eax')] })),
    'ud1',
  );
});

test('6055: UD2 stays operandless', () => {
  assertTrap(
    liftX86ControlEffects(decoded({ family: 'ud2', mnemonic: 'ud2', rawBytes: [0x0f, 0x0b], operands: [] })),
    'ud2',
  );
});

test('6055: malformed UD shapes stay fail-closed', () => {
  const oneOp = liftX86ControlEffects(decoded({ family: 'ud0', mnemonic: 'ud0', rawBytes: [0x0f, 0xff, 0xc0], operands: [reg32('eax')] }));
  assert.equal(oneOp?.completeness, 'partial');
  const threeOp = liftX86ControlEffects(decoded({ family: 'ud1', mnemonic: 'ud1', rawBytes: [0x0f, 0xb9, 0xc0], operands: [reg32('eax'), reg32('eax'), reg32('ebx')] }));
  assert.equal(threeOp?.completeness, 'partial');
  const ud2WithOps = liftX86ControlEffects(decoded({ family: 'ud2', mnemonic: 'ud2', rawBytes: [0x0f, 0x0b], operands: [reg32('eax')] }));
  assert.equal(ud2WithOps?.completeness, 'partial');
});
