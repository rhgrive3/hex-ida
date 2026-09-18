import assert from 'node:assert/strict';
import { parseWasm } from '../../../js/managed/wasm/parser.js';

console.log('[phase11] running issue #3998 Wasm module-wide locals budget tests...');

const MAGIC = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00];

function uleb(value) {
  const out = [];
  let n = value >>> 0;
  do { let byte = n & 0x7f; n >>>= 7; if (n) byte |= 0x80; out.push(byte); } while (n);
  return out;
}
function section(id, payload) { return [id, ...uleb(payload.length), ...payload]; }
function moduleWithLocals(functionCount, localsPerFunction) {
  const typeSection = section(1, [0x01, 0x60, 0x00, 0x00]);
  const functionSection = section(3, [...uleb(functionCount), ...new Array(functionCount).fill(0x00)]);
  const body = [...uleb(1), ...uleb(localsPerFunction), 0x7f, 0x0b];
  const entries = [];
  for (let i = 0; i < functionCount; i++) entries.push(...uleb(body.length), ...body);
  const codeSection = section(10, [...uleb(functionCount), ...entries]);
  return Uint8Array.from([...MAGIC, ...typeSection, ...functionSection, ...codeSection]);
}

assert.doesNotThrow(() => parseWasm(moduleWithLocals(2, 3)), 'ordinary module must stay valid');
assert.doesNotThrow(() => parseWasm(moduleWithLocals(1, 1000000)), 'single-function per-function max stays valid');

assert.throws(
  () => parseWasm(moduleWithLocals(20, 100000)),
  /wasm-too-many-locals/,
  '20 functions x 100000 locals must trip the module-wide budget',
);
assert.throws(
  () => parseWasm(moduleWithLocals(4, 500000)),
  /wasm-too-many-locals/,
  '4 functions x 500000 locals must trip the module-wide budget',
);

console.log('[phase11] issue #3998 Wasm module-wide locals budget tests passed');
