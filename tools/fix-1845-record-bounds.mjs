import fs from 'node:fs';

const sourcePath = 'js/analysis/debug/pdb.js';
let source = fs.readFileSync(sourcePath, 'utf8');
function replaceOnce(before, after, label) {
  if (!source.includes(before)) throw new Error(`${label} source drifted`);
  source = source.replace(before, after);
}
replaceOnce(
  'const { value: sizeBytes, next } = readNumeric(view, bytes, sizeOffset);',
  'const numeric = readNumeric(view, bytes, sizeOffset, end);\n      if (!numeric) break;\n      const { value: sizeBytes, next } = numeric;',
  'aggregate numeric read',
);
replaceOnce(
  "const { value: sizeBytes } = readNumeric(view, bytes, body + 8);\n      types.set(index, { leaf, kind: 'array', elementType: view.getUint32(body, true), sizeBytes });",
  "const numeric = readNumeric(view, bytes, body + 8, end);\n      if (!numeric) break;\n      const { value: sizeBytes } = numeric;\n      types.set(index, { leaf, kind: 'array', elementType: view.getUint32(body, true), sizeBytes });",
  'array numeric read',
);
replaceOnce(
`function readNumeric(view, bytes, offset) {
  const raw = view.getUint16(offset, true);
  if (raw < 0x8000) return { value: raw, next: offset + 2 };
  switch (raw) {
    case 0x8000: return { value: view.getInt8(offset + 2), next: offset + 3 };
    case 0x8001: return { value: view.getInt16(offset + 2, true), next: offset + 4 };
    case 0x8002: return { value: view.getUint16(offset + 2, true), next: offset + 4 };
    case 0x8003: return { value: view.getInt32(offset + 2, true), next: offset + 6 };
    case 0x8004: return { value: view.getUint32(offset + 2, true), next: offset + 6 };
    default: return { value: null, next: offset + 2 };
  }
}`,
`function readNumeric(view, bytes, offset, end = bytes.length) {
  if (offset + 2 > end) return null;
  const raw = view.getUint16(offset, true);
  if (raw < 0x8000) return { value: raw, next: offset + 2 };
  const requiredEnd = raw === 0x8000 ? offset + 3
    : (raw === 0x8001 || raw === 0x8002) ? offset + 4
      : (raw === 0x8003 || raw === 0x8004) ? offset + 6
        : offset + 2;
  if (requiredEnd > end) return null;
  switch (raw) {
    case 0x8000: return { value: view.getInt8(offset + 2), next: offset + 3 };
    case 0x8001: return { value: view.getInt16(offset + 2, true), next: offset + 4 };
    case 0x8002: return { value: view.getUint16(offset + 2, true), next: offset + 4 };
    case 0x8003: return { value: view.getInt32(offset + 2, true), next: offset + 6 };
    case 0x8004: return { value: view.getUint32(offset + 2, true), next: offset + 6 };
    default: return { value: null, next: offset + 2 };
  }
}`,
  'readNumeric',
);
replaceOnce(
`  while (offset + 4 <= end) {
    const leaf = view.getUint16(offset, true);
    if (leaf !== LF_MEMBER) break;
    const typeIndex = view.getUint32(offset + 4, true);
    const { value: fieldOffset, next } = readNumeric(view, bytes, offset + 8);
    const nameEntry = cstringWithNext(bytes, next, end);`,
`  while (offset + 8 <= end) {
    const leaf = view.getUint16(offset, true);
    if (leaf !== LF_MEMBER) break;
    const typeIndex = view.getUint32(offset + 4, true);
    const numeric = readNumeric(view, bytes, offset + 8, end);
    if (!numeric) break;
    const { value: fieldOffset, next } = numeric;
    const nameEntry = cstringWithNext(bytes, next, end);`,
  'field list',
);
fs.writeFileSync(sourcePath, source);
fs.writeFileSync('tests/phase7/debug/pdb-numeric-record-bounds-1845.test.mjs', `import assert from 'node:assert/strict';
import test from 'node:test';
import { parseTpiStream } from '../../../js/analysis/debug/pdb.js';
function tpi(recordBytes) {
  const bytes = new Uint8Array(56 + recordBytes.length);
  const view = new DataView(bytes.buffer);
  view.setUint32(4, 56, true);
  view.setUint32(8, 0x1000, true);
  bytes.set(recordBytes, 56);
  return bytes;
}
test('LF_ARRAY without its numeric leaf fails closed at record end', () => {
  const record = Uint8Array.from([0x0a,0x00,0x03,0x15, 0,0,0,0, 0,0,0,0]);
  assert.doesNotThrow(() => parseTpiStream(tpi(record)));
  const parsed = parseTpiStream(tpi(record));
  assert.equal(parsed.types.size, 0);
  assert.equal(parsed.complete, false);
});
test('LF_ARRAY never consumes the next record as its numeric leaf', () => {
  const first = [0x0a,0x00,0x03,0x15, 0,0,0,0, 0,0,0,0];
  const next = [0x02,0x00,0x01,0x12];
  const parsed = parseTpiStream(tpi(Uint8Array.from([...first, ...next])));
  assert.equal(parsed.types.has(0x1000), false);
});
test('short LF_FIELDLIST member cannot read type or numeric data past its record', () => {
  const record = Uint8Array.from([0x06,0x00,0x03,0x12, 0x0d,0x15,0x00,0x00]);
  assert.doesNotThrow(() => parseTpiStream(tpi(record)));
  const parsed = parseTpiStream(tpi(record));
  assert.deepEqual(parsed.types.get(0x1000)?.members, []);
});
`);
