import assert from 'node:assert/strict';
import test from 'node:test';

import { createRiscv64DecodedInstruction } from '../../../js/targets/architecture/riscv64/decoded-instruction.js';

function addiX1() {
  return createRiscv64DecodedInstruction({
    address: 0n,
    size: 4,
    rawBytes: Uint8Array.of(0x93, 0x00, 0x10, 0x00),
    mode: 'rv64imc',
  });
}

test('canonical bytes cannot be mutated through the published record', () => {
  const decoded = addiX1();
  assert.equal(decoded.fields.op, 'addi');
  assert.equal(decoded.fields.rd, 'x1');
  decoded.rawBytes[0] = 0x13;
  assert.deepEqual([...decoded.rawBytes], [0x93, 0x00, 0x10, 0x00]);
  assert.equal(decoded.fields.rd, 'x1');
});

test('constructor input buffer stays isolated from the canonical record', () => {
  const input = Uint8Array.of(0x93, 0x00, 0x10, 0x00);
  const decoded = createRiscv64DecodedInstruction({ address: 0n, size: 4, rawBytes: input, mode: 'rv64imc' });
  input[0] = 0x13;
  assert.deepEqual([...decoded.rawBytes], [0x93, 0x00, 0x10, 0x00]);
});

test('each published snapshot is isolated from the others', () => {
  const decoded = addiX1();
  const first = decoded.rawBytes;
  first[0] = 0x13;
  assert.deepEqual([...decoded.rawBytes], [0x93, 0x00, 0x10, 0x00]);
});
