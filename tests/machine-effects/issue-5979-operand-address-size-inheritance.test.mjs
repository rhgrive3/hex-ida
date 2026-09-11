import assert from 'node:assert/strict';
import { createX86DecodedInstruction } from '../../js/targets/architecture/x86_64/decoded-instruction.js';

// #5979: an unstated memory-operand address size defaulted to 64 even when
// the instruction-level `detail.addressSizeBits` was 32, minting a canonical
// record that contradicts itself (32 at instruction level, 64 at operand
// level) for legal 0x67-prefixed long-mode instructions.

const withOverride = createX86DecodedInstruction({
  address: 0x1000n,
  length: 4,
  rawBytes: [0x67, 0x48, 0x8b, 0x00],
  mode: 'long-64',
  instructionCode: 1,
  instructionFamily: 'mov',
  mnemonic: 'mov',
  detailAvailable: true,
  detailStatus: 'complete',
  detail: {
    addressSizeBits: 32,
    operandCount: 1,
    operands: [{ type: 'memory', access: 'read', widthBits: 64, memory: { base: 'eax', index: null, scale: 1, displacement: 0n } }],
    implicitReads: [],
    implicitWrites: [],
  },
});
assert.equal(withOverride.detail.addressSizeBits, 32);
assert.equal(withOverride.detail.operands[0].memory.addressSizeBits, 32, 'operand must inherit the 32-bit instruction-level address size');

// Default 64-bit long mode inherits 64 (both spelled and unstated).
const plain = createX86DecodedInstruction({
  address: 0x1000n,
  length: 4,
  rawBytes: [0x48, 0x8b, 0x00, 0x90],
  mode: 'long-64',
  instructionCode: 2,
  instructionFamily: 'mov',
  mnemonic: 'mov',
  detailAvailable: true,
  detailStatus: 'complete',
  detail: {
    operandCount: 1,
    operands: [{ type: 'memory', access: 'read', widthBits: 64, memory: { base: 'rax', index: null, scale: 1, displacement: 0n } }],
    implicitReads: [],
    implicitWrites: [],
  },
});
assert.equal(plain.detail.operands[0].memory.addressSizeBits, 64);

// An explicitly stated operand-level size stays authoritative for itself and
// never conflicts with the instruction level.
const explicit = createX86DecodedInstruction({
  address: 0x1000n,
  length: 4,
  rawBytes: [0x67, 0x48, 0x8b, 0x00],
  mode: 'long-64',
  instructionCode: 3,
  instructionFamily: 'mov',
  mnemonic: 'mov',
  detailAvailable: true,
  detailStatus: 'complete',
  detail: {
    addressSizeBits: 32,
    operandCount: 1,
    operands: [{ type: 'memory', access: 'read', widthBits: 64, memory: { base: 'eax', index: null, scale: 1, displacement: 0n, addressSizeBits: 32 } }],
    implicitReads: [],
    implicitWrites: [],
  },
});
assert.equal(explicit.detail.operands[0].memory.addressSizeBits, 32);

// No memory operand / no stated sizes: record stays valid.
const registerOnly = createX86DecodedInstruction({
  address: 0x1000n,
  length: 3,
  rawBytes: [0x48, 0x89, 0xc1],
  mode: 'long-64',
  instructionCode: 4,
  instructionFamily: 'mov',
  mnemonic: 'mov',
  detailAvailable: true,
  detailStatus: 'complete',
  detail: {
    operandCount: 2,
    operands: [
      { type: 'register', access: 'write', widthBits: 64, register: 'rcx' },
      { type: 'register', access: 'read', widthBits: 64, register: 'rax' },
    ],
    implicitReads: [],
    implicitWrites: [],
  },
});
assert.equal(registerOnly.detail.operands.length, 2);

console.log('x86 decoded instruction operand address-size inheritance (#5979): PASS');
