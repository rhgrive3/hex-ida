// Issue #8786 regression: the canonical x86-64 decoded instruction boundary
// must reject out-of-domain rawBytes instead of laundering them into a
// different, valid encoding via `Uint8Array.from` coercion.
import assert from 'node:assert/strict';
import test from 'node:test';

import { createX86DecodedInstruction } from '../js/targets/architecture/x86_64/decoded-instruction.js';

function nopInput(rawBytes) {
  return {
    address: 0x1000n,
    length: 1,
    rawBytes,
    mode: 'long-64',
    instructionCode: 1,
    instructionFamily: 'nop',
    instructionId: 'x86-issue-8786',
    mnemonic: 'nop',
    detailAvailable: true,
    detailStatus: 'complete',
    detail: { operandCount: 0, operands: [], implicitReads: [], implicitWrites: [] },
  };
}

const OUT_OF_DOMAIN = [
  { label: 'integer > 0xff', value: [400] },
  { label: 'negative integer', value: [-112] },
  { label: 'float truncation', value: [144.9] },
  { label: 'numeric string', value: ['144'] },
  { label: 'boolean', value: [true] },
  { label: 'NaN', value: [Number.NaN] },
  { label: 'Infinity', value: [Number.POSITIVE_INFINITY] },
  { label: 'arbitrary object element', value: [{ toString: () => '144' }] },
];

for (const { label, value } of OUT_OF_DOMAIN) {
  test(`#8786 rejects ${label} at rawBytes (${JSON.stringify(value)})`, () => {
    assert.throws(() => createX86DecodedInstruction(nopInput(value)), (err) => (
      err instanceof TypeError
      && err.message === 'x86-decoded-instruction-invalid-raw-bytes'
    ));
  });
}

test('#8786 rejects a rawBytes hole and non-array-like object', () => {
  const holey = [144];
  holey.length = 2;
  assert.throws(() => createX86DecodedInstruction(nopInput(holey)), (err) => (
    err instanceof TypeError && err.message === 'x86-decoded-instruction-invalid-raw-bytes'
  ));
  assert.throws(() => createX86DecodedInstruction(nopInput({ 0: 144, length: 1 })), (err) => (
    err instanceof TypeError && err.message === 'x86-decoded-instruction-invalid-raw-bytes'
  ));
});

test('#8786 still accepts a genuine Uint8Array and a genuine integer byte Array', () => {
  const viaU8 = createX86DecodedInstruction(nopInput(new Uint8Array([0x90])));
  assert.deepEqual([...viaU8.rawBytes], [0x90]);
  assert.equal(viaU8.detailStatus, 'complete');
  const viaArr = createX86DecodedInstruction(nopInput([0x90]));
  assert.deepEqual([...viaArr.rawBytes], [0x90]);
  assert.equal(viaArr.detailStatus, 'complete');
});

test('#8786 rawBytes snapshot is detached from a mutable input Uint8Array', () => {
  const input = new Uint8Array([0x90]);
  const decoded = createX86DecodedInstruction(nopInput(input));
  input[0] = 0x00;
  assert.deepEqual([...decoded.rawBytes], [0x90]);
});

test('#8786 length mismatch still fails closed with the byte-length code', () => {
  assert.throws(
    () => createX86DecodedInstruction(nopInput([0x90, 0x90])),
    (err) => err instanceof TypeError
      && err.message === 'x86-decoded-instruction-byte-length-mismatch',
  );
  assert.throws(
    () => createX86DecodedInstruction(nopInput(null)),
    (err) => err instanceof TypeError
      && err.message === 'x86-decoded-instruction-byte-length-mismatch',
  );
});
