import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createRiscv64DecodedInstruction,
  RISCV64_DECODER_SEMANTIC_VERSION,
} from '../js/targets/architecture/riscv64/decoded-instruction.js';

function base(overrides = {}) {
  return {
    address: 0x1000n,
    size: 4,
    rawBytes: [0x13, 0x00, 0x00, 0x00],
    ...overrides,
  };
}

test('6038: structured mode does not coerce to canonical authority', () => {
  assert.throws(
    () => createRiscv64DecodedInstruction(base({ mode: ['rv64imc'] })),
    TypeError,
  );
  assert.throws(
    () => createRiscv64DecodedInstruction(base({ mode: { toString: () => 'rv64imc' } })),
    TypeError,
  );
});

test('6038: structured decoderSemanticVersion does not coerce', () => {
  assert.throws(
    () => createRiscv64DecodedInstruction(base({ decoderSemanticVersion: ['capstone-5'] })),
    TypeError,
  );
  assert.throws(
    () => createRiscv64DecodedInstruction(base({ decoderSemanticVersion: 42 })),
    TypeError,
  );
});

test('6038: canonical primitives still accepted', () => {
  const decoded = createRiscv64DecodedInstruction(base({}));
  assert.equal(decoded.mode, 'rv64imc');
  assert.equal(decoded.decoderSemanticVersion, RISCV64_DECODER_SEMANTIC_VERSION);
  const explicit = createRiscv64DecodedInstruction(base({
    mode: 'rv64im',
    decoderSemanticVersion: 'custom-v1',
  }));
  assert.equal(explicit.mode, 'rv64im');
  assert.equal(explicit.decoderSemanticVersion, 'custom-v1');
});
