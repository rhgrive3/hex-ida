import assert from 'node:assert/strict';
import { parseWasm } from '../../../js/managed/wasm/parser-core.js';

const HEADER = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00];
const MAX_MEMORY32_PAGES = 65_536;

function uleb32(value) {
  assert.ok(Number.isSafeInteger(value) && value >= 0 && value <= 0xffff_ffff);
  let remaining = value >>> 0;
  const out = [];
  do {
    let byte = remaining & 0x7f;
    remaining >>>= 7;
    if (remaining !== 0) byte |= 0x80;
    out.push(byte);
  } while (remaining !== 0);
  return out;
}

function section(id, payload) {
  return [id, ...uleb32(payload.length), ...payload];
}

function limits(flags, min, max = null) {
  const out = [flags, ...uleb32(min)];
  if (max != null) out.push(...uleb32(max));
  return out;
}

function moduleWithDefinedMemory(flags, min, max = null) {
  return Uint8Array.from([
    ...HEADER,
    ...section(5, [1, ...limits(flags, min, max)]),
  ]);
}

function moduleWithImportedMemory(flags, min, max = null) {
  return Uint8Array.from([
    ...HEADER,
    ...section(2, [
      1,             // import count
      1, 0x6d,       // module name: "m"
      1, 0x78,       // field name: "x"
      2,             // import kind: memory
      ...limits(flags, min, max),
    ]),
  ]);
}

for (const [label, build] of [
  ['defined memory', moduleWithDefinedMemory],
  ['imported memory', moduleWithImportedMemory],
]) {
  assert.throws(
    () => parseWasm(build(0x00, MAX_MEMORY32_PAGES + 1)),
    /wasm-invalid-memory-limits-page-limit/,
    `${label} minimum above the memory32 2^16-page limit must fail closed`,
  );
  assert.throws(
    () => parseWasm(build(0x01, 1, MAX_MEMORY32_PAGES + 1)),
    /wasm-invalid-memory-limits-page-limit/,
    `${label} maximum above the memory32 2^16-page limit must fail closed`,
  );

  const boundary = parseWasm(build(0x01, MAX_MEMORY32_PAGES, MAX_MEMORY32_PAGES));
  const parsed = label === 'defined memory' ? boundary.memories[0] : boundary.imports[0].desc;
  assert.equal(parsed.min, MAX_MEMORY32_PAGES);
  assert.equal(parsed.max, MAX_MEMORY32_PAGES);
}

assert.throws(
  () => parseWasm(moduleWithDefinedMemory(0x02, 1)),
  /wasm-invalid-memory-limits-shared-requires-maximum/,
  'the existing shared-memory maximum requirement keeps its error precedence',
);
assert.throws(
  () => parseWasm(moduleWithImportedMemory(0x02, 1)),
  /wasm-invalid-memory-limits-shared-requires-maximum/,
  'the imported shared-memory maximum requirement remains fail-closed',
);

console.log('[phase11] issue #4813 memory32 page-limit regression passed');
