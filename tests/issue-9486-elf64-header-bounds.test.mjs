// Regression tests for Issue #9486:
// parseELF must not throw an uncaught DataView RangeError on truncated ELF64 inputs between 52 and 63 bytes.
import assert from 'node:assert/strict';
import { parseELF as parseELFCore } from '../js/binary/elf-core.js';
import { parseELF } from '../js/binary/elf.js';

for (let size = 52; size < 64; size++) {
  const buf = new Uint8Array(size);
  buf.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1]); // ELF64, Little-Endian, version 1
  buf[20] = 1; // Header version 1

  // Directly via elf-core parseELF
  assert.throws(
    () => parseELFCore(buf),
    (err) => {
      // Must not throw RangeError (DataView bounds)
      assert.notEqual(err.name, 'RangeError');
      return true;
    },
    `elf-core parseELF threw RangeError on ${size}-byte ELF64 buffer`
  );

  // Via top-level binary/elf.js parseELF
  assert.throws(
    () => parseELF(buf),
    (err) => {
      assert.notEqual(err.name, 'RangeError');
      return true;
    },
    `binary/elf parseELF threw RangeError on ${size}-byte ELF64 buffer`
  );
}

console.log('issue #9486 regression passed');
