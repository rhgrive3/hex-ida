import assert from 'node:assert/strict';
import test from 'node:test';

import { parsePE } from '../../../js/binary/pe.js';

const IMAGE_BASE = 0x140000000n;
const SECTION_RVA = 0x1000;
const SECTION_SIZE = 0x400;
const VALID_INDEX = IMAGE_BASE + 0x1100n;

function makePe64({
  startAddressOfRawData = IMAGE_BASE + 0x1200n,
  endAddressOfRawData = IMAGE_BASE + 0x1204n,
} = {}) {
  const bytes = new Uint8Array(0x800);
  const view = new DataView(bytes.buffer);
  const pe = 0x80;
  const coff = pe + 4;
  const optional = coff + 20;
  const optionalSize = 0xf0;
  const section = optional + optionalSize;

  view.setUint16(0, 0x5a4d, true);
  view.setUint32(0x3c, pe, true);
  view.setUint32(pe, 0x4550, true);
  view.setUint16(coff, 0x8664, true);
  view.setUint16(coff + 2, 1, true);
  view.setUint16(coff + 16, optionalSize, true);
  view.setUint16(coff + 18, 0x0002, true);

  view.setUint16(optional, 0x20b, true);
  view.setBigUint64(optional + 24, IMAGE_BASE, true);
  view.setUint32(optional + 32, 0x1000, true);
  view.setUint32(optional + 36, 0x200, true);
  view.setUint32(optional + 56, 0x2000, true);
  view.setUint32(optional + 60, 0x200, true);
  view.setUint16(optional + 68, 3, true);
  view.setUint32(optional + 108, 16, true);

  const directories = optional + 112;
  view.setUint32(directories + 9 * 8, SECTION_RVA, true);
  view.setUint32(directories + 9 * 8 + 4, 40, true);

  bytes.set(new TextEncoder().encode('.data'), section);
  view.setUint32(section + 8, SECTION_SIZE, true);
  view.setUint32(section + 12, SECTION_RVA, true);
  view.setUint32(section + 16, SECTION_SIZE, true);
  view.setUint32(section + 20, 0x200, true);
  view.setUint32(section + 36, 0xc0000040, true);

  const tls = 0x200;
  view.setBigUint64(tls, startAddressOfRawData, true);
  view.setBigUint64(tls + 8, endAddressOfRawData, true);
  view.setBigUint64(tls + 16, VALID_INDEX, true);
  return bytes;
}

function parse(options) {
  return parsePE(makePe64(options));
}

test('#8105 retains and accepts a fully mapped TLS raw-data template range', () => {
  const start = IMAGE_BASE + 0x1200n;
  const end = IMAGE_BASE + 0x1204n;
  const image = parse({ startAddressOfRawData: start, endAddressOfRawData: end });

  assert.equal(image.metadata.tls.startAddressOfRawData, start);
  assert.equal(image.metadata.tls.endAddressOfRawData, end);
  assert.equal(image.metadata.peMetadata.complete, true);
});

test('#8105 marks an unmapped TLS raw-data template partial', () => {
  const start = IMAGE_BASE + 0x3000n;
  const end = start + 4n;
  const image = parse({ startAddressOfRawData: start, endAddressOfRawData: end });

  assert.equal(image.metadata.tls.startAddressOfRawData, start);
  assert.equal(image.metadata.tls.endAddressOfRawData, end);
  assert.equal(image.metadata.peMetadata.complete, false);
  assert.ok(image.metadata.peMetadata.reasons.includes('tls:template-range-unmapped'));
});

test('#8105 rejects a reversed TLS raw-data template range', () => {
  const start = IMAGE_BASE + 0x1208n;
  const end = IMAGE_BASE + 0x1200n;
  const image = parse({ startAddressOfRawData: start, endAddressOfRawData: end });

  assert.equal(image.metadata.peMetadata.complete, false);
  assert.ok(image.metadata.peMetadata.reasons.includes('tls:template-range-invalid'));
});

test('#8105 validates the complete template span, not only its start', () => {
  const start = IMAGE_BASE + BigInt(SECTION_RVA + SECTION_SIZE - 2);
  const end = start + 4n;
  const image = parse({ startAddressOfRawData: start, endAddressOfRawData: end });

  assert.equal(image.metadata.peMetadata.complete, false);
  assert.ok(image.metadata.peMetadata.reasons.includes('tls:template-range-unmapped'));
});

test('#8105 preserves the empty-template form', () => {
  const image = parse({ startAddressOfRawData: 0n, endAddressOfRawData: 0n });

  assert.equal(image.metadata.tls.startAddressOfRawData, null);
  assert.equal(image.metadata.tls.endAddressOfRawData, null);
  assert.equal(image.metadata.peMetadata.complete, true);
});
