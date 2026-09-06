import assert from 'node:assert/strict';

import { liftX86LeaEffects } from '../../js/targets/architecture/x86_64/effects/integer.js';

let instructionCode = 0x601900;

function register(registerId, widthBits, access = 'write') {
  return { type:'register', registerId, widthBits, access };
}

function memory(base = 'rax') {
  return {
    type:'memory',
    widthBits:64,
    access:'read',
    memory:{
      base,
      index:null,
      scale:1,
      displacement:0n,
      addressSizeBits:64,
    },
  };
}

function lea(destination, rawBytes = Uint8Array.of(0x48, 0x8d, 0x00)) {
  instructionCode += 1;
  return {
    address:0x601900n + BigInt(instructionCode),
    length:rawBytes.length,
    rawBytes,
    mode:'long-64',
    instructionId:`issue-6019-${instructionCode}`,
    instructionCode,
    instructionFamily:'lea',
    mnemonic:'lea',
    detailAvailable:true,
    detailStatus:'complete',
    detail:{
      operandCount:2,
      operands:[destination, memory()],
      implicitReads:[],
      implicitWrites:[],
    },
  };
}

function assertExact(destination, rawBytes) {
  const result = liftX86LeaEffects(lea(destination, rawBytes));
  assert.equal(result.completeness, 'exact');
  assert.equal(result.metadata?.operation, 'lea');
  assert.equal(result.metadata?.semanticMemoryAccess, false);
  assert.ok(result.operations.length > 0);
}

function assertRejected(destination) {
  const result = liftX86LeaEffects(lea(destination));
  assert.equal(result.completeness, 'partial');
  assert.equal(result.unknownEffects?.reason, 'x86-lea-operand-shape-unmodelled');
  assert.equal(result.operations.length, 0, 'invalid LEA destinations must fail before materializing an address');
}

// Canonical GPR-family destinations remain exact for every LEA operand size.
assertExact(register('rax', 64));
assertExact(register('eax', 32), Uint8Array.of(0x8d, 0x00));
assertExact(register('ax', 16), Uint8Array.of(0x66, 0x8d, 0x00));
assertExact(register('rsp', 64), Uint8Array.of(0x48, 0x8d, 0x20));

// LEA cannot encode an 8-bit GPR or non-GPR register class as its destination.
assertRejected(register('al', 8));
assertRejected(register('ymm0', 256));
assertRejected(register('zmm0', 512));
assertRejected(register('k0', 64));
assertRejected(register('rip', 64));
assertRejected(register('rflags', 64));

console.log('issue-6019 x86 LEA destination class/width authority: ok');
