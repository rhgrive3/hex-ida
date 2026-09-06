import assert from 'node:assert/strict';

import { liftX86IntegerEffects } from '../../js/targets/architecture/x86_64/effects/integer.js';
import { liftX86MachineEffects } from '../../js/targets/architecture/x86_64/effects/index.js';

let instructionCode = 0x602100;

function register(registerId, widthBits, access = 'read') {
  return { type:'register', registerId, widthBits, access };
}

function immediate(value, widthBits) {
  return { type:'immediate', value:BigInt(value), widthBits, access:'read' };
}

function integerInstruction(family, operands) {
  instructionCode += 1;
  return {
    address:0x602100n + BigInt(instructionCode),
    length:1,
    rawBytes:Uint8Array.of(0x90),
    mode:'long-64',
    instructionId:`issue-6021-${instructionCode}`,
    instructionCode,
    instructionFamily:family,
    opcodeName:family,
    mnemonic:family,
    detailAvailable:true,
    detailStatus:'complete',
    detail:{
      abiContractVersion:'capstone-5-wasm32-x86-detail/v1',
      operandCount:operands.length,
      operands,
      implicitReads:[],
      implicitWrites:[],
      ...(family.startsWith('cmov') ? { conditionCode:family.slice(4) } : {}),
    },
  };
}

function assertRejected(family, operands, reason) {
  const result = liftX86IntegerEffects(integerInstruction(family, operands));
  assert.equal(result.completeness, 'partial');
  assert.equal(result.unknownEffects?.reason, reason);
  assert.equal(result.operations.length, 0, `${family} width mismatch must fail before definite state operations`);
}

function assertRejectedRouted(family, operands, reason) {
  const result = liftX86MachineEffects(integerInstruction(family, operands));
  assert.equal(result.completeness, 'partial', `${family} malformed shape must stay partial through the public dispatcher`);
  assert.equal(result.unknownEffects?.reason, reason);
  assert.equal(result.operations.length, 0, `${family} malformed shape must not be terminalized into a definite operation`);
}

function assertAccepted(family, operands) {
  const result = liftX86IntegerEffects(integerInstruction(family, operands));
  assert.ok(['exact','exact-with-intrinsic'].includes(result.completeness), `${family} canonical form must remain exact`);
  assert.ok(result.operations.length > 0, `${family} canonical form must emit definite operations`);
}

// Register-register forms require a single architectural operand width.
assertRejected('mov', [register('rax', 64, 'write'), register('al', 8)], 'x86-mov-operand-shape-unmodelled');
assertRejected('mov', [register('al', 8, 'write'), register('rax', 64)], 'x86-mov-operand-shape-unmodelled');
assertRejected('add', [register('rax', 64, 'read-write'), register('al', 8)], 'x86-add-operand-shape-unmodelled');
assertRejected('and', [register('eax', 32, 'read-write'), register('ax', 16)], 'x86-and-operand-shape-unmodelled');
assertRejected('cmp', [register('rax', 64), register('al', 8)], 'x86-cmp-operand-shape-unmodelled');
assertRejected('test', [register('eax', 32), register('ax', 16)], 'x86-test-operand-shape-unmodelled');
assertRejected('imul', [register('rax', 64, 'read-write'), register('eax', 32)], 'x86-imul-two-operand-source-unmodelled');
assertRejected('imul', [register('rax', 64, 'write'), register('eax', 32), immediate(3, 8)], 'x86-imul-three-operand-source-unmodelled');
assertRejected('cmovne', [register('rax', 64, 'read-write'), register('ax', 16)], 'x86-cmovne-operand-shape-unmodelled');

// The same malformed records must stay fail-closed after the canonical
// trusted-decoder terminal, rather than being promoted from a partial result.
for (const [family, operands, reason] of [
  ['mov', [register('rax', 64, 'write'), register('al', 8)], 'x86-mov-operand-shape-unmodelled'],
  ['add', [register('rax', 64, 'read-write'), register('al', 8)], 'x86-add-operand-shape-unmodelled'],
  ['and', [register('eax', 32, 'read-write'), register('ax', 16)], 'x86-and-operand-shape-unmodelled'],
  ['cmp', [register('rax', 64), register('al', 8)], 'x86-cmp-operand-shape-unmodelled'],
  ['test', [register('eax', 32), register('ax', 16)], 'x86-test-operand-shape-unmodelled'],
  ['imul', [register('rax', 64, 'read-write'), register('eax', 32)], 'x86-imul-two-operand-source-unmodelled'],
  ['imul', [register('rax', 64, 'write'), register('eax', 32), immediate(3, 8)], 'x86-imul-three-operand-source-unmodelled'],
  ['cmovne', [register('rax', 64, 'read-write'), register('ax', 16)], 'x86-cmovne-operand-shape-unmodelled'],
]) {
  assertRejectedRouted(family, operands, reason);
}

// Same-width register forms remain exact.
assertAccepted('mov', [register('rax', 64, 'write'), register('rcx', 64)]);
assertAccepted('add', [register('eax', 32, 'read-write'), register('ecx', 32)]);
assertAccepted('cmp', [register('ax', 16), register('cx', 16)]);
assertAccepted('imul', [register('rax', 64, 'read-write'), register('rcx', 64)]);
assertAccepted('imul', [register('rax', 64, 'write'), register('rcx', 64), immediate(3, 8)]);
assertAccepted('cmovne', [register('eax', 32, 'read-write'), register('ecx', 32)]);

// Architectural mixed-width forms and immediates are intentionally unaffected.
assertAccepted('movzx', [register('eax', 32, 'write'), register('al', 8)]);
assertAccepted('movsx', [register('rax', 64, 'write'), register('ax', 16)]);
assertAccepted('movsxd', [register('rax', 64, 'write'), register('eax', 32)]);
assertAccepted('add', [register('rax', 64, 'read-write'), immediate(1, 8)]);

console.log('issue-6021 x86 integer register width coherence: ok');
