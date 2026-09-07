import assert from 'node:assert/strict';

import { parseSymbolRecords } from '../../../js/analysis/debug/pdb.js';

const UNKNOWN_KIND = 0x1234;
const S_PUB32 = 0x110e;

function unknownRecord(kind = UNKNOWN_KIND) {
  const bytes = new Uint8Array(4);
  const view = new DataView(bytes.buffer);
  view.setUint16(0, 2, true);
  view.setUint16(2, kind, true);
  return bytes;
}

function publicRecord(name = 'p') {
  const encoded = new TextEncoder().encode(name);
  const bytes = new Uint8Array(14 + encoded.length + 1);
  const view = new DataView(bytes.buffer);
  view.setUint16(0, bytes.length - 2, true);
  view.setUint16(2, S_PUB32, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, 0x10, true);
  view.setUint16(12, 1, true);
  bytes.set(encoded, 14);
  return bytes;
}

function concat(...chunks) {
  const length = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}

{
  const result = parseSymbolRecords(
    concat(unknownRecord(), unknownRecord(), unknownRecord()),
    { maxRecords: 1 },
  );
  assert.equal(result.symbols.length, 0);
  assert.equal(result.unmodelled.has(UNKNOWN_KIND), true);
  assert.equal(result.complete, false, 'unmodelled records must consume the record budget');
}

{
  const result = parseSymbolRecords(unknownRecord(), { maxRecords: 1 });
  assert.equal(result.complete, true, 'ending exactly at the record budget remains complete');
}

{
  const result = parseSymbolRecords(
    concat(publicRecord(), unknownRecord()),
    { maxRecords: 1 },
  );
  assert.equal(result.symbols.length, 1);
  assert.equal(result.unmodelled.has(UNKNOWN_KIND), false, 'records after the cap must not be scanned');
  assert.equal(result.complete, false);
}

{
  const result = parseSymbolRecords(
    concat(unknownRecord(), publicRecord()),
    { maxRecords: 1 },
  );
  assert.equal(result.symbols.length, 0, 'unknown records count even though they produce no modeled symbol');
  assert.equal(result.complete, false);
}

{
  const result = parseSymbolRecords(
    concat(unknownRecord(), publicRecord()),
    { maxRecords: 2 },
  );
  assert.equal(result.symbols.length, 1);
  assert.equal(result.complete, true);
}

console.log('pdb symbol record budget #3869: PASS');
