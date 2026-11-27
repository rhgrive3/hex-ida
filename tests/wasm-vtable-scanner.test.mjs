import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { scanVtables, mergeVtableRuns } from '../js/analysis/wasm-vtable-scanner.js';
import { getHexEngineExports } from '../js/core/hex-engine-wasm.js';

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
  assert.equal(typeof ex.hex_scan_vtables_ext, 'function', 'hex_scan_vtables_ext export missing');
  assert.ok(ex.memory instanceof WebAssembly.Memory, 'memory export missing');

  const rawHeapBase = ex.__heap_base && typeof ex.__heap_base === 'object' && 'value' in ex.__heap_base
    ? Number(ex.__heap_base.value)
    : Number(ex.__heap_base ?? 65536);
  const heapBase = (rawHeapBase + 7) & ~7;
  let cursor = heapBase;

  return {
    memory: ex.memory,
    hex_scan_vtables: ex.hex_scan_vtables,
    hex_scan_vtables_ext: ex.hex_scan_vtables_ext,
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

function encodeChainedOffset64(target, next = 0n, { bind = 0n, reserved = 0n, high8 = 0n } = {}) {
  return (target & 0xfffffffffn)
    | ((high8 & 0xffn) << 36n)
    | ((reserved & 0x7fn) << 44n)
    | ((next & 0xfffn) << 51n)
    | ((bind & 1n) << 63n);
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
  assert.equal(vt.encoding, 'absolute');

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

test('7. DYLD_CHAINED_PTR_64_OFFSET vtable + RTTI detection and false-positive rejection', () => {
  const imageBase = 0x100000000n;
  const textLo = 0x100004000n;
  const textHi = 0x100080000n;
  const rttiTarget = 0x100090n; // imageBase + rttiTarget = 0x100100090n (8B aligned, outside .text)
  const buf = new Uint8Array(512);

  // Valid chained_offset vtable with RTTI at 0x20 (next stride in bits [62:51] allowed)
  writeI64(buf, 0x10, -24n);
  writeU64(buf, 0x18, encodeChainedOffset64(rttiTarget, 2n));
  writeU64(buf, 0x20, encodeChainedOffset64(0x4100n, 2n));
  writeU64(buf, 0x28, encodeChainedOffset64(0x4140n, 2n));
  writeU64(buf, 0x30, encodeChainedOffset64(0x4180n, 2n));
  writeU64(buf, 0x38, encodeChainedOffset64(0x41c0n, 0n));

  // False positive #1: reserved bits [50:44] non-zero -> rejected
  writeU64(buf, 0x60, encodeChainedOffset64(0x5000n, 1n, { reserved: 1n }));
  writeU64(buf, 0x68, encodeChainedOffset64(0x5010n, 1n, { reserved: 1n }));
  writeU64(buf, 0x70, encodeChainedOffset64(0x5020n, 1n, { reserved: 1n }));

  // False positive #2: high8 bits [43:36] non-zero -> rejected
  writeU64(buf, 0x90, encodeChainedOffset64(0x5100n, 1n, { high8: 1n }));
  writeU64(buf, 0x98, encodeChainedOffset64(0x5110n, 1n, { high8: 1n }));
  writeU64(buf, 0xa0, encodeChainedOffset64(0x5120n, 1n, { high8: 1n }));

  // False positive #3: bind = 1 (bit 63) -> rejected
  writeU64(buf, 0xc0, encodeChainedOffset64(0x5200n, 1n, { bind: 1n }));
  writeU64(buf, 0xc8, encodeChainedOffset64(0x5210n, 1n, { bind: 1n }));
  writeU64(buf, 0xd0, encodeChainedOffset64(0x5220n, 1n, { bind: 1n }));

  // False positive #4: target == 0 (even when textLo == imageBase) -> rejected
  writeU64(buf, 0xf0, encodeChainedOffset64(0n, 1n));
  writeU64(buf, 0xf8, encodeChainedOffset64(0n, 1n));
  writeU64(buf, 0x100, encodeChainedOffset64(0n, 0n));

  const wasmRes = scanVtables(buf, baseOpts({ textLo: imageBase, textHi, imageBase, ptrSize: 8, stripPac: true }));
  const jsRes = scanVtables(buf, { textLo: imageBase, textHi, imageBase, ptrSize: 8, stripPac: true, engine: 'js' });

  assert.equal(wasmRes.engine, 'wasm');
  assert.equal(wasmRes.truncated, false);
  assert.equal(wasmRes.vtables.length, 1);

  const vt = wasmRes.vtables[0];
  assert.equal(vt.vtableOff, 0x20);
  assert.equal(vt.entryCount, 4);
  assert.equal(vt.offsetToTop, -24);
  assert.equal(vt.hasRtti, true);
  assert.equal(vt.pacStripped, false);
  assert.equal(vt.rttiVa, imageBase + rttiTarget);
  assert.equal(vt.firstFnVa, imageBase + 0x4100n);
  assert.equal(vt.flags, 5); // bit0=hasRtti(1) | bit2=chained_offset(4)
  assert.equal(vt.encoding, 'chained_offset');

  assert.deepEqual(wasmRes.vtables, jsRes.vtables);
});

test('8. 32-bit relative vtable + RTTI detection (negative offsets, INT32_MIN boundary, chunkDataVa straddle, 12B minLen)', () => {
  // Part A: negative offsets + RTTI + chunk-straddling vtable
  const textLo = 0x100000000n;
  const textHi = 0x100080000n;
  const dataVa = 0x100100000n;
  const rttiVa = 0x100200040n; // 4B aligned, outside .text
  const buf = new Uint8Array(1024);

  // Place a 60-entry (240-byte) relative32 vtable at offset 0x20 (straddles chunkSize=128)
  const vtableOff = 0x20;
  const totalEntries = 60;
  writeI32(buf, vtableOff - 8, -12);
  writeI32(buf, vtableOff - 4, Number(rttiVa - (dataVa + BigInt(vtableOff - 4))));
  for (let i = 0; i < totalEntries; i += 1) {
    const slotOff = vtableOff + i * 4;
    const targetVa = textLo + BigInt(0x1000 + i * 16);
    const disp = Number(targetVa - (dataVa + BigInt(slotOff)));
    assert.ok(disp < 0, 'displacement should be negative');
    writeI32(buf, slotOff, disp);
  }

  const wasmChunked = scanVtables(buf, baseOpts({ textLo, textHi, dataVa, ptrSize: 8, chunkSize: 128 }));
  const jsChunked = scanVtables(buf, { textLo, textHi, dataVa, ptrSize: 8, chunkSize: 128, engine: 'js' });
  const wasmSingle = scanVtables(buf, baseOpts({ textLo, textHi, dataVa, ptrSize: 8 }));

  assert.equal(wasmChunked.engine, 'wasm');
  assert.equal(wasmChunked.vtables.length, 1);
  const vt = wasmChunked.vtables[0];
  assert.equal(vt.vtableOff, vtableOff);
  assert.equal(vt.entryCount, totalEntries);
  assert.equal(vt.offsetToTop, -12);
  assert.equal(vt.hasRtti, true);
  assert.equal(vt.pacStripped, false);
  assert.equal(vt.rttiVa, rttiVa);
  assert.equal(vt.firstFnVa, textLo + 0x1000n);
  assert.equal(vt.flags, 9); // bit0=hasRtti(1) | bit3=relative32(8)
  assert.equal(vt.encoding, 'relative32');

  assert.deepEqual(wasmChunked.vtables, jsChunked.vtables);
  assert.deepEqual(wasmChunked.vtables, wasmSingle.vtables);

  // Part B: INT32_MIN (-0x80000000) boundary without UB or wrap + 12B minLen with ptrSize=8
  const minTextLo = 0x100000000n;
  const minTextHi = 0x100001000n;
  const minDataVa = 0x180000000n; // slot 0x00 + (-0x80000000) == 0x100000000n
  const tinyBuf = new Uint8Array(12); // < 24B (ptrSize*3) but >= 12B (relative32 minLen)
  writeI32(tinyBuf, 0, -0x80000000); // exact INT32_MIN -> 0x100000000n
  writeI32(tinyBuf, 4, -0x80000000); // -> 0x100000004n
  writeI32(tinyBuf, 8, -0x80000000); // -> 0x100000008n

  const wasmTiny = scanVtables(tinyBuf, baseOpts({ textLo: minTextLo, textHi: minTextHi, dataVa: minDataVa, ptrSize: 8 }));
  const jsTiny = scanVtables(tinyBuf, { textLo: minTextLo, textHi: minTextHi, dataVa: minDataVa, ptrSize: 8, engine: 'js' });
  assert.equal(wasmTiny.engine, 'wasm');
  assert.equal(wasmTiny.vtables.length, 1);
  assert.equal(wasmTiny.vtables[0].vtableOff, 0);
  assert.equal(wasmTiny.vtables[0].entryCount, 3);
  assert.equal(wasmTiny.vtables[0].firstFnVa, 0x100000000n);
  assert.equal(wasmTiny.vtables[0].encoding, 'relative32');
  assert.equal(wasmTiny.vtables[0].flags, 8);
  assert.deepEqual(wasmTiny.vtables, jsTiny.vtables);

  // Part C: INT32_MIN underflow guard (slot_va < 0x80000000 must be rejected, not wrap around)
  const underflowBuf = new Uint8Array(12);
  writeI32(underflowBuf, 0, -0x80000000);
  writeI32(underflowBuf, 4, -0x80000000);
  writeI32(underflowBuf, 8, -0x80000000);
  const wasmUf = scanVtables(underflowBuf, baseOpts({ textLo: 0xffffffff00000000n, textHi: 0xffffffffffff0000n, dataVa: 0x1000n, ptrSize: 8 }));
  const jsUf = scanVtables(underflowBuf, { textLo: 0xffffffff00000000n, textHi: 0xffffffffffff0000n, dataVa: 0x1000n, ptrSize: 8, engine: 'js' });
  assert.equal(wasmUf.vtables.length, 0);
  assert.deepEqual(wasmUf.vtables, jsUf.vtables);
});

test('9. Mixed Pass 1 (absolute) / Pass 2 (chained_offset) / Pass 3 (relative32) full WASM === JS parity', () => {
  const imageBase = 0x100000000n;
  const textLo = 0x100010000n;
  const textHi = 0x100040000n;
  const dataVa = 0x100080000n;
  const buf = new Uint8Array(512);

  // Pass 1: absolute + PAC vtable at 0x20
  writeI64(buf, 0x10, 0n);
  writeU64(buf, 0x18, 0x100090000n);
  writeU64(buf, 0x20, 0xbeef000100010100n);
  writeU64(buf, 0x28, 0x0000000100010120n);
  writeU64(buf, 0x30, 0x0000000100010140n);

  // Pass 2: chained_offset vtable at 0x80
  writeI64(buf, 0x70, -8n);
  writeU64(buf, 0x78, encodeChainedOffset64(0x90040n, 1n));
  writeU64(buf, 0x80, encodeChainedOffset64(0x11000n, 1n));
  writeU64(buf, 0x88, encodeChainedOffset64(0x11020n, 1n));
  writeU64(buf, 0x90, encodeChainedOffset64(0x11040n, 0n));

  // Pass 3: relative32 vtable at 0x100
  writeI32(buf, 0xf8, -4);
  writeI32(buf, 0xfc, Number(0x100090080n - (dataVa + 0xfcn)));
  writeI32(buf, 0x100, Number(0x100012000n - (dataVa + 0x100n)));
  writeI32(buf, 0x104, Number(0x100012010n - (dataVa + 0x104n)));
  writeI32(buf, 0x108, Number(0x100012020n - (dataVa + 0x108n)));

  const wasmSingle = scanVtables(buf, baseOpts({ textLo, textHi, imageBase, dataVa, ptrSize: 8, stripPac: true }));
  const jsSingle = scanVtables(buf, { textLo, textHi, imageBase, dataVa, ptrSize: 8, stripPac: true, engine: 'js' });
  const wasmChunked = scanVtables(buf, baseOpts({ textLo, textHi, imageBase, dataVa, ptrSize: 8, stripPac: true, chunkSize: 128 }));
  const jsChunked = scanVtables(buf, { textLo, textHi, imageBase, dataVa, ptrSize: 8, stripPac: true, chunkSize: 128, engine: 'js' });

  assert.equal(wasmSingle.engine, 'wasm');
  assert.equal(wasmSingle.vtables.length, 3);

  assert.equal(wasmSingle.vtables[0].vtableOff, 0x20);
  assert.equal(wasmSingle.vtables[0].encoding, 'absolute');
  assert.equal(wasmSingle.vtables[0].flags, 3);

  assert.equal(wasmSingle.vtables[1].vtableOff, 0x80);
  assert.equal(wasmSingle.vtables[1].encoding, 'chained_offset');
  assert.equal(wasmSingle.vtables[1].flags, 5);
  assert.equal(wasmSingle.vtables[1].rttiVa, 0x100090040n);

  assert.equal(wasmSingle.vtables[2].vtableOff, 0x100);
  assert.equal(wasmSingle.vtables[2].encoding, 'relative32');
  assert.equal(wasmSingle.vtables[2].flags, 9);
  assert.equal(wasmSingle.vtables[2].rttiVa, 0x100090080n);

  assert.deepEqual(wasmSingle.vtables, jsSingle.vtables);
  assert.deepEqual(wasmChunked.vtables, jsChunked.vtables);
  assert.deepEqual(wasmSingle.vtables, wasmChunked.vtables);
});

test('10. CHUNK_MAX_OUT separation: cumulative maxOut > 4096 and exact small maxOut without off-by-one', () => {
  const textLo = 0x10000n;
  const textHi = 0x80000n;

  // 4500 separate 3-entry vtables (each occupies 32 bytes: 24B entries + 8B zero separator) -> 144,000 bytes
  // With chunkSize = 32768 (overlap = 2048), each chunk holds ~1024 vtables (< CHUNK_MAX_OUT = 4096),
  // while cumulative total is 4500 (> 4096, < default maxOut = 65536).
  const count = 4500;
  const stride = 32;
  const buf = new Uint8Array(count * stride);
  for (let i = 0; i < count; i += 1) {
    const base = i * stride;
    writeU64(buf, base + 0, 0x10000n + BigInt((i & 0xfff) * 16));
    writeU64(buf, base + 8, 0x10004n + BigInt((i & 0xfff) * 16));
    writeU64(buf, base + 16, 0x10008n + BigInt((i & 0xfff) * 16));
    // base + 24 stays 0 (separator)
  }

  const wasmRes = scanVtables(buf, baseOpts({ textLo, textHi, ptrSize: 8, chunkSize: 32768 }));
  const jsRes = scanVtables(buf, { textLo, textHi, ptrSize: 8, chunkSize: 32768, engine: 'js' });
  assert.equal(wasmRes.engine, 'wasm');
  assert.equal(wasmRes.vtables.length, count);
  assert.equal(wasmRes.truncated, false);
  assert.deepEqual(wasmRes.vtables, jsRes.vtables);

  // Small maxOut boundary check: exact match must NOT set truncated, maxOut - 1 MUST set truncated
  const smallBuf = new Uint8Array(3 * 32);
  for (let i = 0; i < 3; i += 1) {
    const base = i * 32;
    writeU64(smallBuf, base + 0, 0x10000n);
    writeU64(smallBuf, base + 8, 0x10004n);
    writeU64(smallBuf, base + 16, 0x10008n);
  }

  const wasmExact = scanVtables(smallBuf, baseOpts({ textLo, textHi, ptrSize: 8, maxOut: 3 }));
  const jsExact = scanVtables(smallBuf, { textLo, textHi, ptrSize: 8, maxOut: 3, engine: 'js' });
  assert.equal(wasmExact.vtables.length, 3);
  assert.equal(wasmExact.truncated, false, 'exact maxOut match must not report truncated');
  assert.deepEqual(wasmExact.vtables, jsExact.vtables);

  const wasmCut = scanVtables(smallBuf, baseOpts({ textLo, textHi, ptrSize: 8, maxOut: 2 }));
  const jsCut = scanVtables(smallBuf, { textLo, textHi, ptrSize: 8, maxOut: 2, engine: 'js' });
  assert.equal(wasmCut.vtables.length, 2);
  assert.equal(wasmCut.truncated, true);
  assert.deepEqual(wasmCut.vtables, jsCut.vtables);
});

test('11. Fallback to JS when hex_scan_vtables_ext export is missing in mock wasmExports', () => {
  const baseEx = STANDALONE_EXPORTS || getHexEngineExports();
  assert.ok(baseEx, 'wasm exports required for mock test');
  const legacyOnlyExports = {
    memory: baseEx.memory,
    hex_scan_vtables: baseEx.hex_scan_vtables,
    hex_engine_scratch_reset: baseEx.hex_engine_scratch_reset,
    hex_engine_scratch_alloc: baseEx.hex_engine_scratch_alloc,
    // hex_scan_vtables_ext intentionally omitted
  };

  const imageBase = 0x100000000n;
  const textLo = 0x100004000n;
  const textHi = 0x100080000n;
  const buf = new Uint8Array(64);
  writeU64(buf, 0x00, encodeChainedOffset64(0x4100n, 1n));
  writeU64(buf, 0x08, encodeChainedOffset64(0x4120n, 1n));
  writeU64(buf, 0x10, encodeChainedOffset64(0x4140n, 0n));

  // Extended mode requested -> gracefully falls back to JS
  const extRes = scanVtables(buf, { textLo, textHi, imageBase, ptrSize: 8, wasmExports: legacyOnlyExports });
  const jsRes = scanVtables(buf, { textLo, textHi, imageBase, ptrSize: 8, engine: 'js' });
  assert.equal(extRes.engine, 'js');
  assert.equal(extRes.vtables.length, 1);
  assert.equal(extRes.vtables[0].encoding, 'chained_offset');
  assert.deepEqual(extRes.vtables, jsRes.vtables);

  // Legacy absolute-only mode still uses hex_scan_vtables on WASM
  const absBuf = new Uint8Array(64);
  writeU64(absBuf, 0x00, 0x100004100n);
  writeU64(absBuf, 0x08, 0x100004120n);
  writeU64(absBuf, 0x10, 0x100004140n);
  const absRes = scanVtables(absBuf, { textLo, textHi, ptrSize: 8, wasmExports: legacyOnlyExports });
  assert.equal(absRes.engine, 'wasm');
  assert.equal(absRes.vtables.length, 1);
  assert.equal(absRes.vtables[0].encoding, 'absolute');
});

test('12. mergeVtableRuns backward compatibility when encoding field is omitted', () => {
  const merged = mergeVtableRuns([
    // Overlapping relative32 records (encoding omitted, inferred from flags bit3 = 8)
    {
      vtableOff: 0x40,
      entryCount: 4, // 0x40..0x50 (slotSize = 4)
      offsetToTop: 0,
      hasRtti: true,
      pacStripped: false,
      rttiVa: 0x200000n,
      firstFnVa: 0x100000n,
      flags: 9,
    },
    {
      vtableOff: 0x48, // strictly < 0x50
      entryCount: 4, // 0x48..0x58
      offsetToTop: 0,
      hasRtti: false,
      pacStripped: false,
      rttiVa: 0n,
      firstFnVa: 0x100008n,
      flags: 8,
    },
    // Overlapping chained_offset records (encoding omitted, inferred from flags bit2 = 4)
    {
      vtableOff: 0x40,
      entryCount: 3, // 0x40..0x58 (slotSize = 8)
      offsetToTop: -8,
      hasRtti: true,
      pacStripped: false,
      rttiVa: 0x300000n,
      firstFnVa: 0x100100n,
      flags: 5,
    },
    {
      vtableOff: 0x50, // strictly < 0x58
      entryCount: 3, // 0x50..0x68
      offsetToTop: 0,
      hasRtti: false,
      pacStripped: false,
      rttiVa: 0n,
      firstFnVa: 0x100110n,
      flags: 4,
    },
    // Legacy absolute record (encoding omitted, flags = 1)
    {
      vtableOff: 0x10,
      entryCount: 3,
      offsetToTop: 0,
      hasRtti: true,
      pacStripped: false,
      rttiVa: 0x400000n,
      firstFnVa: 0x100200n,
      flags: 1,
    },
  ], 8);

  assert.equal(merged.length, 3);
  // Final sort order: (vtableOff) then (flags)
  assert.equal(merged[0].vtableOff, 0x10);
  assert.equal(merged[0].flags, 1);
  assert.equal(merged[0].entryCount, 3);

  assert.equal(merged[1].vtableOff, 0x40);
  assert.equal(merged[1].flags, 5); // bit2 preserved
  assert.equal(merged[1].entryCount, 5); // (0x68 - 0x40) / 8

  assert.equal(merged[2].vtableOff, 0x40);
  assert.equal(merged[2].flags, 9); // bit3 preserved
  assert.equal(merged[2].entryCount, 6); // (0x58 - 0x40) / 4
});
