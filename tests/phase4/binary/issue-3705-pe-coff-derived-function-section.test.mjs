import assert from 'node:assert/strict';
import { ByteView } from '../../../js/binary/reader.js';
import { parseCoffSymbols } from '../../../js/binary/pe-loader-core.js';

function parseOne({ value, size = 0x100, execute = true, type = 0x20, storage = 2 }) {
  const ptr = 4;
  const bytes = new Uint8Array(ptr + 18 + 4);
  bytes.set(new TextEncoder().encode('fake'), ptr);
  const view = new DataView(bytes.buffer);
  view.setUint32(ptr + 8, value, true);
  view.setInt16(ptr + 12, 1, true);
  view.setUint16(ptr + 14, type, true);
  view.setUint8(ptr + 16, storage);
  view.setUint8(ptr + 17, 0);
  view.setUint32(ptr + 18, 4, true);

  const section = {
    index: 1,
    address: 0x140001000n,
    size: BigInt(size),
    fileOffset: 0n,
    fileSize: BigInt(size),
    perms: { read: true, write: false, execute },
  };
  const image = {
    metadata: {},
    warnings: [],
    sections: [section],
    segments: [],
    symbols: [],
    functions: [],
  };

  parseCoffSymbols(new ByteView(bytes), ptr, 1, image);
  return { image, section };
}

{
  const { image, section } = parseOne({ value: 0x20 });
  assert.equal(image.functions.length, 1);
  assert.equal(image.functions[0].address, section.address + 0x20n);
  assert.equal(image.functions[0].source, 'symbol');
  assert.equal(image.functions[0].confidence, 0.98);
  assert.equal(image.functions[0].exactFunctionStart, true);
}

for (const value of [0x100, 0x100000]) {
  const { image } = parseOne({ value });
  assert.equal(image.functions.length, 0, `out-of-range Value 0x${value.toString(16)} must not seed a function`);
  assert.equal(image.symbols.length, 1, 'COFF metadata decode must be preserved');
}

{
  const { image } = parseOne({ value: 0x20, execute: false });
  assert.equal(image.functions.length, 0, 'non-executable derived-function symbol must not seed a function');
  assert.equal(image.symbols.length, 1);
}

{
  const { image } = parseOne({ value: 0x20, type: 0, storage: 2 });
  assert.equal(image.functions.length, 1, 'in-range executable external symbol heuristic must be preserved');
  assert.equal(image.functions[0].source, 'symbol-heuristic');
  assert.equal(image.functions[0].confidence, 0.55);
}

{
  const { image } = parseOne({ value: 0x100, type: 0, storage: 2 });
  assert.equal(image.functions.length, 0, 'heuristic fallback must not bypass the section proof');
}

console.log('issue-3705 PE COFF derived-function section validation: ok');
