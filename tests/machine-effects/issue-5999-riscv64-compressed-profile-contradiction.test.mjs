import assert from 'node:assert/strict';
import { createRiscv64DecodedInstruction } from '../../js/targets/architecture/riscv64/decoded-instruction.js';

// Issue #5999: ISA profile metadata (`compressedInstructions`) must be
// correlated with the compressed-instruction capability the record itself
// asserts. A canonical record must never carry
// `{ mode:'rv64imc', compressed:true, compressedInstructions:false }`.

const cNop = () => ({
  address: 0x1000n,
  size: 2,
  rawBytes: Uint8Array.from([0x01, 0x00]), // C.NOP
  mode: 'rv64imc',
  instructionAlignment: 2,
  instructionId: 'c-nop',
});

assert.throws(
  () => createRiscv64DecodedInstruction({ ...cNop(), compressedInstructions: false }),
  (err) => err instanceof TypeError && err.message === 'riscv64-decoded-instruction-compressed-profile-contradiction',
  'rv64imc record decoding a compressed instruction must reject compressedInstructions:false',
);

// A 4-byte rv64imc record is still a C-capable ISA claim: metadata denying the
// C extension contradicts the mode authority even when this encoding is wide.
assert.throws(
  () => createRiscv64DecodedInstruction({
    address: 0x1000n,
    size: 4,
    rawBytes: Uint8Array.from([0x13, 0x00, 0x00, 0x00]), // nop (addi x0,x0,0)
    mode: 'rv64imc',
    instructionAlignment: 2,
    compressedInstructions: false,
    instructionId: 'nop',
  }),
  (err) => err instanceof TypeError && err.message === 'riscv64-decoded-instruction-compressed-profile-contradiction',
);

// Consistent evidence keeps working.
const consistent = createRiscv64DecodedInstruction({ ...cNop(), compressedInstructions: true });
assert.equal(consistent.mode, 'rv64imc');
assert.equal(consistent.compressed, true);
assert.equal(consistent.compressedInstructions, true);

const unset = createRiscv64DecodedInstruction(cNop());
assert.equal(unset.compressedInstructions, undefined);

// rv64im + uncompressed wide instruction + no-C profile stays valid.
const noC = createRiscv64DecodedInstruction({
  address: 0x1000n,
  size: 4,
  rawBytes: Uint8Array.from([0x13, 0x00, 0x00, 0x00]),
  mode: 'rv64im',
  instructionAlignment: 4,
  compressedInstructions: false,
  instructionId: 'nop',
});
assert.equal(noC.mode, 'rv64im');
assert.equal(noC.compressed, false);
assert.equal(noC.compressedInstructions, false);

console.log('issue-5999 riscv64 compressed profile contradiction rejected: ok');
