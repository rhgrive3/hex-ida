import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { scanConstTables, OVERLAP } from '../js/analysis/wasm-const-table-scanner.js';

function loadStandaloneWasmExports() {
  const wasmPath = process.env.HEX_TEST_STANDALONE_WASM;
  if (!wasmPath) return null;
  const bytes = fs.readFileSync(wasmPath);
  const mod = new WebAssembly.Module(bytes);
  const imports = WebAssembly.Module.imports(mod);
  assert.equal(imports.length, 0, `standalone WASM must have 0 imports, got ${JSON.stringify(imports)}`);
  const inst = new WebAssembly.Instance(mod, {});
  return inst.exports;
}

const standaloneWasmExports = loadStandaloneWasmExports();

function scanBoth(buf, extraOpts = {}) {
  const wasmOpts = standaloneWasmExports
    ? { ...extraOpts, wasmExports: standaloneWasmExports }
    : { ...extraOpts };
  const wasmRes = scanConstTables(buf, wasmOpts);
  const jsRes = scanConstTables(buf, { ...extraOpts, engine: 'js' });
  assert.equal(wasmRes.engine, 'wasm');
  assert.equal(jsRes.engine, 'js');
  assert.deepEqual(wasmRes.tables, jsRes.tables);
  assert.equal(wasmRes.truncated, jsRes.truncated);
  return { wasmRes, jsRes };
}

function writeF32Array(buf, offset, values) {
  const dv = new DataView(buf.buffer, buf.byteOffset + offset, values.length * 4);
  for (let i = 0; i < values.length; i++) {
    dv.setFloat32(i * 4, values[i], true);
  }
}

function writeF64Array(buf, offset, values) {
  const dv = new DataView(buf.buffer, buf.byteOffset + offset, values.length * 8);
  for (let i = 0; i < values.length; i++) {
    dv.setFloat64(i * 8, values[i], true);
  }
}

function writeStridedIds(buf, offset, stride, startId, count) {
  const dv = new DataView(buf.buffer, buf.byteOffset);
  for (let k = 0; k < count; k++) {
    const base = offset + k * stride;
    dv.setUint32(base, startId + k, true);
    for (let j = 4; j < stride; j++) {
      buf[base + j] = ((k * 37 + j * 13 + 0x81) & 0xff);
    }
  }
}

test('standalone WASM module has zero imports when HEX_TEST_STANDALONE_WASM is set', () => {
  if (!process.env.HEX_TEST_STANDALONE_WASM) return;
  assert.ok(standaloneWasmExports);
  assert.equal(typeof standaloneWasmExports.hex_scan_const_tables, 'function');
  assert.ok(standaloneWasmExports.memory instanceof WebAssembly.Memory);
});

test('1. detects f32 constant array (kind=1, elemSize=4, stride=4) with WASM === JS parity', () => {
  const buf = new Uint8Array(256);
  const values = [0.25, 0.5, 1.0, 1.5, 2.25, 3.1415927, -4.5, 12.75];
  writeF32Array(buf, 0x20, values);

  const { wasmRes } = scanBoth(buf);
  const f32Tables = wasmRes.tables.filter((t) => t.kind === 1);
  assert.equal(f32Tables.length, 1);
  assert.deepEqual(f32Tables[0], {
    startOff: 0x20,
    byteLen: values.length * 4,
    elementCount: values.length,
    kind: 1,
    elemSize: 4,
    stride: 4,
  });
});

test('2. detects f64 constant array (kind=2, elemSize=8, stride=8) with WASM === JS parity', () => {
  const buf = new Uint8Array(256);
  const values = [0.125, 1.0, 2.718281828459045, 3.141592653589793, -16.5, 1024.25];
  writeF64Array(buf, 0x40, values);

  const { wasmRes } = scanBoth(buf);
  const f64Tables = wasmRes.tables.filter((t) => t.kind === 2);
  assert.equal(f64Tables.length, 1);
  assert.deepEqual(f64Tables[0], {
    startOff: 0x40,
    byteLen: values.length * 8,
    elementCount: values.length,
    kind: 2,
    elemSize: 8,
    stride: 8,
  });
});

test('3. excludes ASCII text whose byte patterns fall inside valid f32/f64 exponent ranges', () => {
  const buf = new Uint8Array(256);
  // Bytes in 0x38..0x4A yield f32 exponents ~112..149 and f64 exponents ~1016..1034
  const ascii = '@ABC@DEF@GHI@JKL@MNO@PQR@STU@VWX@YZA@BCD@EFG@HIJ@KLM@NOP@QRS@TUV';
  const encoded = new TextEncoder().encode(ascii);
  buf.set(encoded, 0x20);
  buf[0x20 + encoded.length] = 0x0a;
  buf[0x20 + encoded.length + 1] = 0x0d;
  buf[0x20 + encoded.length + 2] = 0x09;
  buf[0x20 + encoded.length + 3] = 0x00;

  const { wasmRes } = scanBoth(buf);
  assert.equal(wasmRes.tables.filter((t) => t.kind === 1 || t.kind === 2).length, 0);
});

test('4. excludes constant arrays where all elements have identical bit values', () => {
  const buf = new Uint8Array(256);
  writeF32Array(buf, 0x10, [1.5, 1.5, 1.5, 1.5, 1.5, 1.5]);
  writeF64Array(buf, 0x60, [3.141592653589793, 3.141592653589793, 3.141592653589793, 3.141592653589793, 3.141592653589793]);

  const { wasmRes } = scanBoth(buf);
  assert.equal(wasmRes.tables.filter((t) => t.kind === 1 || t.kind === 2).length, 0);
});

test('5. detects stride=16 game unit ID struct table and skips larger stride at same startOff', () => {
  const buf = new Uint8Array(512);
  const startOff = 0x40;
  const count = 10;
  writeStridedIds(buf, startOff, 16, 100, count);

  // Also verify smaller-stride priority at same startOff (stride=20 vs stride=24, lcm=120)
  const dedupStart = 0x140;
  const dv = new DataView(buf.buffer, buf.byteOffset);
  for (let k = 0; k < 6; k++) {
    dv.setUint32(dedupStart + k * 20, 10 + k, true);
    dv.setUint32(dedupStart + k * 24, 10 + k, true);
  }

  const { wasmRes } = scanBoth(buf);
  const strided = wasmRes.tables.filter((t) => t.kind === 3 && t.startOff === startOff);
  assert.equal(strided.length, 1);
  assert.deepEqual(strided[0], {
    startOff,
    byteLen: count * 16,
    elementCount: count,
    kind: 3,
    elemSize: 4,
    stride: 16,
  });

  const dedupHits = wasmRes.tables.filter((t) => t.kind === 3 && t.startOff === dedupStart);
  assert.equal(dedupHits.length, 1);
  assert.equal(dedupHits[0].stride, 20);
});

test('6. merges f32, f64, and strided_id tables across chunk boundaries without merging adjacent disjoint tables', () => {
  const chunkSize = 2048; // > OVERLAP (1024), chunk boundaries at 2048, 3072, 4096...
  assert.ok(chunkSize > OVERLAP);
  const bigBuf = new Uint8Array(6144);

  const f32Vals = Array.from({ length: 40 }, (_, i) => 0.5 + i * 0.25);
  writeF32Array(bigBuf, 1960, f32Vals); // crosses 2048

  const f64Vals = Array.from({ length: 20 }, (_, i) => 1.0 + i * 0.125);
  writeF64Array(bigBuf, 2992, f64Vals); // crosses 3072

  const stridedStart = 4032; // 4032..4224 crosses 4096 (12 entries * 16B = 192B)
  writeStridedIds(bigBuf, stridedStart, 16, 500, 12);

  // Two immediately adjacent (touching, non-overlapping) stride=16 tables must NOT merge
  const adjA = 4480;
  const adjB = adjA + 6 * 16; // 4576
  writeStridedIds(bigBuf, adjA, 16, 10, 6);
  writeStridedIds(bigBuf, adjB, 16, 200, 6);

  const singleChunk = scanBoth(bigBuf);
  const multiChunk = scanBoth(bigBuf, { chunkSize });

  assert.deepEqual(multiChunk.wasmRes.tables, singleChunk.wasmRes.tables);

  const mergedF32 = multiChunk.wasmRes.tables.find((t) => t.kind === 1 && t.startOff === 1960);
  assert.deepEqual(mergedF32, {
    startOff: 1960,
    byteLen: 160,
    elementCount: 40,
    kind: 1,
    elemSize: 4,
    stride: 4,
  });

  const mergedF64 = multiChunk.wasmRes.tables.find((t) => t.kind === 2 && t.startOff === 2992);
  assert.deepEqual(mergedF64, {
    startOff: 2992,
    byteLen: 160,
    elementCount: 20,
    kind: 2,
    elemSize: 8,
    stride: 8,
  });

  const mergedStrided = multiChunk.wasmRes.tables.find((t) => t.kind === 3 && t.startOff === stridedStart);
  assert.deepEqual(mergedStrided, {
    startOff: stridedStart,
    byteLen: 192,
    elementCount: 12,
    kind: 3,
    elemSize: 4,
    stride: 16,
  });

  const foundAdjA = multiChunk.wasmRes.tables.find((t) => t.kind === 3 && t.startOff === adjA);
  const foundAdjB = multiChunk.wasmRes.tables.find((t) => t.kind === 3 && t.startOff === adjB);
  assert.equal(foundAdjA?.byteLen, 96);
  assert.equal(foundAdjB?.byteLen, 96);
});

test('7. handles invalid/short inputs and maxOut truncation identically between WASM and JS', () => {
  const shortRes = scanBoth(new Uint8Array(12));
  assert.deepEqual(shortRes.wasmRes.tables, []);
  assert.equal(shortRes.wasmRes.truncated, false);

  const buf = new Uint8Array(1024);
  writeF32Array(buf, 0x10, [1.0, 2.0, 3.0, 4.0]);
  writeF32Array(buf, 0x40, [5.0, 6.0, 7.0, 8.0]);
  writeF32Array(buf, 0x80, [9.0, 10.0, 11.0, 12.0]);

  const trunc = scanBoth(buf, { maxOut: 2 });
  assert.equal(trunc.wasmRes.tables.length, 2);
  assert.equal(trunc.wasmRes.truncated, true);
});

test('8. exact maxOut sets truncated=false while maxOut+1 sets truncated=true with WASM === JS parity', () => {
  const buf = new Uint8Array(256);
  writeF32Array(buf, 0x00, [1.0, 2.0, 3.0, 4.0]);
  writeF32Array(buf, 0x20, [5.0, 6.0, 7.0, 8.0]);
  writeF32Array(buf, 0x40, [9.0, 10.0, 11.0, 12.0]);

  const exact = scanBoth(buf, { maxOut: 3 });
  assert.equal(exact.wasmRes.tables.length, 3);
  assert.equal(exact.wasmRes.truncated, false);

  const trunc = scanBoth(buf, { maxOut: 2 });
  assert.equal(trunc.wasmRes.tables.length, 2);
  assert.equal(trunc.wasmRes.truncated, true);
});

test('9. adaptive bisection recovers dense single-chunk > CHUNK_MAX_OUT (16384) and preserves small maxOut / leaf saturation', () => {
  const totalCount = 17000;
  const strideBytes = 24; // 16B f32 table + 8B zero separator
  const buf = new Uint8Array(totalCount * strideBytes);
  for (let i = 0; i < totalCount; i++) {
    writeF32Array(buf, i * strideBytes, [1.0, 2.0, 3.0, 4.0]);
  }

  // Single default chunk (408KB < 1.5MB) exceeds CHUNK_MAX_OUT (16384) -> adaptive bisection recovers all 17000 tables
  const dense = scanBoth(buf);
  assert.equal(dense.wasmRes.tables.length, totalCount);
  assert.equal(dense.wasmRes.truncated, false);

  // Explicit small maxOut (< CHUNK_MAX_OUT) must NOT bisect and must report truncated=true
  const smallMax = scanBoth(buf, { maxOut: 100 });
  assert.equal(smallMax.wasmRes.tables.length, 100);
  assert.equal(smallMax.wasmRes.truncated, true);

  // Non-bisectable leaf chunk (chunkSize <= minBisectLen) saturating chunkMaxOut reports truncated=true
  const leaf = scanBoth(buf.subarray(0, 256), { chunkSize: 256, maxOut: 3 });
  assert.equal(leaf.wasmRes.tables.length, 3);
  assert.equal(leaf.wasmRes.truncated, true);
});
