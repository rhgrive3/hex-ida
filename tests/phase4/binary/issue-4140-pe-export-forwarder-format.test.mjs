import assert from 'node:assert/strict';
import { ByteView } from '../../../js/binary/reader.js';
import { parseExports } from '../../../js/binary/pe-loader.js';

const IMAGE_BASE = 0x10000000n;
const EXPORT_RVA = 0x1000;
const EXPORT_SIZE = 0x200;
const FILE_OFFSET = 0x100;
const FORWARDER_RVA = 0x1180;

function writeCString(bytes, offset, value) {
  bytes.set(Buffer.from(`${value}\0`, 'ascii'), offset);
}

function imageFor() {
  const section = {
    index: 1,
    address: IMAGE_BASE + BigInt(EXPORT_RVA),
    size: 0x3000n,
    fileOffset: BigInt(FILE_OFFSET),
    fileSize: 0xf00n,
    perms: { read: true, write: false, execute: true },
  };
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

function fixture(forwarder, { terminated = true, forwarderRva = FORWARDER_RVA } = {}) {
  const bytes = new Uint8Array(0x1000);
  const dv = new DataView(bytes.buffer);
  const at = (rva) => FILE_OFFSET + (rva - EXPORT_RVA);
  const header = at(EXPORT_RVA);

  dv.setUint32(header + 12, 0x1100, true); // DLL name
  dv.setUint32(header + 16, 1, true);      // ordinal base
  dv.setUint32(header + 20, 1, true);      // NumberOfFunctions
  dv.setUint32(header + 24, 1, true);      // NumberOfNames
  dv.setUint32(header + 28, 0x1040, true); // EAT
  dv.setUint32(header + 32, 0x1050, true); // name pointers
  dv.setUint32(header + 36, 0x1060, true); // name ordinals
  dv.setUint32(at(0x1040), forwarderRva, true);
  dv.setUint32(at(0x1050), 0x1120, true);
  dv.setUint16(at(0x1060), 0, true);
  writeCString(bytes, at(0x1100), 'fixture.dll');
  writeCString(bytes, at(0x1120), 'Forwarded');

  const start = at(forwarderRva);
  bytes.set(Buffer.from(forwarder, 'ascii'), start);
  if (terminated) bytes[start + forwarder.length] = 0;
  return bytes;
}

function parseForwarder(value, options) {
  const image = imageFor();
  parseExports(new ByteView(fixture(value, options)), { rva: EXPORT_RVA, size: EXPORT_SIZE }, image);
  return image;
}

for (const value of [
  'KERNEL32.Sleep',
  'NTDLL.#27',
  'api.ms.win.core.Sleep', // module identifiers may contain dots; split on the last dot
]) {
  const image = parseForwarder(value);
  assert.deepEqual(image.exports, [{
    name: 'Forwarded',
    address: 0n,
    ordinal: 1,
    kind: 'forwarder',
    forwarder: value,
    source: 'PE-export',
  }], `valid forwarder ${value}`);
  assert.equal(image.metadata.peMetadata?.complete, true, `valid forwarder ${value} stays complete`);
}

for (const value of [
  'NOT_A_FORWARDER',
  '.Func',
  'DLL.',
  'DLL.#',
  'DLL.#abc',
]) {
  const image = parseForwarder(value);
  assert.equal(image.exports.length, 0, `malformed forwarder ${value} must not be published`);
  assert.equal(image.metadata.peMetadata?.complete, false, `malformed forwarder ${value} marks parse partial`);
  assert.ok(
    image.metadata.peMetadata?.reasons.includes('exports:forwarder-target-format'),
    `malformed forwarder ${value} records a stable partial reason`,
  );
}

// Existing mapped-string trust boundary remains authoritative: even a
// structurally valid target is rejected if its NUL lies outside the export
// directory span.
{
  const forwarderRva = EXPORT_RVA + EXPORT_SIZE - 4;
  const image = parseForwarder('A.Func', { terminated: false, forwarderRva });
  assert.equal(image.exports.length, 0);
  assert.equal(image.metadata.peMetadata?.complete, false);
  assert.ok(image.metadata.peMetadata?.reasons.includes('PE export forwarder:unterminated-string'));
}

console.log('issue #4140 PE export forwarder format validation: PASS');
