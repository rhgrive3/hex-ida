import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createPEMetadataBudget,
  parseCoffSymbols,
} from '../../../js/binary/pe-loader.js';
import { ByteView } from '../../../js/binary/reader.js';

const POINTER = 0x40;
const SYMBOL_SIZE = 18;
const encoder = new TextEncoder();

function image() {
  return {
    imageBase: 0x140000000n,
    bits: 64,
    sections: [{
      index: 1,
      address: 0x140001000n,
      size: 0x100n,
      fileOffset: 0x200n,
      fileSize: 0x100n,
      perms: { read: true, write: false, execute: true },
    }],
    segments: [],
    symbols: [],
    functions: [],
    imports: [],
    exports: [],
    libraries: [],
    relocations: [],
    warnings: [],
    metadata: {},
  };
}

function parseFixture(sectionNumber, { type = 0, storage = 2, value = 0x10 } = {}) {
  const bytes = new Uint8Array(POINTER + SYMBOL_SIZE + 4);
  const view = new DataView(bytes.buffer);
  bytes.set(encoder.encode('symbol\0'), POINTER);
  view.setUint32(POINTER + 8, value, true);
  view.setInt16(POINTER + 12, sectionNumber, true);
  view.setUint16(POINTER + 14, type, true);
  view.setUint8(POINTER + 16, storage);
  view.setUint8(POINTER + 17, 0);
  view.setUint32(POINTER + SYMBOL_SIZE, 4, true);

  const parsedImage = image();
  const budget = createPEMetadataBudget(parsedImage);
  parseCoffSymbols(
    new ByteView(bytes, { littleEndian: true }),
    POINTER,
    1,
    parsedImage,
    budget,
  );
  return parsedImage;
}

test('#3796 valid positive SectionNumber still resolves the section', () => {
  const parsedImage = parseFixture(1, { type: 0x20 });
  assert.equal(parsedImage.metadata.peMetadata.complete, true);
  assert.deepEqual(parsedImage.metadata.peMetadata.reasons, []);
  assert.equal(parsedImage.symbols.length, 1);
  assert.equal(parsedImage.symbols[0].defined, true);
  assert.equal(parsedImage.symbols[0].sectionIndex, 1);
  assert.equal(parsedImage.symbols[0].address, 0x140001010n);
  assert.equal(parsedImage.functions.length, 1);
});

test('#3796 positive out-of-range SectionNumber fails closed and is not published', () => {
  const parsedImage = parseFixture(2, { type: 0x20 });
  assert.equal(parsedImage.metadata.peMetadata.complete, false);
  assert.ok(parsedImage.metadata.peMetadata.reasons.includes('coff:invalid-section-number'));
  assert.equal(parsedImage.symbols.length, 0);
  assert.equal(parsedImage.functions.length, 0);
});

test('#3796 IMAGE_SYM_UNDEFINED SectionNumber=0 keeps existing special-value behavior', () => {
  const parsedImage = parseFixture(0);
  assert.equal(parsedImage.metadata.peMetadata.complete, true);
  assert.equal(parsedImage.symbols.length, 1);
  assert.equal(parsedImage.symbols[0].defined, false);
  assert.equal(parsedImage.symbols[0].sectionIndex, 0);
  assert.equal(parsedImage.symbols[0].address, 0n);
});

test('#3796 IMAGE_SYM_ABSOLUTE/DEBUG special SectionNumbers remain accepted', () => {
  for (const sectionNumber of [-1, -2]) {
    const parsedImage = parseFixture(sectionNumber);
    assert.equal(parsedImage.metadata.peMetadata.complete, true, `SectionNumber=${sectionNumber}`);
    assert.equal(parsedImage.symbols.length, 1, `SectionNumber=${sectionNumber}`);
    assert.equal(parsedImage.symbols[0].defined, false, `SectionNumber=${sectionNumber}`);
    assert.equal(parsedImage.symbols[0].sectionIndex, sectionNumber, `SectionNumber=${sectionNumber}`);
  }
});

test('#3796 unsupported negative SectionNumber fails closed', () => {
  const parsedImage = parseFixture(-3);
  assert.equal(parsedImage.metadata.peMetadata.complete, false);
  assert.ok(parsedImage.metadata.peMetadata.reasons.includes('coff:invalid-section-number'));
  assert.equal(parsedImage.symbols.length, 0);
});
