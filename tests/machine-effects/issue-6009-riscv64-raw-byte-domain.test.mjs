import assert from 'node:assert/strict';
import { createRiscv64DecodedInstruction } from '../../js/targets/architecture/riscv64/decoded-instruction.js';

// `rawBytes` is the architectural authority for every decoded field. Typed
// conversion coercion (`Uint8Array.from`) silently remapped out-of-domain and
// non-numeric elements into a different canonical instruction (275 -> 0x13
// `addi`). The canonical boundary must reject them instead.
const base = { address: 0x1000n, size: 4, mode: 'rv64im', instructionId: 'issue-6009:bad-bytes' };

assert.throws(
  () => createRiscv64DecodedInstruction({ ...base, rawBytes: [275, 0, 0, 0] }),
  /riscv64-decoded-instruction-invalid-raw-byte/,
);
assert.throws(
  () => createRiscv64DecodedInstruction({ ...base, rawBytes: [0x13, 0, 0, 256] }),
  /riscv64-decoded-instruction-invalid-raw-byte/,
);
assert.throws(
  () => createRiscv64DecodedInstruction({ ...base, rawBytes: ['19', 0, 0, 0] }),
  /riscv64-decoded-instruction-invalid-raw-byte/,
);
assert.throws(
  () => createRiscv64DecodedInstruction({ ...base, rawBytes: [null, 0, 0, 0] }),
  /riscv64-decoded-instruction-invalid-raw-byte/,
);
assert.throws(
  () => createRiscv64DecodedInstruction({ ...base, rawBytes: [1.5, 0, 0, 0] }),
  /riscv64-decoded-instruction-invalid-raw-byte/,
);
assert.throws(
  () => createRiscv64DecodedInstruction({ ...base, rawBytes: '13 00 00 00' }),
  /riscv64-decoded-instruction-invalid-raw-bytes/,
);
assert.throws(
  () => createRiscv64DecodedInstruction({ ...base, rawBytes: [0x13, 0, 0] }),
  /riscv64-decoded-instruction-byte-length-mismatch/,
);
assert.throws(
  () => createRiscv64DecodedInstruction({ ...base, rawBytes: [0x13, , , 0] }),
  /riscv64-decoded-instruction-invalid-raw-byte/,
);

const canonical = createRiscv64DecodedInstruction({ ...base, rawBytes: [0x13, 0, 0, 0] });
assert.equal(canonical.instructionFamily, 'addi');
assert.deepEqual([...canonical.rawBytes], [0x13, 0, 0, 0]);
const fromTyped = createRiscv64DecodedInstruction({ ...base, rawBytes: new Uint8Array([0x13, 0, 0, 0]) });
assert.equal(fromTyped.instructionFamily, 'addi');
const compressed = createRiscv64DecodedInstruction({ address: 0x1000n, size: 2, mode: 'rv64imc', rawBytes: [0x01, 0x00] });
assert.equal(compressed.instructionFamily, 'nop');

console.log('issue-6009-riscv64-raw-byte-domain: PASS');
