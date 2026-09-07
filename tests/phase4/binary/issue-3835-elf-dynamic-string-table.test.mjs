import assert from 'node:assert/strict';
import { ByteView } from '../../../js/binary/reader.js';
import { parseProgramDynamic } from '../../../js/binary/elf-dynamic.js';

const DT_NULL = 0n;
const DT_NEEDED = 1n;
const DT_STRTAB = 5n;
const DT_SYMTAB = 6n;
const DT_STRSZ = 10n;
const DT_SONAME = 14n;
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

function imageFor(bytes) {
  const segment = {
    name: 'LOAD', address: BASE, size: BigInt(bytes.length),
    fileOffset: 0n, fileSize: BigInt(bytes.length),
    perms: { read: true, write: false, execute: false },
  };
  return {
    bits: 64,
    imageBase: BASE,
    metadata: { machine: 62 },
    warnings: [],
    libraries: [],
    imports: [],
    exports: [],
    symbols: [],
    relocations: [],
    functions: [],
    sections: [],
    segments: [segment],
    addressToOffset(address) {
      const delta = BigInt(address) - BASE;
      return delta >= 0n && delta < BigInt(bytes.length) ? delta : null;
    },
    sectionAt() { return null; },
    segmentAt(address) {
      const a = BigInt(address);
      return a >= segment.address && a < segment.address + segment.size ? segment : null;
    },
  };
}

function run(entries, setup = null) {
  const bytes = new Uint8Array(0x200);
  const dynamicSize = writeDynamic64(bytes, entries);
  setup?.(bytes);
  const image = imageFor(bytes);
  parseProgramDynamic(new ByteView(bytes), [{ type: 2, offset: 0n, filesz: BigInt(dynamicSize) }], image, 64);
  return image;
}

function putCString(bytes, offset, text) {
  bytes[offset] = 0;
  const encoded = new TextEncoder().encode(text);
  bytes.set(encoded, offset + 1);
  bytes[offset + 1 + encoded.length] = 0;
}

{
  const image = run([
    [DT_NEEDED, 1n],
    [DT_STRTAB, STRING_VA],
    [DT_STRSZ, 32n],
    [DT_NULL, 0n],
  ], (bytes) => putCString(bytes, STRING_OFF, 'libok.so'));
  assert.equal(image.metadata.programDynamicPartial, undefined);
  assert.deepEqual(image.libraries, ['libok.so']);
}

{
  const image = run([
    [DT_NEEDED, 1n],
    [DT_STRSZ, 32n],
    [DT_NULL, 0n],
  ]);
  assert.equal(image.metadata.programDynamicPartial, true);
  assert.ok(image.metadata.programDynamicDiagnostics.includes('dynamic string table address/size is missing'));
  assert.deepEqual(image.libraries, []);
}

{
  const image = run([
    [DT_NEEDED, 1n],
    [DT_STRTAB, STRING_VA],
    [DT_NULL, 0n],
  ]);
  assert.equal(image.metadata.programDynamicPartial, true);
  assert.ok(image.metadata.programDynamicDiagnostics.includes('dynamic string table address/size is missing'));
  assert.deepEqual(image.libraries, []);
}

{
  const image = run([
    [DT_SONAME, 1n],
    [DT_STRSZ, 32n],
    [DT_NULL, 0n],
  ]);
  assert.equal(image.metadata.programDynamicPartial, true);
  assert.ok(image.metadata.programDynamicDiagnostics.includes('dynamic string table address/size is missing'));
  assert.equal(image.metadata.soname, undefined);
}

{
  const image = run([
    [DT_SYMTAB, BASE + 0x80n],
    [DT_NULL, 0n],
  ]);
  assert.equal(image.metadata.programDynamicPartial, true);
  assert.ok(image.metadata.programDynamicDiagnostics.includes('dynamic string table address/size is missing'));
}

{
  const image = run([[DT_NULL, 0n]]);
  assert.equal(image.metadata.programDynamicPartial, undefined);
  assert.deepEqual(image.metadata.programDynamicDiagnostics, undefined);
}

{
  const image = run([
    [DT_NEEDED, 1n],
    [DT_STRTAB, BASE + 0x1f0n],
    [DT_STRSZ, 32n],
    [DT_NULL, 0n],
  ]);
  assert.equal(image.metadata.programDynamicPartial, true);
  assert.ok(image.metadata.programDynamicDiagnostics.includes('DT_STRTAB/DT_STRSZ crosses a file-backed PT_LOAD boundary'));
}

{
  const image = run([
    [DT_NEEDED, 1n],
    [DT_STRTAB, STRING_VA],
    [DT_STRSZ, 8n],
    [DT_NULL, 0n],
  ], (bytes) => bytes.fill(0x41, STRING_OFF, STRING_OFF + 8));
  assert.equal(image.metadata.programDynamicPartial, true);
  assert.ok(image.metadata.programDynamicDiagnostics.some((reason) => reason.includes('not NUL-terminated within DT_STRSZ')));
}

console.log('issue-3835-elf-dynamic-string-table: PASS');
