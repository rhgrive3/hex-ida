/**
 * #6115 regression: an Export Ordinal Table entry that indexes at or past
 * NumberOfFunctions has no Export Address Table entry to resolve to. Such a
 * name/ordinal pair must fail closed with a partial reason instead of being
 * silently dropped by the EAT loop and replaced by an ordinal-only fallback.
 */
import assert from 'node:assert/strict';
import { ByteView } from '../js/binary/reader.js';
import { parseExports } from '../js/binary/pe-loader.js';

const IMAGE_BASE = 0x10000000n;
const EXPORT_RVA = 0x1000;
const EXPORT_SIZE = 0x200;
const FILE_OFFSET = 0x100;

function writeCString(bytes, offset, value) {
  bytes.set(Buffer.from(`${value}\0`, 'ascii'), offset);
}

function imageFor() {
  return {
    imageBase: IMAGE_BASE,
    bits: 64,
    sections: [{
      index: 1,
      address: IMAGE_BASE + BigInt(EXPORT_RVA),
      size: 0x3000n,
      fileOffset: BigInt(FILE_OFFSET),
      fileSize: 0xf00n,
      perms: { read: true, write: false, execute: true },
    }],
    segments: [],
    metadata: {},
    warnings: [],
    symbols: [],
    functions: [],
    imports: [],
    exports: [],
    relocations: [],
    libraries: [],
    sectionAt(address) {
      const a = BigInt(address);
      const section = this.sections[0];
      return a >= section.address && a < section.address + section.size ? section : null;
    },
  };
}

const bytes = new Uint8Array(0x1000);
const dv = new DataView(bytes.buffer);
const at = (rva) => FILE_OFFSET + (rva - EXPORT_RVA);
const header = at(EXPORT_RVA);

// One EAT slot: a valid export RVA. One name whose ordinal row is corrupt.
dv.setUint32(header + 12, 0x1100, true); // DLL name
dv.setUint32(header + 16, 1, true);      // ordinal base
dv.setUint32(header + 20, 1, true);      // NumberOfFunctions = 1
dv.setUint32(header + 24, 1, true);      // NumberOfNames = 1
dv.setUint32(header + 28, 0x1040, true); // EAT
dv.setUint32(header + 32, 0x1050, true); // name pointers
dv.setUint32(header + 36, 0x1070, true); // name ordinals

dv.setUint32(at(0x1040), 0x2000, true);
dv.setUint32(at(0x1050), 0x1120, true);
dv.setUint16(at(0x1070), 1, true); // invalid: the only valid index is 0
writeCString(bytes, at(0x1100), 'corrupt.dll');
writeCString(bytes, at(0x1120), 'Foo');

// 1. Out-of-range ordinal: the name must not silently vanish and be mistaken
//    for an ordinal-only export; the parse records a partial reason.
{
  const image = imageFor();
  parseExports(new ByteView(bytes), { rva: EXPORT_RVA, size: EXPORT_SIZE }, image);
  assert.equal(image.exports.length, 1);
  assert.equal(image.exports[0].name, '#1');
  assert.equal(image.metadata.peMetadata.complete, false);
  assert.ok(image.metadata.peMetadata.reasons.includes('exports:name-ordinal-range'));
  assert.ok(image.warnings.some((w) => /ordinal-table index 1/.test(w)));
}

// 2. In-range ordinal (0): the named export resolves normally, no partial.
{
  const valid = bytes.slice();
  const validDv = new DataView(valid.buffer);
  validDv.setUint16(at(0x1070), 0, true);
  const image = imageFor();
  parseExports(new ByteView(valid), { rva: EXPORT_RVA, size: EXPORT_SIZE }, image);
  assert.deepEqual(image.exports.map((entry) => entry.name), ['Foo']);
  assert.equal(image.exports[0].address, IMAGE_BASE + 0x2000n);
  assert.equal(image.metadata.peMetadata?.complete, true);
  assert.equal(image.warnings.length, 0);
}

// 3. Forwarder exports apply the same ordinal range validation.
{
  const forwarder = bytes.slice();
  const forwarderDv = new DataView(forwarder.buffer);
  forwarderDv.setUint32(at(0x1040), 0x1180, true); // EAT[0] points inside the directory
  writeCString(forwarder, at(0x1180), 'other.Target');
  const image = imageFor();
  parseExports(new ByteView(forwarder), { rva: EXPORT_RVA, size: EXPORT_SIZE }, image);
  assert.equal(image.exports.length, 1);
  assert.equal(image.exports[0].name, '#1');
  assert.equal(image.exports[0].kind, 'forwarder');
  assert.equal(image.metadata.peMetadata.complete, false);
  assert.ok(image.metadata.peMetadata.reasons.includes('exports:name-ordinal-range'));
}

// 4. Multiple names on one valid EAT index keep the existing alias policy.
{
  const aliases = bytes.slice();
  const aliasesDv = new DataView(aliases.buffer);
  aliasesDv.setUint32(header + 24, 2, true); // NumberOfNames = 2
  aliasesDv.setUint32(at(0x1050), 0x1120, true);
  aliasesDv.setUint32(at(0x1054), 0x1128, true);
  aliasesDv.setUint16(at(0x1070), 0, true);
  aliasesDv.setUint16(at(0x1072), 0, true);
  writeCString(aliases, at(0x1120), 'Foo');
  writeCString(aliases, at(0x1128), 'Bar');
  const image = imageFor();
  parseExports(new ByteView(aliases), { rva: EXPORT_RVA, size: EXPORT_SIZE }, image);
  assert.deepEqual(image.exports.map((entry) => entry.name), ['Foo', 'Bar']);
  assert.equal(image.metadata.peMetadata?.complete, true);
}

console.log('issue #6115 PE export ordinal range validation: PASS');
