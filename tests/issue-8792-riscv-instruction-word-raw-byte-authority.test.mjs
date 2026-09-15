import assert from 'node:assert/strict';
import test from 'node:test';

import { decodeRiscv64InstructionWord } from '../js/targets/architecture/riscv64/instruction-word.js';

// #8792: the exported lower-level word decoder must enforce the same strict
// raw-byte input domain as the canonical constructor (#6009). Generic
// `Uint8Array.from()` coercion previously laundered out-of-domain bytes
// (275, '19', 19.9, -237, true, NaN) into the canonical `addi` word 19 and
// turned malformed byte evidence into `supported:true` architectural fields.

test('#8792 genuine valid byte encodings still decode', () => {
  const addi = decodeRiscv64InstructionWord(Uint8Array.of(0x13, 0x00, 0x00, 0x00));
  assert.equal(addi.supported, true);
  assert.equal(addi.op, 'addi');
  assert.equal(addi.word, 0x00000013);
  const arr = decodeRiscv64InstructionWord([0x13, 0x00, 0x00, 0x00]);
  assert.equal(arr.supported, true);
  assert.equal(arr.op, 'addi');
});

test('#8792 out-of-domain byte elements are rejected, not coerced', () => {
  const bad = [
    [275, 0, 0, 0],
    ['19', 0, 0, 0],
    [19.9, 0, 0, 0],
    [-237, 0, 0, 0],
    [true, 0, 0, 0],
    [NaN, 0, 0, 0],
    [{}, 0, 0, 0],
    [null, 0, 0, 0],
  ];
  for (const bytes of bad) {
    assert.throws(
      () => decodeRiscv64InstructionWord(bytes),
      (e) => e instanceof TypeError && /invalid-raw-bytes/.test(e.message),
      `expected reject for ${JSON.stringify(bytes)}`,
    );
  }
});

test('#8792 non-array / non-view inputs fail closed instead of Uint8Array.from laundering', () => {
  for (const input of ['abcd', 0x13, true, Symbol.iterator]) {
    assert.throws(() => decodeRiscv64InstructionWord(input), TypeError);
  }
  // a Map is iterable but not a byte sequence: must not be laundered.
  assert.throws(() => decodeRiscv64InstructionWord(new Map()), TypeError);
});

test('#8792 distinct malformed values no longer collapse onto canonical word 19', () => {
  // 275 and 19 used to both produce word === 19. Now 275 is rejected outright,
  // so a schema-invalid value can never masquerade as a valid instruction.
  assert.throws(() => decodeRiscv64InstructionWord([275, 0, 0, 0]), TypeError);
  assert.equal(decodeRiscv64InstructionWord([19, 0, 0, 0]).word, 19);
});

test('#8792 valid but non-ratified lengths stay unsupported (schema-valid, not invalid)', () => {
  // A well-formed byte sequence that is not a 2/4-byte instruction must remain
  // an explicit unsupported result, never an exception and never coerced.
  const short = decodeRiscv64InstructionWord([0x13, 0x00, 0x00]);
  assert.equal(short.supported, false);
  const empty = decodeRiscv64InstructionWord([]);
  assert.equal(empty.supported, false);
});
