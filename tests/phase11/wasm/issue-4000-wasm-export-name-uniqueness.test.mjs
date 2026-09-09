import assert from 'node:assert/strict';
import test from 'node:test';
import { parseWasm as parseWasmCore } from '../../../js/managed/wasm/parser-core.js';
import { parseWasm } from '../../../js/managed/wasm/parser.js';

const MAGIC = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00];
const enc = new TextEncoder();

function uleb(value) {
  const out = [];
  let n = value >>> 0;
  do {
    let byte = n & 0x7f;
    n >>>= 7;
    if (n) byte |= 0x80;
    out.push(byte);
  } while (n);
  return out;
}

function name(value) {
  const bytes = [...enc.encode(value)];
  return [...uleb(bytes.length), ...bytes];
}

function section(id, payload) {
  return [id, ...uleb(payload.length), ...payload];
}

function exportModule(exports) {
  const typeSection = section(1, [0x01, 0x60, 0x00, 0x00]);
  const importSection = section(2, [
    0x01,
    ...name('m'), ...name('f'),
    0x00, 0x00,
  ]);
  const memorySection = section(5, [0x01, 0x00, 0x01]);
  const exportPayload = [
    ...uleb(exports.length),
    ...exports.flatMap(({ exportName, kind, index }) => [
      ...name(exportName), kind, ...uleb(index),
    ]),
  ];
  return Uint8Array.from([
    ...MAGIC,
    ...typeSection,
    ...importSection,
    ...memorySection,
    ...section(7, exportPayload),
  ]);
}

const fn = (exportName) => ({ exportName, kind: 0, index: 0 });
const memory = (exportName) => ({ exportName, kind: 2, index: 0 });

for (const [label, parse] of [['core', parseWasmCore], ['public', parseWasm]]) {
  test(`${label} rejects duplicate export names`, () => {
    assert.throws(
      () => parse(exportModule([fn('x'), fn('x')])),
      /wasm-duplicate-export-name/,
    );
  });
}

test('duplicate export name is invalid even across external kinds', () => {
  assert.throws(
    () => parseWasm(exportModule([fn('x'), memory('x')])),
    /wasm-duplicate-export-name/,
  );
});

test('empty export names are still subject to module-wide uniqueness', () => {
  assert.throws(
    () => parseWasm(exportModule([fn(''), fn('')])),
    /wasm-duplicate-export-name/,
  );
});

test('the same entity may be exported under distinct names', () => {
  const image = parseWasm(exportModule([fn('a'), fn('b')]));
  assert.deepEqual(image.exports, [
    { name: 'a', kind: 0, index: 0 },
    { name: 'b', kind: 0, index: 0 },
  ]);
});

test('distinct names remain valid across export kinds', () => {
  const image = parseWasm(exportModule([fn('f'), memory('memory')]));
  assert.deepEqual(image.exports.map(({ name: exportName, kind, index }) => ({ exportName, kind, index })), [
    { exportName: 'f', kind: 0, index: 0 },
    { exportName: 'memory', kind: 2, index: 0 },
  ]);
});

test('existing export index bounds validation remains authoritative', () => {
  assert.throws(
    () => parseWasm(exportModule([{ exportName: 'missing', kind: 0, index: 1 }])),
    /wasm-invalid-export-index-0/,
  );
});
