import assert from 'node:assert/strict';
import { ByteView } from '../../../js/binary/reader.js';
import { parseCoffSymbols } from '../../../js/binary/pe-loader-core.js';

function parseOne({ type, execute = true, storage = 3, value = 0x20 }) {
  const ptr = 4;
  const bytes = new Uint8Array(ptr + 18 + 4);
  bytes.set(new TextEncoder().encode('typed'), ptr);
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
    size: 0x100n,
    fileOffset: 0n,
    fileSize: 0x100n,
    perms: { read: true, write: !execute, execute },
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
  const { image, section } = parseOne({ type: 0x20 });
  assert.equal(image.symbols.length, 1);
  assert.equal(image.symbols[0].kind, 'function', 'DTYPE_FUNCTION must remain a function symbol');
  assert.equal(image.functions.length, 1);
  assert.equal(image.functions[0].address, section.address + 0x20n);
  assert.equal(image.functions[0].source, 'symbol');
  assert.equal(image.functions[0].exactFunctionStart, true);
}

{
  const { image } = parseOne({ type: 0x30, execute: false });
  assert.equal(image.symbols.length, 1);
  assert.equal(image.symbols[0].kind, 'symbol', 'DTYPE_ARRAY must not be classified as a function');
  assert.equal(image.functions.length, 0, 'non-executable ARRAY metadata must never seed a function');
}

{
  const { image } = parseOne({ type: 0x10 });
  assert.equal(image.symbols[0].kind, 'symbol', 'DTYPE_POINTER must not be classified as a function');
  assert.equal(image.functions.length, 0);
}

{
  const { image } = parseOne({ type: 0x24 });
  assert.equal(image.symbols[0].kind, 'function', 'base-type low bits must not hide DTYPE_FUNCTION');
  assert.equal(image.functions.length, 1);
  assert.equal(image.functions[0].source, 'symbol');
}

{
  const { image } = parseOne({ type: 0x20, execute: false });
  assert.equal(image.symbols[0].kind, 'function', 'COFF type identity is preserved as metadata');
  assert.equal(image.functions.length, 0, 'non-executable function metadata must not become an exact seed');
}

console.log('issue-4323 PE COFF derived-type classification: ok');
