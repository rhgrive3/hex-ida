import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createPEMetadataBudget,
  parseCoffSymbols,
  parseDelayImports,
  parseExports,
  parseImports,
} from '../../../js/binary/pe-loader.js';
import { ByteView } from '../../../js/binary/reader.js';

const BASE = 0x140000000n;
const encoder = new TextEncoder();

function mappedImage(sectionName = '.rdata') {
  const section = {
    index: 1,
    name: sectionName,
    address: BASE + 0x1000n,
    size: 0x1000n,
    fileOffset: 0x40n,
    fileSize: 0x1000n,
    perms: { read: true, write: false, execute: false },
  };
  return {
    imageBase: BASE,
    bits: 64,
    sections: [section],
    segments: [],
    sectionAt: () => section,
    addressToOffset: (address) => address - BASE - 0x1000n + 0x40n,
    exports: [],
    imports: [],
    libraries: [],
    symbols: [],
    functions: [],
    relocations: [],
    warnings: [],
    metadata: {},
  };
}

function exportBudget(value, { unterminated = false } = {}) {
  const bytes = new Uint8Array(0x2000);
  const view = new DataView(bytes.buffer);
  const image = mappedImage('.edata');
  view.setUint32(0x40 + 12, 0x1080, true);
  view.setUint32(0x40 + 16, 1, true);
  if (unterminated) bytes.fill(0x41, 0xc0, 0x1040);
  else bytes.set(encoder.encode(`${value}\0`), 0xc0);
  const budget = createPEMetadataBudget(image);
  parseExports(new ByteView(bytes, { littleEndian: true }), { rva: 0x1000, size: 40 }, image, budget);
  return { image, budget };
}

function importBudget(name, parser = parseImports) {
  const bytes = new Uint8Array(0x2000);
  const view = new DataView(bytes.buffer);
  const image = mappedImage('.idata');
  const delay = parser === parseDelayImports;

  if (delay) {
    view.setUint32(0x40, 1, true);
    view.setUint32(0x44, 0x1060, true);
    view.setUint32(0x4c, 0x1050, true);
    view.setUint32(0x50, 0x1040, true);
  } else {
    view.setUint32(0x40, 0x1040, true);
    view.setUint32(0x4c, 0x1060, true);
    view.setUint32(0x50, 0x1050, true);
  }

  bytes.set(encoder.encode('lib.dll\0'), 0xa0);
  view.setBigUint64(0x80, 0x1080n, true);
  view.setBigUint64(0x90, 0x1080n, true);
  view.setUint16(0xc0, 0, true);
  bytes.set(encoder.encode(`${name}\0`), 0xc2);

  const budget = createPEMetadataBudget(image);
  parser(new ByteView(bytes, { littleEndian: true }), { rva: 0x1000, size: delay ? 64 : 40 }, image, budget);
  return { image, budget };
}

test('#6286 export CStrings charge raw bytes through NUL', () => {
  assert.equal(exportBudget('AAAA').budget.used.inputBytes, 5);
  assert.equal(exportBudget('猫').budget.used.inputBytes, 4);
  assert.equal(exportBudget('猫猫猫猫').budget.used.inputBytes, 13);
  assert.equal(exportBudget('🐱').budget.used.inputBytes, 5);
});

test('#6286 decoded UTF-16 storage accounting remains independent', () => {
  assert.equal(exportBudget('猫').budget.used.stringBytes, 2);
  assert.equal(exportBudget('🐱').budget.used.stringBytes, 4);
});

test('#6286 unterminated export strings remain fail-closed', () => {
  const { image, budget } = exportBudget('', { unterminated: true });
  assert.equal(image.metadata.exportName, undefined);
  assert.equal(budget.used.inputBytes, 0);
  assert.ok(image.metadata.peMetadata.reasons.some((reason) => reason.includes('unterminated-string')));
});

test('#6286 delegated import-name accounting uses raw UTF-8 length', () => {
  const ascii = importBudget('aa');
  const utf8 = importBudget('猫猫');
  assert.equal(ascii.image.imports[0].name, 'aa');
  assert.equal(utf8.image.imports[0].name, '猫猫');
  assert.equal(utf8.budget.used.inputBytes - ascii.budget.used.inputBytes, 4);
});

test('#6286 delegated delay-import accounting uses raw UTF-8 length', () => {
  const ascii = importBudget('aa', parseDelayImports);
  const utf8 = importBudget('猫猫', parseDelayImports);
  assert.equal(ascii.image.imports[0].name, 'aa');
  assert.equal(utf8.image.imports[0].name, '猫猫');
  assert.equal(utf8.budget.used.inputBytes - ascii.budget.used.inputBytes, 4);
});

test('#6286 delegated COFF string-table names charge raw bytes', () => {
  const bytes = new Uint8Array(0x200);
  const view = new DataView(bytes.buffer);
  const pointer = 0x40;
  const stringBase = pointer + 18;
  view.setUint32(pointer, 0, true);
  view.setUint32(pointer + 4, 4, true);
  view.setInt16(pointer + 12, 0, true);
  view.setUint32(stringBase, 16, true);
  bytes.set(encoder.encode('猫\0'), stringBase + 4);
  const image = mappedImage('.debug');
  const budget = createPEMetadataBudget(image);
  parseCoffSymbols(new ByteView(bytes, { littleEndian: true }), pointer, 1, image, budget);
  assert.equal(image.symbols[0].name, '猫');
  assert.equal(budget.used.inputBytes, 22);
});

test('#6286 no-op delegated parsers preserve lazy metadata creation', () => {
  const bytes = new ByteView(new Uint8Array(64), { littleEndian: true });
  const image = mappedImage();
  parseImports(bytes, null, image);
  parseDelayImports(bytes, { rva: 0, size: 0 }, image);
  parseCoffSymbols(bytes, 0, 0, image);
  assert.equal(image.metadata.peMetadata, undefined);
});
