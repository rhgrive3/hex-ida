import assert from 'node:assert/strict';
import test from 'node:test';

import { createX86DecodedInstruction } from '../../js/targets/architecture/x86_64/decoded-instruction.js';

/* Numeric fields at the decoder trust boundary must be exact primitive
 * numbers/bigints. `Number()`/`BigInt()` coercion accepted booleans, arrays
 * and arbitrary objects as canonical length/address/width authority
 * (`Number(true)===1`, `BigInt(['16'])===16n`), promoting schema-invalid
 * provider records into valid structured instructions (#5040). */

function base(extra = {}) {
  return {
    address: 0n,
    length: 1,
    rawBytes: Uint8Array.of(0x90),
    mode: 'long-64',
    instructionId: 'nop',
    instructionCode: 1,
    instructionFamily: 'nop',
    mnemonic: 'nop',
    detailAvailable: true,
    detailStatus: 'complete',
    detail: { operandCount: 0, operands: [], implicitReads: [], implicitWrites: [] },
    ...extra,
  };
}

test('boolean numeric fields fail closed instead of coercing to 0/1', () => {
  for (const [field, value] of [
    ['address', true],
    ['address', false],
    ['length', true],
    ['instructionCode', true],
  ]) {
    assert.throws(
      () => createX86DecodedInstruction(base({ [field]: value })),
      TypeError,
      `${field}=${value} must be rejected without Number() coercion`,
    );
  }
  assert.throws(
    () => createX86DecodedInstruction(base({ detail: { operandCount: false, operands: [] } })),
    TypeError,
    'detail.operandCount=false must be rejected without coercion',
  );
});

test('array and object numeric evidence is not laundered through BigInt()', () => {
  for (const coerced of [[16], ['16'], { toString: () => '16' }]) {
    assert.throws(
      () => createX86DecodedInstruction(base({ address: coerced })),
      TypeError,
      `array/object address ${JSON.stringify(String(coerced))} must be rejected`,
    );
  }
});

test('exact primitive numerics keep building canonical records', () => {
  const fromNumber = createX86DecodedInstruction(base({ address: 4096, length: 1 }));
  assert.equal(fromNumber.address, 4096n);
  assert.equal(fromNumber.length, 1);

  const fromBigint = createX86DecodedInstruction(base({ address: 4096n }));
  assert.equal(fromBigint.address, 4096n);

  const fromHexText = createX86DecodedInstruction(base({ address: '0x1000' }));
  assert.equal(fromHexText.address, 4096n);
});
