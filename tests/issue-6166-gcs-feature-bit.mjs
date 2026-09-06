import assert from 'node:assert/strict';
import test from 'node:test';
import { parseAarch64GnuProperty, GNU_PROPERTY_AARCH64_FEATURE_1_GCS } from '../js/binary/elf-gnu-property.js';

function fixture(featureBits) {
  const noteOffset = 0x100;
  const descOffset = (noteOffset + 12 + 4 + 3) & ~3;
  const descSize = 16;
  const noteEnd = (descOffset + descSize + 3) & ~3;
  const bytes = new Uint8Array(noteEnd);
  const dv = new DataView(bytes.buffer);
  bytes.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1], 0);
  dv.setUint16(16, 2, true);
  dv.setUint16(18, 183, true);
  dv.setBigUint64(32, 64n, true);
  dv.setUint16(52, 64, true);
  dv.setUint16(54, 56, true);
  dv.setUint16(56, 1, true);
  const ph = 64;
  dv.setUint32(ph, 0x6474e553, true);
  dv.setBigUint64(ph + 8, BigInt(noteOffset), true);
  dv.setBigUint64(ph + 32, BigInt(noteEnd - noteOffset), true);
  dv.setUint32(noteOffset, 4, true);
  dv.setUint32(noteOffset + 4, descSize, true);
  dv.setUint32(noteOffset + 8, 5, true);
  bytes.set([0x47, 0x4e, 0x55, 0x00], noteOffset + 12);
  dv.setUint32(descOffset, 0xc0000000, true);
  dv.setUint32(descOffset + 4, 4, true);
  dv.setUint32(descOffset + 8, featureBits, true);
  return bytes;
}

test('issue #6166 - GCS constant is exported as 4', () => {
  assert.equal(GNU_PROPERTY_AARCH64_FEATURE_1_GCS, 4);
});

test('issue #6166 - FEATURE_1_AND=0x4 yields gcsRequested:true', () => {
  const r = parseAarch64GnuProperty(fixture(0x4));
  assert.equal(r.gcsRequested, true);
  assert.equal(r.featureBits, 4);
});

test('issue #6166 - 0x0 yields false when fully scanned', () => {
  const r = parseAarch64GnuProperty(fixture(0x0));
  assert.equal(r.gcsRequested, false);
  assert.equal(r.btiRequested, false);
  assert.equal(r.pacRequested, false);
});

test('issue #6166 - BTI|PAC|GCS keeps all three true', () => {
  const r = parseAarch64GnuProperty(fixture(0x7));
  assert.equal(r.btiRequested, true);
  assert.equal(r.pacRequested, true);
  assert.equal(r.gcsRequested, true);
});

test('issue #6166 - unknown path keeps GCS null like BTI/PAC', () => {
  const r = parseAarch64GnuProperty(new Uint8Array(8));
  assert.equal(r.btiRequested, null);
  assert.equal(r.pacRequested, null);
  assert.equal(r.gcsRequested, null);
});

test('issue #6166 - absent path keeps GCS false', () => {
  const r = parseAarch64GnuProperty(fixture(0x0));
  // fully scanned absent -> false (not null)
  assert.equal(r.gcsRequested, false);
});
