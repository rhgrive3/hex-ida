import assert from 'node:assert/strict';

import { createRiscv64DecodedInstruction } from '../../js/targets/architecture/riscv64/decoded-instruction.js';

function decode(rawBytes) {
  return createRiscv64DecodedInstruction({
    address: 0x1000n,
    size: 4,
    rawBytes,
    mode: 'rv64imc',
  });
}

const canonicalArray = [0x13, 0x00, 0x00, 0x00];
const fromArray = decode(canonicalArray);
assert.equal(fromArray.fields.supported, true);
assert.equal(fromArray.fields.op, 'addi');
assert.equal(fromArray.instructionFamily, 'addi');
assert.equal(fromArray.detailStatus, 'complete');
assert.deepEqual([...fromArray.rawBytes], [0x13, 0x00, 0x00, 0x00]);

canonicalArray[0] = 0x6f;
assert.deepEqual([...fromArray.rawBytes], [0x13, 0x00, 0x00, 0x00], 'canonical number[] must be copied before becoming authoritative');

const canonicalTyped = Uint8Array.of(0x13, 0x00, 0x00, 0x00);
const fromTyped = decode(canonicalTyped);
canonicalTyped[0] = 0x6f;
assert.equal(fromTyped.fields.op, 'addi');
assert.deepEqual([...fromTyped.rawBytes], [0x13, 0x00, 0x00, 0x00], 'Uint8Array authority must remain defensively copied');

const sparse = new Array(4);
sparse[0] = 0x13;
sparse[1] = 0x00;
sparse[3] = 0x00;

const coercibleObject = {
  0: { valueOf: () => 0x13 },
  1: 0,
  2: 0,
  3: 0,
  length: 4,
};

let statefulReads = 0;
const statefulAccessor = [0, 0, 0, 0];
Object.defineProperty(statefulAccessor, 0, {
  configurable: true,
  enumerable: true,
  get() {
    statefulReads += 1;
    return statefulReads === 1 ? 0x13 : '19';
  },
});

const malformed = [
  ['19', 0, 0, 0],
  [275, 0, 0, 0],
  [-237, 0, 0, 0],
  [19.5, 0, 0, 0],
  [true, 0, 0, 0],
  [NaN, 0, 0, 0],
  [{ valueOf: () => 0x13 }, 0, 0, 0],
  sparse,
  coercibleObject,
  new Uint16Array([0x13, 0, 0, 0]),
  statefulAccessor,
];

for (const rawBytes of malformed) {
  assert.throws(
    () => decode(rawBytes),
    (error) => error instanceof TypeError
      && error.message === 'riscv64-decoded-instruction-invalid-raw-bytes',
    `malformed rawBytes must fail closed before authoritative decode: ${String(rawBytes)}`,
  );
}
assert.equal(statefulReads, 0, 'raw-byte authority must reject accessors without invoking them');

console.log('issue-4992-riscv64-raw-byte-authority: ok');
