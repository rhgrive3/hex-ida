import assert from 'node:assert/strict';

import { liftX86IntegerEffects } from '../../js/targets/architecture/x86_64/effects/integer.js';

let instructionCode = 0x555300;

function register(name, access) {
  return { type:'register', register:name, access };
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

function assertRejectedRegisterCase(family, destination, source) {
  const result = liftRegisters(family, destination, source);
  assert.equal(result.completeness, 'partial', `${family} ${destination}, ${source} must fail closed`);
  assert.equal(result.unknownEffects?.reason, `x86-${family}-operand-shape-unmodelled`);
  assert.equal(result.operations.length, 0, 'illegal width evidence must not emit definite operations');
}

// Architecturally legal register forms stay exact.
assertExactRegisterCase('movzx', 'eax', 'al', 8, 32);
assertExactRegisterCase('movsx', 'rax', 'ax', 16, 64);
assertExactRegisterCase('movsxd', 'ax', 'ax', 16, 16);
assertExactRegisterCase('movsxd', 'eax', 'eax', 32, 32);
assertExactRegisterCase('movsxd', 'rax', 'eax', 32, 64);

// Minimal illegal-width counterexamples from #5553 fail closed.
assertRejectedRegisterCase('movzx', 'rax', 'eax');
assertRejectedRegisterCase('movsx', 'ax', 'eax');
assertRejectedRegisterCase('movsx', 'ax', 'ax');
assertRejectedRegisterCase('movsxd', 'rax', 'ax');
assertRejectedRegisterCase('movsxd', 'ax', 'eax');

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
