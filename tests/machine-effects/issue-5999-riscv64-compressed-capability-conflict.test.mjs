import assert from 'node:assert/strict';
import test from 'node:test';
import { createRiscv64DecodedInstruction } from '../../js/targets/architecture/riscv64/decoded-instruction.js';

// `compressedInstructions` is ISA/profile evidence and must agree with the
// capability the decode mode asserts: `rv64im` is the no-C profile and
// `rv64imc` carries compressed capability. The constructor used to store the
// flag as `=== true` without any correlation, so a compressed record could
// simultaneously claim `mode:'rv64imc'` + compressed encoding and
// `compressedInstructions:false` (#5999).

const CNOP = Uint8Array.from([0x01, 0x00]);
const ADDI = [0x13, 0, 0, 0];

test('issue-5999: compressed encoding + compressedInstructions:false is rejected', () => {
  assert.throws(
    () => createRiscv64DecodedInstruction({
      address: 0x1000n,
      size: 2,
      rawBytes: CNOP,
      mode: 'rv64imc',
      instructionAlignment: 2,
      compressedInstructions: false,
      instructionId: 'issue-5999:c-nop',
    }),
    /riscv64-decoded-instruction-compressed-capability-conflict/,
  );
});

test('issue-5999: mode rv64imc with compressedInstructions:false is rejected even for 4-byte words', () => {
  assert.throws(
    () => createRiscv64DecodedInstruction({
      address: 0x1000n,
      size: 4,
      rawBytes: ADDI,
      mode: 'rv64imc',
      instructionAlignment: 2,
      compressedInstructions: false,
    }),
    /riscv64-decoded-instruction-compressed-capability-conflict/,
  );
});

test('issue-5999: mode rv64im with compressedInstructions:true is rejected', () => {
  assert.throws(
    () => createRiscv64DecodedInstruction({
      address: 0x1000n,
      size: 4,
      rawBytes: ADDI,
      mode: 'rv64im',
      instructionAlignment: 4,
      compressedInstructions: true,
    }),
    /riscv64-decoded-instruction-compressed-capability-conflict/,
  );
});

test('issue-5999: non-boolean compressedInstructions is rejected instead of silently booleanized', () => {
  const base = { address: 0x1000n, size: 4, rawBytes: ADDI, mode: 'rv64imc', instructionAlignment: 2 };
  assert.throws(() => createRiscv64DecodedInstruction({ ...base, compressedInstructions: 'yes' }), /riscv64-decoded-instruction-invalid-compressed-instructions/);
  assert.throws(() => createRiscv64DecodedInstruction({ ...base, compressedInstructions: 1 }), /riscv64-decoded-instruction-invalid-compressed-instructions/);
  assert.throws(() => createRiscv64DecodedInstruction({ ...base, compressedInstructions: ['true'] }), /riscv64-decoded-instruction-invalid-compressed-instructions/);
});

test('issue-5999: consistent profile/encoding pairs are still accepted', () => {
  const compressed = createRiscv64DecodedInstruction({
    address: 0x1000n,
    size: 2,
    rawBytes: CNOP,
    mode: 'rv64imc',
    instructionAlignment: 2,
    compressedInstructions: true,
    instructionId: 'issue-5999:c-nop-ok',
  });
  assert.equal(compressed.compressedInstructions, true);
  assert.equal(compressed.compressed, true);
  assert.equal(compressed.detailStatus, 'complete');

  const uncompressed = createRiscv64DecodedInstruction({
    address: 0x1000n,
    size: 4,
    rawBytes: ADDI,
    mode: 'rv64im',
    instructionAlignment: 4,
    compressedInstructions: false,
  });
  assert.equal(uncompressed.compressedInstructions, false);
  assert.equal(uncompressed.compressed, false);
  assert.equal(uncompressed.detailStatus, 'complete');
});

test('issue-5999: omitted compressedInstructions still publishes no profile flag', () => {
  const decoded = createRiscv64DecodedInstruction({
    address: 0x1000n,
    size: 4,
    rawBytes: ADDI,
    mode: 'rv64imc',
    instructionAlignment: 2,
  });
  assert.equal('compressedInstructions' in decoded, false);
});
