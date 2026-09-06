import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createPEMetadataBudget,
  parseCoffSymbols,
} from '../../../js/binary/pe-loader.js';
import { ByteView } from '../../../js/binary/reader.js';

const POINTER = 0x40;
const SYMBOL_SIZE = 18;
const STRING_BASE = POINTER + SYMBOL_SIZE;
const encoder = new TextEncoder();

function image() {
  return {
    imageBase: 0x140000000n,
    bits: 64,
    sections: [],
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

function parseFixture({ stringSize, longName = null, byteLength = 0x100 }) {
  const bytes = new Uint8Array(byteLength);
  const view = new DataView(bytes.buffer);

  if (longName == null) {
    bytes.set(encoder.encode('INLINE\0'), POINTER);
  } else {
    view.setUint32(POINTER, 0, true);
    view.setUint32(POINTER + 4, 4, true);
    bytes.set(encoder.encode(`${longName}\0`), STRING_BASE + 4);
  }
  view.setInt16(POINTER + 12, 0, true);
  view.setUint32(STRING_BASE, stringSize, true);

  const parsedImage = image();
  const budget = createPEMetadataBudget(parsedImage);
  parseCoffSymbols(
    new ByteView(bytes, { littleEndian: true }),
    POINTER,
    1,
    parsedImage,
    budget,
  );
  return { image: parsedImage, budget };
}

test('#3719 Size=4 is a valid empty COFF string table', () => {
  const { image: parsedImage } = parseFixture({ stringSize: 4 });
  assert.equal(parsedImage.metadata.peMetadata.complete, true);
  assert.deepEqual(parsedImage.metadata.peMetadata.reasons, []);
  assert.equal(parsedImage.symbols[0].name, 'INLINE');
});

test('#3719 Size=0..3 is fail-closed instead of silently normalized', () => {
  for (const stringSize of [0, 1, 2, 3]) {
    const { image: parsedImage } = parseFixture({ stringSize });
    assert.equal(parsedImage.metadata.peMetadata.complete, false, `Size=${stringSize}`);
    assert.ok(
      parsedImage.metadata.peMetadata.reasons.includes('coff:string-table-size'),
      `Size=${stringSize}`,
    );
    assert.equal(parsedImage.symbols[0].name, 'INLINE', `Size=${stringSize}`);
  }
});

test('#3719 valid long COFF symbol names remain resolvable', () => {
  const longName = 'long_symbol';
  const stringSize = 4 + encoder.encode(`${longName}\0`).length;
  const { image: parsedImage } = parseFixture({ stringSize, longName });
  assert.equal(parsedImage.metadata.peMetadata.complete, true);
  assert.equal(parsedImage.symbols[0].name, longName);
});

test('#3719 declared string table beyond EOF keeps the existing truncation diagnostic', () => {
  const byteLength = STRING_BASE + 8;
  const { image: parsedImage } = parseFixture({ stringSize: 0x40, byteLength });
  assert.equal(parsedImage.metadata.peMetadata.complete, false);
  assert.ok(parsedImage.metadata.peMetadata.reasons.includes('coff:string-table-span'));
  assert.ok(!parsedImage.metadata.peMetadata.reasons.includes('coff:string-table-size'));
});
