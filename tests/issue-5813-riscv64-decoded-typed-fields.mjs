// Issue #5813 regression: the RV64 decoded-instruction contract must type-check
// address/size/instructionAlignment instead of promoting booleans, arrays and
// other structured values through BigInt()/Number() coercion.
import assert from 'node:assert/strict';
import { createRiscv64DecodedInstruction } from '../js/targets/architecture/riscv64/decoded-instruction.js';

const ADDI = [0x13, 0, 0, 0]; // canonical addi x0,x0,0
const C_NOP = [0x01, 0x00];   // canonical compressed nop

// 1. The issue repro: boolean/Array inputs are rejected outright.
{
  assert.throws(() => createRiscv64DecodedInstruction({
    address: true, size: [4], instructionAlignment: [2], rawBytes: ADDI,
  }), (e) => e instanceof TypeError && /riscv64-decoded-instruction-/.test(e.message));
}

// 2. Each field individually rejects structured/coercible representations.
for (const [field, value] of [
  ['address', true], ['address', [0x1000]], ['address', {}], ['address', '0xzz'], ['address', ''],
  ['size', [4]], ['size', true], ['size', '4'],
  ['instructionAlignment', [2]], ['instructionAlignment', true], ['instructionAlignment', '2'],
]) {
  const input = { address: 0x1000, size: 4, instructionAlignment: 2, rawBytes: ADDI };
  input[field] = value;
  assert.throws(() => createRiscv64DecodedInstruction(input),
    (e) => e instanceof TypeError && /riscv64-decoded-instruction-/.test(e.message),
    `${field}=${JSON.stringify(value)} must not coerce`);
}

// 3. Typed values keep working.
{
  const decoded = createRiscv64DecodedInstruction({
    address: 0x1000n, size: 4, instructionAlignment: 2, rawBytes: ADDI,
  });
  assert.equal(decoded.address, 0x1000n);
  assert.equal(decoded.detailStatus, 'complete');
}
{
  const decoded = createRiscv64DecodedInstruction({
    address: 0x1000, size: 4, instructionAlignment: 2, rawBytes: ADDI,
  });
  assert.equal(decoded.address, 0x1000n, 'safe-integer number addresses stay valid');
}

// 4. Canonical integer strings stay valid through the explicit address grammar.
{
  const decoded = createRiscv64DecodedInstruction({
    address: '0x1000', size: 4, instructionAlignment: 2, rawBytes: ADDI,
  });
  assert.equal(decoded.address, 0x1000n);
}

// 5. Existing compressed/non-compressed encoding geometry remains fail-closed.
{
  const decoded = createRiscv64DecodedInstruction({
    address: 0x1000n, size: 2, instructionAlignment: 2, mode: 'rv64imc', rawBytes: C_NOP,
  });
  assert.equal(decoded.size, 2);
  assert.equal(decoded.instructionAlignment, 2);
  assert.equal(decoded.detailStatus, 'complete');
}
{
  const decoded = createRiscv64DecodedInstruction({
    address: 0x1000n, size: 4, instructionAlignment: 4, mode: 'rv64im', rawBytes: ADDI,
  });
  assert.equal(decoded.size, 4);
  assert.equal(decoded.instructionAlignment, 4);
  assert.equal(decoded.detailStatus, 'complete');
}
assert.throws(() => createRiscv64DecodedInstruction({
  address: 0x1000n, size: 2, instructionAlignment: 4, mode: 'rv64im', rawBytes: C_NOP,
}), (e) => e instanceof TypeError && /compressed-disabled|mode-alignment-mismatch/.test(e.message));
assert.throws(() => createRiscv64DecodedInstruction({
  address: 0x1000n, size: 4, instructionAlignment: 2, mode: 'rv64im', rawBytes: ADDI,
}), (e) => e instanceof TypeError && /mode-alignment-mismatch/.test(e.message));

console.log('issue #5813 riscv64 decoded-instruction typed-field regressions: PASS');
