import assert from 'node:assert/strict';
import { createX86DecodedInstruction } from '../../js/targets/architecture/x86_64/decoded-instruction.js';

// `long-64` supports effective address sizes {32, 64} only (67h prefix gives
// 32-bit addressing). A contiguous 16..64 range check accepted impossible
// canonical instructions (16/17/24/31/33/48/63-bit address sizes).

function memoryDetail(addressSizeBits) {
  return {
    operandCount: 1,
    operands: [{
      type: 'memory',
      access: 'read',
      widthBits: 32,
      memory: { base: null, index: null, scale: 1, displacement: 0n, addressSizeBits },
    }],
    implicitReads: [],
    implicitWrites: [],
  };
}

const base = {
  address: 0x1000n,
  length: 2,
  rawBytes: [0x8b, 0x00],
  mode: 'long-64',
  instructionCode: 1,
  instructionFamily: 'mov',
  detailStatus: 'complete',
};

for (const bits of [16, 17, 24, 31, 33, 48, 63]) {
  assert.throws(
    () => createX86DecodedInstruction({ ...base, detail: memoryDetail(bits) }),
    /x86-decoded-instruction-invalid-address-size/,
    `operand addressSizeBits ${bits} must be rejected`,
  );
}

for (const bits of [16, 48]) {
  assert.throws(
    () => createX86DecodedInstruction({
      ...base,
      detail: { ...memoryDetail(64), addressSizeBits: bits },
    }),
    /x86-decoded-instruction-invalid-address-size/,
    `detail addressSizeBits ${bits} must be rejected`,
  );
}

// 32 (0x67 override) and 64 (default) remain canonical, at both levels.
{
  const decoded = createX86DecodedInstruction({ ...base, detail: memoryDetail(32) });
  assert.equal(decoded.detail.operands[0].memory.addressSizeBits, 32);
}
{
  const decoded = createX86DecodedInstruction({ ...base, detail: memoryDetail(64) });
  assert.equal(decoded.detail.operands[0].memory.addressSizeBits, 64);
}
{
  const decoded = createX86DecodedInstruction({
    ...base,
    detail: { ...memoryDetail(64), addressSizeBits: 32 },
  });
  assert.equal(decoded.detail.addressSizeBits, 32);
}
{
  const decoded = createX86DecodedInstruction({
    ...base,
    detail: {
      operandCount: 1,
      operands: [{ type: 'memory', access: 'read', memory: { base: null, index: null, scale: 1, displacement: 0n } }],
    },
  });
  assert.equal(decoded.detail.operands[0].memory.addressSizeBits, 64);
}

console.log('issue-6002-x86-long64-address-size-domain: PASS');
