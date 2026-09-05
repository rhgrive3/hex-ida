import assert from 'node:assert/strict';

import { liftX86SystemRegisterMoveEffects } from '../../js/targets/architecture/x86_64/effects/system-register-move.js';

let instructionCode = 0x597600;

function register(name, access) {
  return { type:'register', registerId:name, widthBits:64, access };
}

function systemMove({ opcode, modrm, rex = null, operands }) {
  instructionCode += 1;
  const rawBytes = rex == null
    ? Uint8Array.of(0x0f, opcode, modrm)
    : Uint8Array.of(rex, 0x0f, opcode, modrm);
  return {
    instructionId:`issue-5976-${instructionCode}`,
    instructionCode,
    instructionFamily:'mov',
    opcodeName:'mov',
    mnemonic:'mov',
    mode:'long-64',
    address:0x597600n + BigInt(instructionCode),
    length:rawBytes.length,
    rawBytes,
    detailStatus:'complete',
    decoderSemanticVersion:'capstone-5-x86-structured-v2',
    detail:{
      abiContractVersion:'capstone-5-wasm32-x86-detail/v1',
      operandCount:2,
      operands,
    },
  };
}

function assertExact(instruction, privilegedRegister) {
  const result = liftX86SystemRegisterMoveEffects(instruction);
  assert.equal(result.completeness, 'exact-with-intrinsic');
  assert.equal(result.metadata?.encodingValidated, true);
  assert.equal(result.metadata?.privilegedRegister, privilegedRegister);
  assert.ok(result.operations.length > 0);
  return result;
}

function assertEncodingMismatch(instruction) {
  const result = liftX86SystemRegisterMoveEffects(instruction);
  assert.equal(result.completeness, 'partial');
  assert.equal(result.unknownEffects?.reason, 'x86-mov-control-debug-encoding-operand-mismatch');
  assert.equal(result.metadata?.encodingValidated, false);
  assert.equal(result.operations.length, 0, 'contradictory encoding/operand evidence must emit no definite operations');
  return result;
}

// Canonical control-register encodings remain exact.
assertExact(systemMove({
  opcode:0x20,
  modrm:0xc0,
  operands:[register('rax', 'write'), register('cr0', 'read')],
}), 'cr0');
assertExact(systemMove({
  rex:0x44,
  opcode:0x20,
  modrm:0xc0,
  operands:[register('rax', 'write'), register('cr8', 'read')],
}), 'cr8');
assertExact(systemMove({
  rex:0x41,
  opcode:0x20,
  modrm:0xc0,
  operands:[register('r8', 'write'), register('cr0', 'read')],
}), 'cr0');
assertExact(systemMove({
  opcode:0x22,
  modrm:0xc0,
  operands:[register('cr0', 'write'), register('rax', 'read')],
}), 'cr0');

// Canonical debug-register read/write pairs remain exact.
assertExact(systemMove({
  opcode:0x21,
  modrm:0xd8,
  operands:[register('rax', 'write'), register('dr3', 'read')],
}), 'dr3');
assertExact(systemMove({
  opcode:0x23,
  modrm:0xd8,
  operands:[register('dr3', 'write'), register('rax', 'read')],
}), 'dr3');

// Raw CR0 must not acquire CR8 identity from contradictory structured detail.
let mismatch = assertEncodingMismatch(systemMove({
  opcode:0x20,
  modrm:0xc0,
  operands:[register('rax', 'write'), register('cr8', 'read')],
}));
assert.equal(mismatch.metadata?.encodedPrivilegedRegister, 'cr0');
assert.equal(mismatch.metadata?.structuredPrivilegedRegister, 'cr8');

// ModRM.r/m and REX.B are authoritative for the ordinary GPR identity.
mismatch = assertEncodingMismatch(systemMove({
  opcode:0x20,
  modrm:0xc0,
  operands:[register('rbx', 'write'), register('cr0', 'read')],
}));
assert.equal(mismatch.metadata?.encodedGeneralPurposeRegister, 'rax');
assert.equal(mismatch.metadata?.structuredGeneralPurposeRegister, 'rbx');
assertEncodingMismatch(systemMove({
  opcode:0x20,
  modrm:0xc0,
  operands:[register('r8', 'write'), register('cr0', 'read')],
}));
assertEncodingMismatch(systemMove({
  opcode:0x22,
  modrm:0xc0,
  operands:[register('cr0', 'write'), register('rbx', 'read')],
}));

// ModRM.reg is authoritative for debug-register identity as well.
mismatch = assertEncodingMismatch(systemMove({
  opcode:0x21,
  modrm:0xd8,
  operands:[register('rax', 'write'), register('dr2', 'read')],
}));
assert.equal(mismatch.metadata?.encodedPrivilegedRegister, 'dr3');
assert.equal(mismatch.metadata?.structuredPrivilegedRegister, 'dr2');

// REX.R has no valid MOV DR identity and must not reach the exact path.
assertEncodingMismatch(systemMove({
  rex:0x44,
  opcode:0x21,
  modrm:0xc0,
  operands:[register('rax', 'write'), register('dr0', 'read')],
}));

console.log('issue-5976 x86 MOV CR/DR encoding/operand identity coherence: ok');
