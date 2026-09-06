import assert from 'node:assert/strict';

import { liftX86IntegerEffects } from '../../js/targets/architecture/x86_64/effects/integer.js';

let instructionCode = 0x555300;

function register(name, access, widthBits = null) {
  return {
    type:'register',
    register:name,
    access,
    ...(widthBits == null ? {} : { widthBits }),
  };
}

function memory(widthBits) {
  return {
    type:'memory',
    widthBits,
    access:'read',
    memory:{
      base:'rax',
      index:null,
      scale:1,
      displacement:0n,
      addressSizeBits:64,
    },
  };
}

function instruction(family, destination, source) {
  instructionCode += 1;
  return {
    instructionId:`issue-5553-${instructionCode}`,
    instructionCode,
    instructionFamily:family,
    mnemonic:family,
    mode:'long-64',
    address:0x555300n + BigInt(instructionCode),
    length:1,
    rawBytes:Uint8Array.of(0x90),
    detailStatus:'complete',
    detail:{
      operandCount:2,
      operands:[destination, source],
    },
  };
}

function liftRegisters(family, destination, source) {
  return liftX86IntegerEffects(instruction(
    family,
    register(destination, 'write'),
    register(source, 'read'),
  ));
}

function assertExactRegisterCase(family, destination, source, fromBits, toBits) {
  const result = liftRegisters(family, destination, source);
  assert.equal(result.completeness, 'exact', `${family} ${destination}, ${source} should remain exact`);
  assert.equal(result.metadata?.fromBits, fromBits);
  assert.equal(result.metadata?.toBits, toBits);
  assert.equal(result.unknownEffects, undefined);
}

function assertRejectedResult(result, family, label) {
  assert.equal(result.completeness, 'partial', `${label} must fail closed`);
  assert.equal(result.unknownEffects?.reason, `x86-${family}-operand-shape-unmodelled`);
  assert.equal(result.operations.length, 0, 'illegal width evidence must not emit definite operations');
}

function assertRejectedRegisterCase(family, destination, source) {
  assertRejectedResult(
    liftRegisters(family, destination, source),
    family,
    `${family} ${destination}, ${source}`,
  );
}

// The full architecturally valid register width matrix from #5553 stays exact.
for (const [family, destination, source, fromBits, toBits] of [
  ['movzx', 'ax', 'bl', 8, 16],
  ['movzx', 'eax', 'bl', 8, 32],
  ['movzx', 'rax', 'bl', 8, 64],
  ['movzx', 'ax', 'bx', 16, 16],
  ['movzx', 'eax', 'bx', 16, 32],
  ['movzx', 'rax', 'bx', 16, 64],
  ['movsx', 'ax', 'bl', 8, 16],
  ['movsx', 'eax', 'bl', 8, 32],
  ['movsx', 'rax', 'bl', 8, 64],
  ['movsx', 'ax', 'bx', 16, 16],
  ['movsx', 'eax', 'bx', 16, 32],
  ['movsx', 'rax', 'bx', 16, 64],
  ['movsxd', 'ax', 'bx', 16, 16],
  ['movsxd', 'eax', 'ebx', 32, 32],
  ['movsxd', 'rax', 'ebx', 32, 64],
]) {
  assertExactRegisterCase(family, destination, source, fromBits, toBits);
}

// Invalid architectural width pairs from #5553 fail closed.
for (const [family, destination, source] of [
  ['movsxd', 'ax', 'ebx'],
  ['movsxd', 'rax', 'bx'],
  ['movsxd', 'eax', 'bx'],
]) {
  assertRejectedRegisterCase(family, destination, source);
}

// Decoder-shaped register evidence can carry non-GPR widths (for example an
// opmask view). Arbitrary unsupported widths must still be rejected by the
// extension-width authority gate before any definite operation is emitted.
for (const [family, destination, source] of [
  ['movzx', register('k1', 'write', 24), register('al', 'read')],
  ['movsx', register('eax', 'write'), register('k1', 'read', 24)],
]) {
  assertRejectedResult(
    liftX86IntegerEffects(instruction(family, destination, source)),
    family,
    `${family} unsupported 24-bit register shape`,
  );
}

// Memory forms are still owned by the deferred P5-2 memory lane. Both a legal
// and an illegal source width must therefore remain non-definite here; this
// guards against bypassing the width gate by changing operand representation.
for (const [family, destination, widthBits] of [
  ['movzx', 'eax', 8],
  ['movzx', 'rax', 32],
  ['movsx', 'rax', 16],
  ['movsxd', 'rax', 16],
  ['movsxd', 'rax', 32],
]) {
  const result = liftX86IntegerEffects(instruction(
    family,
    register(destination, 'write'),
    memory(widthBits),
  ));
  assert.equal(result.completeness, 'partial');
  assert.equal(result.unknownEffects?.reason, `x86-${family}-memory-form-deferred-to-p5-2`);
  assert.equal(result.operations.length, 0);
}

console.log('issue-5553 x86 move-extension width legality: ok');
