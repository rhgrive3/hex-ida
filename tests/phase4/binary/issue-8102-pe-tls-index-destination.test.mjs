import assert from 'node:assert/strict';
import test from 'node:test';

import { parsePE } from '../../../js/binary/pe.js';

const IMAGE_BASE = 0x140000000n;
const TLS_RVA = 0x1000;
const SECTION_RVA = 0x1000;
const SECTION_SIZE = 0x200;
const VALID_INDEX = IMAGE_BASE + 0x1100n;

function makePe64({ addressOfIndex = VALID_INDEX, writable = true } = {}) {
  const bytes = new Uint8Array(0x600);
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
  view.setUint32(directories + 9 * 8, TLS_RVA, true);
  view.setUint32(directories + 9 * 8 + 4, 40, true);

  bytes.set(new TextEncoder().encode('.rdata'), section);
  view.setUint32(section + 8, SECTION_SIZE, true);
  view.setUint32(section + 12, SECTION_RVA, true);
  view.setUint32(section + 16, SECTION_SIZE, true);
  view.setUint32(section + 20, 0x200, true);
  view.setUint32(section + 36, (writable ? 0xc0000000 : 0x40000000) | 0x40, true);

  const tls = 0x200;
  view.setBigUint64(tls + 16, addressOfIndex, true);
  return bytes;
}

function parse(options) {
  return parsePE(makePe64(options));
}

test('#8102 accepts a fully mapped writable TLS AddressOfIndex and retains provenance', () => {
  const image = parse();

  assert.equal(image.metadata.tls.addressOfIndex, VALID_INDEX);
  assert.equal(image.metadata.peMetadata.complete, true);
  assert.deepEqual(image.metadata.peMetadata.reasons, []);
});

test('#8102 marks an unmapped nonzero TLS AddressOfIndex partial', () => {
  const addressOfIndex = IMAGE_BASE + 0x3000n;
  const image = parse({ addressOfIndex });

  assert.equal(image.metadata.tls.addressOfIndex, addressOfIndex);
  assert.equal(image.metadata.peMetadata.complete, false);
  assert.ok(image.metadata.peMetadata.reasons.includes('tls:index-target-unmapped'));
});

test('#8102 requires the complete 4-byte TLS index storage span', () => {
  const addressOfIndex = IMAGE_BASE + BigInt(SECTION_RVA + SECTION_SIZE - 2);
  const image = parse({ addressOfIndex });

  assert.equal(image.metadata.tls.addressOfIndex, addressOfIndex);
  assert.equal(image.metadata.peMetadata.complete, false);
  assert.ok(image.metadata.peMetadata.reasons.includes('tls:index-target-span'));
});

test('#8102 requires a writable TLS index destination', () => {
  const image = parse({ writable: false });

  assert.equal(image.metadata.tls.addressOfIndex, VALID_INDEX);
  assert.equal(image.metadata.peMetadata.complete, false);
  assert.ok(image.metadata.peMetadata.reasons.includes('tls:index-target-non-writable'));
});

test('#8102 preserves zero AddressOfIndex policy without inventing a failure', () => {
  const image = parse({ addressOfIndex: 0n });

  assert.equal(image.metadata.tls.addressOfIndex, null);
  assert.equal(image.metadata.peMetadata.complete, true);
  assert.deepEqual(image.metadata.peMetadata.reasons, []);
});
