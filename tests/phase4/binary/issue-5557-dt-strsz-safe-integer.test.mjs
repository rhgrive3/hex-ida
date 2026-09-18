/**
 * #5557 — DT_STRSZ beyond the safe-integer domain must fail closed.
 *
 * A DT_STRSZ that exists but cannot be represented as a safe integer was
 * converted to `null`, and the `strSize > 0` span gate silently skipped every
 * diagnostic: DT_NEEDED/SONAME metadata vanished while the parse stayed
 * complete-looking. Absent/zero sizes keep their existing policies.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { ByteView } from '../../../js/binary/reader.js';
import { parseProgramDynamic } from '../../../js/binary/elf-dynamic.js';

const DT_NULL = 0n;
const DT_NEEDED = 1n;
const DT_STRTAB = 5n;
const DT_STRSZ = 10n;
const BASE = 0x400000n;
const STRING_OFF = 0x100;
const STRING_VA = BASE + BigInt(STRING_OFF);

function writeDynamic64(bytes, entries) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  entries.forEach(([tag, value], index) => {
    const off = index * 16;
    view.setBigInt64(off, BigInt(tag), true);
    view.setBigUint64(off + 8, BigInt(value), true);
  });
  return entries.length * 16;
}

function run(entries) {
  const bytes = new Uint8Array(0x200);
  const dynamicSize = writeDynamic64(bytes, entries);
  bytes[STRING_OFF] = 0;
  bytes.set(new TextEncoder().encode('libx.so'), STRING_OFF + 1);
  bytes[STRING_OFF + 8] = 0;
  const segment = {
    address: BASE, size: BigInt(bytes.length), fileOffset: 0n, fileSize: BigInt(bytes.length),
    perms: { read: true, write: false, execute: false },
  };
  const image = {
    bits: 64, imageBase: BASE, metadata: { machine: 62 }, warnings: [],
    libraries: [], imports: [], exports: [], symbols: [], relocations: [], functions: [], sections: [],
    segments: [segment],
    addressToOffset(address) {
      const d = BigInt(address) - BASE;
      return d >= 0n && d < BigInt(bytes.length) ? d : null;
    },
    sectionAt() { return null; },
    segmentAt(address) {
      return address >= BASE && address < BASE + segment.size ? segment : null;
    },
  };
  parseProgramDynamic(new ByteView(bytes), [{ type: 2, offset: 0n, filesz: BigInt(dynamicSize) }], image, 64);
  return image;
}

test('#5557: DT_STRSZ absent keeps the existing missing-string-table policy', () => {
  const image = run([
    [DT_NEEDED, 1n],
    [DT_STRTAB, STRING_VA],
    [DT_NULL, 0n],
  ]);
  assert.equal(image.metadata.programDynamicPartial, true);
  assert.ok(image.metadata.programDynamicDiagnostics.includes('dynamic string table address/size is missing'));
  assert.ok(!image.metadata.programDynamicDiagnostics.some((d) => d.includes('safely representable')));
});

test('#5557: DT_STRSZ=0 produces no safe-integer diagnostic', () => {
  const image = run([
    [DT_NEEDED, 1n],
    [DT_STRTAB, STRING_VA],
    [DT_STRSZ, 0n],
    [DT_NULL, 0n],
  ]);
  assert.ok(!(image.metadata.programDynamicDiagnostics || []).some((d) => d.includes('safely representable')));
});

test('#5557: a mapped in-range DT_STRSZ still decodes DT_NEEDED', () => {
  const image = run([
    [DT_NEEDED, 1n],
    [DT_STRTAB, STRING_VA],
    [DT_STRSZ, 32n],
    [DT_NULL, 0n],
  ]);
  assert.equal(image.metadata.programDynamicPartial, undefined);
  assert.deepEqual(image.libraries, ['libx.so']);
});

test('#5557: DT_STRSZ=2^53 is a conversion failure recorded as partial', () => {
  const image = run([
    [DT_NEEDED, 1n],
    [DT_STRTAB, STRING_VA],
    [DT_STRSZ, 0x20000000000000n],
    [DT_NULL, 0n],
  ]);
  assert.equal(image.metadata.programDynamicPartial, true);
  assert.ok(image.metadata.programDynamicDiagnostics.some((d) =>
    d.includes('DT_STRSZ') && d.includes('not a safely representable file span')));
  assert.deepEqual(image.libraries, [], 'no strings are decodable without a representable span');
});

test('#5557: a representable-but-unmapped size keeps the existing span partial', () => {
  const image = run([
    [DT_NEEDED, 1n],
    [DT_STRTAB, STRING_VA],
    [DT_STRSZ, 0x10000n],
    [DT_NULL, 0n],
  ]);
  assert.equal(image.metadata.programDynamicPartial, true);
  assert.ok(image.metadata.programDynamicDiagnostics.includes('DT_STRTAB/DT_STRSZ crosses a file-backed PT_LOAD boundary'));
});
