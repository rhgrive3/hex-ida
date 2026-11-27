import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { scanVtables, mergeVtableRuns } from '../js/analysis/wasm-vtable-scanner.js';

function loadStandaloneWasmExports() {
  const wasmPath = process.env.HEX_TEST_STANDALONE_WASM;
  if (!wasmPath) return null;

  const bytes = fs.readFileSync(wasmPath);
  const mod = new WebAssembly.Module(bytes);
  const imports = WebAssembly.Module.imports(mod);
  assert.equal(imports.length, 0, `standalone wasm must have 0 imports, got ${imports.length}`);

  const inst = new WebAssembly.Instance(mod, {});
  const ex = inst.exports;
  assert.equal(typeof ex.hex_scan_vtables, 'function', 'hex_scan_vtables export missing');
  assert.ok(ex.memory instanceof WebAssembly.Memory, 'memory export missing');

  const rawHeapBase = ex.__heap_base && typeof ex.__heap_base === 'object' && 'value' in ex.__heap_base
    ? Number(ex.__heap_base.value)
    : Number(ex.__heap_base ?? 65536);
  const heapBase = (rawHeapBase + 7) & ~7;
  let cursor = heapBase;

  return {
    memory: ex.memory,
    hex_scan_vtables: ex.hex_scan_vtables,
    hex_engine_scratch_reset() {
      cursor = heapBase;
    },
    hex_engine_scratch_alloc(size) {
      const aligned = (cursor + 7) & ~7;
      const next = aligned + (size >>> 0);
      const curBytes = ex.memory.buffer.byteLength;
      if (next > curBytes) {
        const diff = next - curBytes;
        const pages = Math.ceil(diff / 65536);
        ex.memory.grow(pages);
      }
      cursor = next;
      return aligned;
    },
  };
}

const STANDALONE_EXPORTS = loadStandaloneWasmExports();

function baseOpts(extra = {}) {
  const opts = { ...extra };
  if (STANDALONE_EXPORTS && opts.engine !== 'js' && !opts.wasmExports) {
    opts.wasmExports = STANDALONE_EXPORTS;
  }
  return opts;
}

function writeU64(buf, off, val) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  dv.setBigUint64(off, BigInt.asUintN(64, val), true);
}

function writeI64(buf, off, val) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  dv.setBigInt64(off, val, true);
}

function writeU32(buf, off, val) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  dv.setUint32(off, val >>> 0, true);
}

function writeI32(buf, off, val) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  dv.setInt32(off, val | 0, true);
}

test('1. 64-bit Itanium ABI vtable with RTTI and PAC-signed entries (pacStripped === true)', () => {
  const textLo = 0x100000000n;
  const textHi = 0x100100000n;
  const rttiAddr = 0x100200080n; // outside .text, 8B aligned
  const buf = new Uint8Array(256);

  // Primary vtable at offset 0x20: offset_to_top = -16, rtti_ptr = rttiAddr, 4 virtual functions (2 PAC-signed)
  writeI64(buf, 0x10, -16n);
  writeU64(buf, 0x18, rttiAddr);
  writeU64(buf, 0x20, 0x1234000100001000n); // PAC bits in [63:48]
  writeU64(buf, 0x28, 0x0000000100001040n);
  writeU64(buf, 0x30, 0xabcd000100001080n); // PAC bits in [63:48]
  writeU64(buf, 0x38, 0x00000001000010c0n);

  const wasmRes = scanVtables(buf, baseOpts({ textLo, textHi, ptrSize: 8, stripPac: true }));
  const jsRes = scanVtables(buf, { textLo, textHi, ptrSize: 8, stripPac: true, engine: 'js' });

  assert.equal(wasmRes.engine, 'wasm');
  assert.equal(jsRes.engine, 'js');
  assert.equal(wasmRes.truncated, false);
  assert.equal(wasmRes.vtables.length, 1);

  const vt = wasmRes.vtables[0];
  assert.equal(vt.vtableOff, 0x20);
  assert.equal(vt.entryCount, 4);
  assert.equal(vt.offsetToTop, -16);
  assert.equal(vt.hasRtti, true);
  assert.equal(vt.pacStripped, true);
  assert.equal(vt.rttiVa, rttiAddr);
  assert.equal(vt.firstFnVa, 0x100001000n);
  assert.equal(vt.flags, 3);

  assert.deepEqual(wasmRes.vtables, jsRes.vtables);
});

test('2. 64-bit vtable without PAC signatures (pacStripped === false)', () => {
  const textLo = 0x400000n;
  const textHi = 0x500000n;
  const rttiAddr = 0x601000n;
  const buf = new Uint8Array(256);

  // Vtable #1 with RTTI at 0x20, no PAC bits set
  writeI64(buf, 0x10, 0n);
  writeU64(buf, 0x18, rttiAddr);
  writeU64(buf, 0x20, 0x401000n);
  writeU64(buf, 0x28, 0x401020n);
  writeU64(buf, 0x30, 0x401040n);

  // Vtable #2 at 0x80 with invalid RTTI (unaligned rtti_ptr + positive offset_to_top) -> hasRtti === false
  writeI64(buf, 0x70, 16n);
  writeU64(buf, 0x78, 0x601003n); // unaligned, outside .text -> rejected as RTTI
  writeU64(buf, 0x80, 0x403000n);
  writeU64(buf, 0x88, 0x403010n);
  writeU64(buf, 0x90, 0x403020n);

  const wasmRes = scanVtables(buf, baseOpts({ textLo, textHi, ptrSize: 8, stripPac: true }));
  const jsRes = scanVtables(buf, { textLo, textHi, ptrSize: 8, stripPac: true, engine: 'js' });

  assert.equal(wasmRes.engine, 'wasm');
  assert.equal(wasmRes.vtables.length, 2);

  assert.equal(wasmRes.vtables[0].vtableOff, 0x20);
  assert.equal(wasmRes.vtables[0].hasRtti, true);
  assert.equal(wasmRes.vtables[0].pacStripped, false);
  assert.equal(wasmRes.vtables[0].flags, 1);

  assert.equal(wasmRes.vtables[1].vtableOff, 0x80);
  assert.equal(wasmRes.vtables[1].hasRtti, false);
  assert.equal(wasmRes.vtables[1].pacStripped, false);
  assert.equal(wasmRes.vtables[1].rttiVa, 0n);
  assert.equal(wasmRes.vtables[1].offsetToTop, 0);
  assert.equal(wasmRes.vtables[1].flags, 0);

  assert.deepEqual(wasmRes.vtables, jsRes.vtables);
});

test('3. 32-bit vtable detection with and without RTTI', () => {
  const textLo = 0x08048000n;
  const textHi = 0x08060000n;
  const rttiAddr = 0x08070104n; // 4B aligned, outside .text
  const buf = new Uint8Array(128);

  // Vtable #1 at offset 0x00 (vtable_off < 2 * ptr_size -> hasRtti must be false)
  writeU32(buf, 0x00, 0x08049000);
  writeU32(buf, 0x04, 0x08049010);
  writeU32(buf, 0x08, 0x08049020);

  // Vtable #2 at offset 0x20 with valid RTTI and offset_to_top = -8
  writeI32(buf, 0x18, -8);
  writeU32(buf, 0x1c, Number(rttiAddr));
  writeU32(buf, 0x20, 0x0804a000);
  writeU32(buf, 0x24, 0x0804a010);
  writeU32(buf, 0x28, 0x0804a020);
  writeU32(buf, 0x2c, 0x0804a030);

  const wasmRes = scanVtables(buf, baseOpts({ textLo, textHi, ptrSize: 4, stripPac: true }));
  const jsRes = scanVtables(buf, { textLo, textHi, ptrSize: 4, stripPac: true, engine: 'js' });

  assert.equal(wasmRes.engine, 'wasm');
  assert.equal(wasmRes.vtables.length, 2);

  assert.equal(wasmRes.vtables[0].vtableOff, 0x00);
  assert.equal(wasmRes.vtables[0].entryCount, 3);
  assert.equal(wasmRes.vtables[0].hasRtti, false);
  assert.equal(wasmRes.vtables[0].pacStripped, false);
  assert.equal(wasmRes.vtables[0].firstFnVa, 0x08049000n);

  assert.equal(wasmRes.vtables[1].vtableOff, 0x20);
  assert.equal(wasmRes.vtables[1].entryCount, 4);
  assert.equal(wasmRes.vtables[1].offsetToTop, -8);
  assert.equal(wasmRes.vtables[1].hasRtti, true);
  assert.equal(wasmRes.vtables[1].pacStripped, false);
  assert.equal(wasmRes.vtables[1].rttiVa, rttiAddr);
  assert.equal(wasmRes.vtables[1].firstFnVa, 0x0804a000n);
  assert.equal(wasmRes.vtables[1].flags, 1);

  assert.deepEqual(wasmRes.vtables, jsRes.vtables);
});

test('4. Adjacent separate vtables are not merged (both header-separated and exact boundary adjacency)', () => {
  const textLo = 0x10000n;
  const textHi = 0x20000n;
  const buf = new Uint8Array(256);

  // Two back-to-back Itanium ABI vtables:
  // Vtable A: header at 0x00..0x0f, 3 entries at 0x10..0x27
  writeI64(buf, 0x00, 0n);
  writeU64(buf, 0x08, 0x30000n);
  writeU64(buf, 0x10, 0x10100n);
  writeU64(buf, 0x18, 0x10110n);
  writeU64(buf, 0x20, 0x10120n);

  // Vtable B: header immediately after at 0x28..0x37, 3 entries at 0x38..0x4f
  writeI64(buf, 0x28, -8n);
  writeU64(buf, 0x30, 0x30040n);
  writeU64(buf, 0x38, 0x10200n);
  writeU64(buf, 0x40, 0x10210n);
  writeU64(buf, 0x48, 0x10220n);

  const wasmRes = scanVtables(buf, baseOpts({ textLo, textHi, ptrSize: 8 }));
  const jsRes = scanVtables(buf, { textLo, textHi, ptrSize: 8, engine: 'js' });

  assert.equal(wasmRes.engine, 'wasm');
  assert.equal(wasmRes.vtables.length, 2);
  assert.equal(wasmRes.vtables[0].vtableOff, 0x10);
  assert.equal(wasmRes.vtables[0].entryCount, 3);
  assert.equal(wasmRes.vtables[0].rttiVa, 0x30000n);
  assert.equal(wasmRes.vtables[1].vtableOff, 0x38);
  assert.equal(wasmRes.vtables[1].entryCount, 3);
  assert.equal(wasmRes.vtables[1].rttiVa, 0x30040n);
  assert.deepEqual(wasmRes.vtables, jsRes.vtables);

  // Direct strict-overlap invariant check: next.vtableOff === prevEnd must NOT merge
  const adjacent = mergeVtableRuns([
    {
      vtableOff: 0x100,
      entryCount: 3, // ends at 0x118
      offsetToTop: 0,
      hasRtti: true,
      pacStripped: false,
      rttiVa: 0x30000n,
      firstFnVa: 0x10100n,
      flags: 1,
    },
    {
      vtableOff: 0x118, // === prevEnd
      entryCount: 4,
      offsetToTop: 0,
      hasRtti: true,
      pacStripped: true,
      rttiVa: 0x30080n,
      firstFnVa: 0x10200n,
      flags: 3,
    },
  ], 8);
  assert.equal(adjacent.length, 2, 'adjacent intervals (next.vtableOff === prevEnd) must not merge');
  assert.equal(adjacent[0].entryCount, 3);
  assert.equal(adjacent[1].vtableOff, 0x118);
  assert.equal(adjacent[1].entryCount, 4);
});

test('5. Long vtable straddling chunk boundaries merges cleanly and ORs pacStripped', () => {
  const textLo = 0x100000n;
  const textHi = 0x200000n;
  const rttiAddr = 0x300080n;
  const buf = new Uint8Array(2048);

  // Place a 90-entry (720-byte) vtable starting at offset 0x40 (ending at 0x310)
  // Using chunkSize = 256 (overlap = 128) forces multiple chunk splits across the vtable.
  writeI64(buf, 0x30, -32n);
  writeU64(buf, 0x38, rttiAddr);
  const totalEntries = 90;
  for (let i = 0; i < totalEntries; i += 1) {
    let va = textLo + BigInt(i * 16);
    // Only the very last entry (in a later chunk) carries a PAC tag
    if (i === totalEntries - 1) {
      va |= 0x4242000000000000n;
    }
    writeU64(buf, 0x40 + i * 8, va);
  }

  const wasmChunked = scanVtables(buf, baseOpts({ textLo, textHi, ptrSize: 8, stripPac: true, chunkSize: 256 }));
  const jsChunked = scanVtables(buf, { textLo, textHi, ptrSize: 8, stripPac: true, chunkSize: 256, engine: 'js' });
  const wasmSingle = scanVtables(buf, baseOpts({ textLo, textHi, ptrSize: 8, stripPac: true }));

  assert.equal(wasmChunked.engine, 'wasm');
  assert.equal(wasmChunked.vtables.length, 1);

  const vt = wasmChunked.vtables[0];
  assert.equal(vt.vtableOff, 0x40);
  assert.equal(vt.entryCount, totalEntries);
  assert.equal(vt.offsetToTop, -32);
  assert.equal(vt.hasRtti, true);
  assert.equal(vt.rttiVa, rttiAddr);
  assert.equal(vt.firstFnVa, textLo);
  assert.equal(vt.pacStripped, true, 'pacStripped must be logical OR across merged chunks');
  assert.equal(vt.flags, 3);

  assert.deepEqual(wasmChunked.vtables, jsChunked.vtables);
  assert.deepEqual(wasmChunked.vtables, wasmSingle.vtables);
});

test('6. Invalid inputs, unaligned pointers, short runs, and maxOut truncation match between WASM and JS', () => {
  const textLo = 0x10000n;
  const textHi = 0x20000n;

  // Invalid inputs return empty
  assert.deepEqual(scanVtables(new Uint8Array(8), baseOpts({ textLo, textHi, ptrSize: 8 })).vtables, []);
  assert.deepEqual(scanVtables(new Uint8Array(64), baseOpts({ textLo: 0x20000n, textHi: 0x10000n, ptrSize: 8 })).vtables, []);
  assert.deepEqual(scanVtables(new Uint8Array(64), baseOpts({ textLo, textHi, ptrSize: 6 })).vtables, []);

  const buf = new Uint8Array(512);
  // Short run of 2 pointers (must be ignored)
  writeU64(buf, 0x00, 0x10000n);
  writeU64(buf, 0x08, 0x10004n);
  // Unaligned code pointer breaks run
  writeU64(buf, 0x10, 0x10006n);

  // Three separate valid vtables to test maxOut truncation
  for (let k = 0; k < 3; k += 1) {
    const base = 0x40 + k * 0x40;
    writeU64(buf, base + 0x00, 0x11000n + BigInt(k * 0x100));
    writeU64(buf, base + 0x08, 0x11010n + BigInt(k * 0x100));
    writeU64(buf, base + 0x10, 0x11020n + BigInt(k * 0x100));
  }

  const wasmFull = scanVtables(buf, baseOpts({ textLo, textHi, ptrSize: 8 }));
  const jsFull = scanVtables(buf, { textLo, textHi, ptrSize: 8, engine: 'js' });
  assert.equal(wasmFull.engine, 'wasm');
  assert.equal(wasmFull.vtables.length, 3);
  assert.equal(wasmFull.truncated, false);
  assert.deepEqual(wasmFull.vtables, jsFull.vtables);

  const wasmTrunc = scanVtables(buf, baseOpts({ textLo, textHi, ptrSize: 8, maxOut: 2 }));
  const jsTrunc = scanVtables(buf, { textLo, textHi, ptrSize: 8, maxOut: 2, engine: 'js' });
  assert.equal(wasmTrunc.engine, 'wasm');
  assert.equal(wasmTrunc.vtables.length, 2);
  assert.equal(wasmTrunc.truncated, true);
  assert.deepEqual(wasmTrunc.vtables, jsTrunc.vtables);
});
