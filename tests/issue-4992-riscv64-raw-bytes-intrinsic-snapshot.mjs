import test from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';

import { createRiscv64DecodedInstruction } from '../js/targets/architecture/riscv64/decoded-instruction.js';

const ADDI = [0x13, 0x00, 0x00, 0x00];
const JAL = [0x6f, 0x00, 0x00, 0x00];

function decode(rawBytes, overrides = {}) {
  return createRiscv64DecodedInstruction({
    address: 0x1000n,
    size: 4,
    rawBytes,
    mode: 'rv64imc',
    ...overrides,
  });
}

function hex(bytes) {
  return [...bytes].map((byte) => byte.toString(16)).join(',');
}

// A `Uint8Array` view whose intrinsic backing store says `addi` must never be
// republished as another instruction because the view overrode `@@iterator`.
test('4992: iterator-overriding Uint8Array view cannot forge authoritative bytes', () => {
  class IteratorForge extends Uint8Array {
    [Symbol.iterator]() { return JAL[Symbol.iterator](); }
  }
  const view = new Uint8Array(ADDI);
  Object.setPrototypeOf(view, IteratorForge.prototype);
  assert.equal(hex(Uint8Array.prototype.values.call(view)), '13,0,0,0', 'fixture backing store');

  const decoded = decode(view);
  assert.equal(hex(decoded.rawBytes), '13,0,0,0', 'intrinsic backing bytes must win over @@iterator');
  assert.equal(decoded.fields.op, 'addi');
  assert.equal(decoded.instructionFamily, 'addi');
});

// Same authority requirement when the caller overrides the prototype `set`.
test('4992: patched Uint8Array.prototype.set cannot forge authoritative bytes', () => {
  const originalSet = Uint8Array.prototype.set;
  Uint8Array.prototype.set = function forged(source) {
    return originalSet.call(this, JAL.slice(0, this.length));
  };
  try {
    const decoded = decode(Uint8Array.of(...ADDI));
    assert.equal(hex(decoded.rawBytes), '13,0,0,0', 'boundary must use its captured intrinsic set');
    assert.equal(decoded.instructionFamily, 'addi');
  } finally {
    Uint8Array.prototype.set = originalSet;
  }
});

// Accessor elements must be rejected without ever invoking the getter.
test('4992: accessor array elements fail closed without being invoked', () => {
  let reads = 0;
  const accessor = [0, 0, 0, 0];
  Object.defineProperty(accessor, 0, {
    configurable: true,
    enumerable: true,
    get() { reads += 1; return 0x13; },
  });

  assert.throws(
    () => decode(accessor),
    (error) => error instanceof TypeError
      && error.message === 'riscv64-decoded-instruction-invalid-raw-bytes',
  );
  assert.equal(reads, 0, 'raw-byte authority must not invoke caller getters');
});

// `byteLength` must be read intrinsically, never through a caller-controlled accessor.
test('4992: forged byteLength accessor cannot reject a real view', () => {
  class ShortByteLengthForge extends Uint8Array {
    get byteLength() { return 2; }
  }
  const view = new Uint8Array(ADDI);
  Object.setPrototypeOf(view, ShortByteLengthForge.prototype);
  const decoded = decode(view);
  assert.equal(hex(decoded.rawBytes), '13,0,0,0');
  assert.equal(decoded.instructionFamily, 'addi');

  class WideByteLengthForge extends Uint8Array {
    get byteLength() { return 4; }
  }
  const compressed = new Uint8Array([0x01, 0x00]);
  Object.setPrototypeOf(compressed, WideByteLengthForge.prototype);
  const fromCompressed = decode(compressed, { size: 2 });
  assert.equal(hex(fromCompressed.rawBytes), '1,0');
  assert.equal(fromCompressed.instructionFamily, 'nop', 'intrinsic byteLength must win over the accessor');
});

// Cross-realm (decoder bridge) Uint8Array views remain accepted, defensively copied.
test('4992: cross-realm Uint8Array view is accepted from its intrinsic bytes', () => {
  const foreign = runInNewContext('new Uint8Array([0x13, 0x00, 0x00, 0x00])');
  const decoded = decode(foreign);
  assert.equal(decoded.instructionFamily, 'addi');
  foreign[0] = 0x6f;
  assert.equal(hex(decoded.rawBytes), '13,0,0,0', 'cross-realm snapshot must be defensive');
});

// Element-domain failures use the canonical plural boundary code.
test('4992: malformed structured elements fail closed with the boundary code', () => {
  const malformed = [
    ['19', 0, 0, 0],
    [275, 0, 0, 0],
    [-237, 0, 0, 0],
    [19.5, 0, 0, 0],
    [true, 0, 0, 0],
    [NaN, 0, 0, 0],
    [{ valueOf: () => 0x13 }, 0, 0, 0],
  ];
  for (const [caseIndex, rawBytes] of malformed.entries()) {
    assert.throws(
      () => decode(rawBytes),
      (error) => error instanceof TypeError
        && error.message === 'riscv64-decoded-instruction-invalid-raw-bytes',
      `malformed element case ${caseIndex} must fail closed before authoritative decode`,
    );
  }
});

// Valid authorities keep decoding exactly as before.
test('4992: canonical Uint8Array and number[] inputs stay accepted', () => {
  assert.equal(decode(Uint8Array.of(...ADDI)).instructionFamily, 'addi');
  assert.equal(decode([...ADDI]).instructionFamily, 'addi');
  const mutable = [0x13, 0x00, 0x00, 0x00];
  const decoded = decode(mutable);
  mutable[0] = 0x6f;
  assert.equal(hex(decoded.rawBytes), '13,0,0,0', 'number[] must be copied before becoming authority');
});
