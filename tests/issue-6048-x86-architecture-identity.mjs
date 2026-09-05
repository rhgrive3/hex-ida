import test from 'node:test';
import assert from 'node:assert/strict';
import { createX86DecodedInstruction } from '../js/targets/architecture/x86_64/decoded-instruction.js';

function nop(overrides = {}) {
  return {
    address: 0x1000n,
    length: 1,
    rawBytes: Uint8Array.of(0x90),
    mode: 'long-64',
    instructionCode: 1,
    instructionFamily: 'nop',
    instructionId: 'x86:1000',
    detailAvailable: true,
    detailStatus: 'complete',
    detail: { operandCount: 0, operands: [], implicitReads: [], implicitWrites: [] },
    ...overrides,
  };
}

test('6048: missing architecture becomes canonical x86_64', () => {
  const decoded = createX86DecodedInstruction(nop());
  assert.equal(decoded.architecture, 'x86_64');
  assert.equal(decoded.architectureId, 'x86_64');
});

test('6048: explicit x86_64 identity is accepted', () => {
  const decoded = createX86DecodedInstruction(nop({ architecture: 'x86_64', architectureId: 'x86_64' }));
  assert.equal(decoded.architecture, 'x86_64');
});

test('6048: foreign architecture is rejected', () => {
  for (const architecture of ['arm64', 'riscv64', 'aarch64']) {
    assert.throws(
      () => createX86DecodedInstruction(nop({ architecture })),
      /x86-decoded-instruction-architecture-mismatch/,
      `${architecture} must not become a canonical x86 record`,
    );
  }
});

test('6048: foreign architectureId is rejected', () => {
  assert.throws(
    () => createX86DecodedInstruction(nop({ architectureId: 'arm64' })),
    /x86-decoded-instruction-architecture-mismatch/,
  );
});
