import assert from 'node:assert/strict';
import { parseCil, probeCil } from '../../../js/managed/cil/parser.js';
import { buildMinimalCil } from './cil-parser.test.mjs';

console.log('[phase11] running CIL marker authority #3910 tests...');

const markerOnly = new Uint8Array(64);
markerOnly.set([0x42, 0x53, 0x4a, 0x42], 0);
assert.equal(probeCil(markerOnly).supported, false);
assert.throws(() => parseCil(markerOnly), /cil-unsupported-binary/);

function rawMetadataRoot(streamNames) {
  const bytes = new Uint8Array(0x100);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, 0x424a5342, true);
  view.setUint16(4, 1, true);
  view.setUint16(6, 1, true);
  view.setUint32(12, 4, true);
  bytes.set([0x76, 0x31, 0, 0], 16); // v1\0\0
  view.setUint16(22, streamNames.length, true);
  let streamPos = 24;
  for (let index = 0; index < streamNames.length; index++) {
    view.setUint32(streamPos, 0x60 + index * 4, true);
    view.setUint32(streamPos + 4, 0, true);
    streamPos += 8;
    const name = new TextEncoder().encode(`${streamNames[index]}\0`);
    bytes.set(name, streamPos);
    streamPos = (streamPos + name.length + 3) & ~3;
  }
  return bytes;
}

for (const invalidRawRoot of [rawMetadataRoot([]), rawMetadataRoot(['#Strings', '#Strings'])]) {
  assert.equal(probeCil(invalidRawRoot).supported, false,
    'a version string without a unique, nonempty stream table is not CIL authority');
  assert.throws(() => parseCil(invalidRawRoot), /cil-unsupported-binary/);
}

const markerInUnrelatedBytes = new Uint8Array(96);
for (let index = 0; index < markerInUnrelatedBytes.length; index++) {
  markerInUnrelatedBytes[index] = (index * 37 + 11) & 0xff;
}
markerInUnrelatedBytes.set([0x42, 0x53, 0x4a, 0x42], 32);
assert.equal(probeCil(markerInUnrelatedBytes).supported, false);
assert.throws(() => parseCil(markerInUnrelatedBytes), /cil-unsupported-binary/);

const truncatedRawRoot = new Uint8Array(80);
const truncatedView = new DataView(truncatedRawRoot.buffer);
truncatedView.setUint32(0, 0x424a5342, true);
truncatedView.setUint32(12, 0x100, true);
assert.equal(probeCil(truncatedRawRoot).supported, false);
assert.throws(() => parseCil(truncatedRawRoot), /cil-unsupported-binary/);

const structuralPeCli = buildMinimalCil();
const probe = probeCil(structuralPeCli);
assert.equal(probe.supported, true);
assert.equal(probe.formatVersion, 'pe-cli');
assert.equal(parseCil(structuralPeCli).methodBodies.length, 1);

console.log('  ok CIL marker authority #3910 tests passed');
