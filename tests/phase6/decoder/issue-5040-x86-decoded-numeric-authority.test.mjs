import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createX86DecodedInstruction,
  x86DecodedInstructionIsStructured,
} from '../../../js/targets/architecture/x86_64/decoded-instruction.js';

function baseInstruction(overrides = {}) {
  return {
    address:0x1000n,
    length:1,
    rawBytes:Uint8Array.of(0x90),
    mode:'long-64',
    instructionCode:1,
    instructionFamily:'nop',
    mnemonic:'nop',
    detailStatus:'complete',
    detail:{ operandCount:0, operands:[] },
    ...overrides,
  };
}

function immediateInstruction(overrides = {}) {
  return baseInstruction({
    detail:{
      operandCount:1,
      operands:[{
        type:'immediate',
        widthBits:64,
        access:'read',
        value:1n,
        encodedWidthBits:8,
        ...overrides,
      }],
    },
  });
}

function memoryInstruction(overrides = {}) {
  return baseInstruction({
    detail:{
      operandCount:1,
      operands:[{
        type:'memory',
        widthBits:64,
        access:'read',
        memory:{
          scale:1,
          displacement:16n,
          addressSizeBits:64,
          ...overrides,
        },
      }],
    },
  });
}

test('x86 decoded numeric authority accepts canonical Capstone primitive types', () => {
  const decoded = createX86DecodedInstruction(immediateInstruction());
  assert.equal(decoded.address, 0x1000n);
  assert.equal(decoded.length, 1);
  assert.equal(decoded.instructionCode, 1);
  assert.equal(decoded.detail.operandCount, 1);
  assert.equal(decoded.detail.operands[0].widthBits, 64);
  assert.equal(decoded.detail.operands[0].value, 1n);
  assert.equal(decoded.detail.operands[0].encodedWidthBits, 8);
  assert.equal(decoded.detailAvailable, true);
});

test('strict bigint authority preserves the established omitted displacement default', () => {
  const decoded = createX86DecodedInstruction(memoryInstruction({ displacement:undefined }));
  assert.equal(decoded.detail.operands[0].memory.displacement, 0n);
  assert.equal(decoded.detail.operands[0].memory.scale, 1);
  assert.equal(decoded.detail.operands[0].memory.addressSizeBits, 64);

  const aliased = createX86DecodedInstruction(memoryInstruction({ displacement:undefined, disp:8n }));
  assert.equal(aliased.detail.operands[0].memory.displacement, 8n);
});

test('top-level safe-integer fields reject coercible boolean, array, and string values', () => {
  for (const value of [true, [1], '1']) {
    assert.throws(
      () => createX86DecodedInstruction(baseInstruction({ length:value })),
      /x86-decoded-instruction-invalid-length/,
    );
    assert.throws(
      () => createX86DecodedInstruction(baseInstruction({ instructionCode:value })),
      /x86-decoded-instruction-id-required/,
    );
  }

  for (const value of [false, [0], '0']) {
    const input = baseInstruction({ detail:{ operandCount:value, operands:[] } });
    assert.throws(
      () => createX86DecodedInstruction(input),
      /x86-decoded-instruction-invalid-operand-count/,
    );
  }
});

test('instruction address rejects values that BigInt coercion previously laundered', () => {
  for (const value of [true, ['16'], '16', 16]) {
    assert.throws(
      () => createX86DecodedInstruction(baseInstruction({ address:value })),
      /x86-decoded-instruction-address-required/,
    );
  }
});

test('immediate numeric fields reject non-canonical representations', () => {
  for (const value of [true, ['16'], '16', 16]) {
    assert.throws(
      () => createX86DecodedInstruction(immediateInstruction({ value })),
      /x86-decoded-instruction-invalid-immediate/,
    );
  }

  for (const value of [[8], '8', true]) {
    assert.throws(
      () => createX86DecodedInstruction(immediateInstruction({ encodedWidthBits:value })),
      /x86-decoded-instruction-invalid-immediate-width/,
    );
  }

  for (const value of [[64], '64', true]) {
    assert.throws(
      () => createX86DecodedInstruction(immediateInstruction({ widthBits:value })),
      /x86-decoded-instruction-invalid-operand-width/,
    );
  }
});

test('memory numeric fields reject array, boolean, string, null, and Number-to-BigInt coercion', () => {
  for (const value of [[2], '2', true]) {
    assert.throws(
      () => createX86DecodedInstruction(memoryInstruction({ scale:value })),
      /x86-decoded-instruction-invalid-memory-scale/,
    );
  }

  for (const value of [null, true, ['16'], '16', 16]) {
    assert.throws(
      () => createX86DecodedInstruction(memoryInstruction({ displacement:value })),
      /x86-decoded-instruction-invalid-displacement/,
    );
  }

  for (const value of [[64], '64', true]) {
    assert.throws(
      () => createX86DecodedInstruction(memoryInstruction({ addressSizeBits:value })),
      /x86-decoded-instruction-invalid-address-size/,
    );
  }
});

test('REX safe-integer authority rejects coercible prefix values', () => {
  for (const rex of [[0x48], '72', true]) {
    const input = baseInstruction({
      detail:{ operandCount:0, operands:[], prefixes:{ rex } },
    });
    assert.throws(
      () => createX86DecodedInstruction(input),
      /x86-decoded-instruction-invalid-rex/,
    );
  }
});

test('malformed numeric authority never reports a structured exact instruction', () => {
  assert.equal(x86DecodedInstructionIsStructured(baseInstruction({ address:true })), false);
  assert.equal(x86DecodedInstructionIsStructured(immediateInstruction({ value:['16'] })), false);
  assert.equal(x86DecodedInstructionIsStructured(memoryInstruction({ displacement:true })), false);
  assert.equal(x86DecodedInstructionIsStructured(memoryInstruction({ displacement:null })), false);
});
