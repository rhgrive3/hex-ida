import assert from 'node:assert/strict';
import { ByteView } from '../js/binary/reader.js';
import { parseExports } from '../js/binary/pe-loader.js';
import { parsePE } from '../js/binary/pe.js';

const IMAGE_BASE = 0x10000000n;
const EXPORT_RVA = 0x1000;
const EXPORT_SIZE = 0x200;
const FILE_OFFSET = 0x100;

function writeCString(bytes, offset, value) {
  bytes.set(Buffer.from(`${value}\0`, 'ascii'), offset);
}

function imageFor(section) {
  return {
    imageBase: IMAGE_BASE,
    bits: 64,
    sections: [section],
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
      return a >= section.address && a < section.address + section.size ? section : null;
    },
  };
}

const bytes = new Uint8Array(0x1000);
const dv = new DataView(bytes.buffer);
const section = {
  index: 1,
  address: IMAGE_BASE + BigInt(EXPORT_RVA),
  size: 0x3000n,
  fileOffset: BigInt(FILE_OFFSET),
  fileSize: 0xf00n,
  perms: { read: true, write: false, execute: true },
};
const image = imageFor(section);
const at = (rva) => FILE_OFFSET + (rva - EXPORT_RVA);
const header = at(EXPORT_RVA);

// Three EAT slots: a normal export with two aliases, a forwarder with two
// aliases, and one ordinal-only export. The sixth name has an invalid EAT index.
dv.setUint32(header + 12, 0x1100, true); // DLL name
dv.setUint32(header + 16, 1, true);      // ordinal base
dv.setUint32(header + 20, 3, true);      // NumberOfFunctions
dv.setUint32(header + 24, 6, true);      // NumberOfNames
dv.setUint32(header + 28, 0x1040, true); // EAT
dv.setUint32(header + 32, 0x1050, true); // name pointers
dv.setUint32(header + 36, 0x1070, true); // name ordinals

dv.setUint32(at(0x1040), 0x2000, true);
dv.setUint32(at(0x1044), 0x1180, true);
dv.setUint32(at(0x1048), 0x2100, true);

const names = [
  ['AliasA', 0],
  ['AliasB', 0],
  ['DuplicateAlias', 0],
  ['DuplicateAlias', 0],
  ['ForwardA', 1],
  ['ForwardB', 1],
];
const stringRvas = [0x1120, 0x1128, 0x1130, 0x1140, 0x1150, 0x1160];
for (let i = 0; i < names.length; i++) {
  dv.setUint32(at(0x1050) + i * 4, stringRvas[i], true);
  dv.setUint16(at(0x1070) + i * 2, names[i][1], true);
  writeCString(bytes, at(stringRvas[i]), names[i][0]);
}
writeCString(bytes, at(0x1100), 'aliases.dll');
writeCString(bytes, at(0x1180), 'other.Target');

parseExports(new ByteView(bytes), { rva: EXPORT_RVA, size: EXPORT_SIZE }, image);

const normal = image.exports.filter((entry) => entry.ordinal === 1);
assert.deepEqual(normal.map((entry) => entry.name), ['AliasA', 'AliasB', 'DuplicateAlias']);
assert.ok(normal.every((entry) => entry.kind === 'export'));
assert.ok(normal.every((entry) => entry.address === IMAGE_BASE + 0x2000n));

const forwarders = image.exports.filter((entry) => entry.ordinal === 2);
assert.deepEqual(forwarders.map((entry) => entry.name), ['ForwardA', 'ForwardB']);
assert.ok(forwarders.every((entry) => entry.kind === 'forwarder'));
assert.ok(forwarders.every((entry) => entry.forwarder === 'other.Target'));

const ordinalOnly = image.exports.filter((entry) => entry.ordinal === 3);
assert.deepEqual(ordinalOnly, [{
  name: '#3',
  address: IMAGE_BASE + 0x2100n,
  ordinal: 3,
  kind: 'export',
  source: 'PE-export',
}]);

// Alias materialization must not multiply high-confidence function seeds for
// one EAT slot. The first name-table entry remains the deterministic display name.
assert.equal(image.functions.filter((entry) => entry.address === IMAGE_BASE + 0x2000n).length, 1);
assert.equal(image.functions.find((entry) => entry.address === IMAGE_BASE + 0x2000n)?.name, 'AliasA');

// Out-of-range name ordinals are not public aliases. Reuse a fresh image so the
// invalid row cannot be masked by a valid one.
const invalidBytes = bytes.slice();
const invalidDv = new DataView(invalidBytes.buffer);
invalidDv.setUint32(header + 24, 1, true);
invalidDv.setUint32(at(0x1050), 0x1170, true);
invalidDv.setUint16(at(0x1070), 9, true);
writeCString(invalidBytes, at(0x1170), 'InvalidOrdinal');
const invalidImage = imageFor(section);
parseExports(new ByteView(invalidBytes), { rva: EXPORT_RVA, size: EXPORT_SIZE }, invalidImage);
assert.equal(invalidImage.exports.some((entry) => entry.name === 'InvalidOrdinal'), false);
assert.deepEqual(invalidImage.exports.map((entry) => entry.name), ['#1', '#2', '#3']);

// End-to-end parsePE coverage: reconcileExportFunctionEvidence() must not
// replace the stable first public alias with the last alias at the same address.
function u16(target, offset, value) {
  target[offset] = value & 0xff;
  target[offset + 1] = (value >>> 8) & 0xff;
}
function u32(target, offset, value) {
  target[offset] = value & 0xff;
  target[offset + 1] = (value >>> 8) & 0xff;
  target[offset + 2] = (value >>> 16) & 0xff;
  target[offset + 3] = (value >>> 24) & 0xff;
}
function u64(target, offset, value) {
  let n = BigInt(value);
  for (let i = 0; i < 8; i++) {
    target[offset + i] = Number(n & 0xffn);
    n >>= 8n;
  }
}
function makeAliasPE() {
  const target = new Uint8Array(0x3400);
  const pe = 0x80;
  const coff = pe + 4;
  const optional = coff + 20;
  const optionalSize = 0xf0;
  const sectionHeader = optional + optionalSize;
  const sectionFileOffset = 0x200;
  const rvaToFile = (rva) => sectionFileOffset + (rva - 0x1000);

  u16(target, 0, 0x5a4d);
  u32(target, 0x3c, pe);
  u32(target, pe, 0x00004550);
  u16(target, coff, 0x8664);
  u16(target, coff + 2, 1);
  u16(target, coff + 16, optionalSize);
  u16(target, optional, 0x20b);
  u32(target, optional + 16, 0x2000); // entrypoint corroborates the export
  u64(target, optional + 24, IMAGE_BASE);
  u32(target, optional + 32, 0x1000);
  u32(target, optional + 36, 0x200);
  u32(target, optional + 56, 0x4000);
  u32(target, optional + 60, 0x200);
  u16(target, optional + 68, 3);
  u32(target, optional + 108, 16);
  u32(target, optional + 112, EXPORT_RVA);
  u32(target, optional + 116, EXPORT_SIZE);

  target.set(Buffer.from('.text\0\0\0', 'ascii'), sectionHeader);
  u32(target, sectionHeader + 8, 0x3000);
  u32(target, sectionHeader + 12, 0x1000);
  u32(target, sectionHeader + 16, 0x3000);
  u32(target, sectionHeader + 20, sectionFileOffset);
  u32(target, sectionHeader + 36, 0x60000020);

  const exportHeader = rvaToFile(EXPORT_RVA);
  u32(target, exportHeader + 12, 0x1100);
  u32(target, exportHeader + 16, 1);
  u32(target, exportHeader + 20, 1);
  u32(target, exportHeader + 24, 2);
  u32(target, exportHeader + 28, 0x1040);
  u32(target, exportHeader + 32, 0x1050);
  u32(target, exportHeader + 36, 0x1060);
  u32(target, rvaToFile(0x1040), 0x2000);
  u32(target, rvaToFile(0x1050), 0x1120);
  u32(target, rvaToFile(0x1054), 0x1130);
  u16(target, rvaToFile(0x1060), 0);
  u16(target, rvaToFile(0x1062), 0);
  writeCString(target, rvaToFile(0x1100), 'aliases.dll');
  writeCString(target, rvaToFile(0x1120), 'AliasA');
  writeCString(target, rvaToFile(0x1130), 'AliasB');
  target[rvaToFile(0x2000)] = 0xc3;
  return target;
}

const parsed = parsePE(makeAliasPE());
assert.deepEqual(parsed.exports.map((entry) => entry.name), ['AliasA', 'AliasB']);
assert.equal(parsed.functions.length, 1);
assert.equal(parsed.functions[0].source, 'entrypoint');
assert.equal(parsed.functions[0].name, 'AliasA');
assert.ok(parsed.functions[0].sources.includes('export-name'));
assert.deepEqual(parsed.metadata.peExportFunctionEvidence, {
  policy: 'export-is-symbol-evidence-not-function-proof',
  rejectedExportOnly: 1,
  corroborated: 1,
});

console.log('issue #6319 PE export alias regressions: PASS');
