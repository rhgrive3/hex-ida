import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import {
  scanObjcPtrList,
  scanSwift5Rel32List,
  scanSwift5FieldMd,
  scanObjcSwiftMetadataFromImage,
} from '../js/analysis/wasm-objc-swift-scanner.js';

function loadStandaloneWasmExports() {
  const wasmPath = process.env.HEX_TEST_STANDALONE_WASM;
  if (!wasmPath) return null;

  const bytes = fs.readFileSync(wasmPath);
  const mod = new WebAssembly.Module(bytes);
  const imports = WebAssembly.Module.imports(mod);
  assert.equal(imports.length, 0, `standalone wasm must have 0 imports, got ${imports.length}`);

  const inst = new WebAssembly.Instance(mod, {});
  const ex = inst.exports;
  assert.equal(typeof ex.hex_scan_objc_ptr_list, 'function', 'hex_scan_objc_ptr_list export missing');
  assert.equal(typeof ex.hex_scan_swift5_rel32_list, 'function', 'hex_scan_swift5_rel32_list export missing');
  assert.equal(typeof ex.hex_scan_swift5_fieldmd, 'function', 'hex_scan_swift5_fieldmd export missing');
  assert.ok(ex.memory instanceof WebAssembly.Memory, 'memory export missing');

  const rawHeapBase = ex.__heap_base && typeof ex.__heap_base === 'object' && 'value' in ex.__heap_base
    ? Number(ex.__heap_base.value)
    : Number(ex.__heap_base ?? 65536);
  const heapBase = (rawHeapBase + 7) & ~7;
  let cursor = heapBase;

  return {
    memory: ex.memory,
    hex_scan_objc_ptr_list: ex.hex_scan_objc_ptr_list,
    hex_scan_swift5_rel32_list: ex.hex_scan_swift5_rel32_list,
    hex_scan_swift5_fieldmd: ex.hex_scan_swift5_fieldmd,
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

function writeU16(buf, off, val) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  dv.setUint16(off, val & 0xffff, true);
}

function writeU32(buf, off, val) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  dv.setUint32(off, val >>> 0, true);
}

function writeI32(buf, off, val) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  dv.setInt32(off, val | 0, true);
}

function writeU64(buf, off, val) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  dv.setBigUint64(off, BigInt.asUintN(64, val), true);
}

function encodeChained64(target, { next = 0n, bind = 0n, reserved = 0n, high8 = 0n } = {}) {
  return (target & 0xfffffffffn)
    | ((high8 & 0xffn) << 36n)
    | ((reserved & 0x7fn) << 44n)
    | ((next & 0xfffn) << 51n)
    | ((bind & 1n) << 63n);
}

function writeFieldDescriptor(buf, off, {
  mangledTypeName = 0,
  superclass = 0,
  kind = 0,
  recordSize = 12,
  numFields = 0,
}) {
  writeI32(buf, off + 0, mangledTypeName);
  writeI32(buf, off + 4, superclass);
  writeU16(buf, off + 8, kind);
  writeU16(buf, off + 10, recordSize);
  writeU32(buf, off + 12, numFields);
  return 16 + numFields * recordSize;
}

test('1. ObjC pointer list: raw VA, PAC-signed, DYLD_CHAINED_PTR_64_OFFSET, DYLD_CHAINED_PTR_64, and bind immediate skip', () => {
  const imageBase = 0x100000000n;
  const buf = new Uint8Array(8 * 10);

  // Slot 0 (off 0): zero -> skip
  writeU64(buf, 0, 0n);
  // Slot 1 (off 8): DYLD_CHAINED_PTR_64_OFFSET (target < imageBase, next=2) -> imageBase + 0x4000, flags=2
  writeU64(buf, 8, encodeChained64(0x4000n, { next: 2n }));
  // Slot 2 (off 16): DYLD_CHAINED_PTR_64 vmaddr (target >= imageBase, next=1) -> 0x100008000, flags=4
  writeU64(buf, 16, encodeChained64(0x100008000n, { next: 1n }));
  // Slot 3 (off 24): PAC-signed pointer (bit63=0, non-zero high8/reserved in bits 36..50 so not chained) -> stripped, flags=1
  writeU64(buf, 24, 0x3a2100010000c000n);
  // Slot 4 (off 32): bind entry (bit63=1, even with valid-looking low48 aligned VA) -> MUST skip immediately!
  writeU64(buf, 32, 0x800000010000e000n);
  // Slot 5 (off 40): another bind entry with ordinal and PAC-like bits -> MUST skip immediately!
  writeU64(buf, 40, encodeChained64(0x1200n, { next: 1n, bind: 1n }));
  // Slot 6 (off 48): raw VA with non-zero bits in 36..43? Wait: for pure raw VA without chained flags, test separately;
  // here with chained_vmaddr=true, a 48-bit VA with bits 36..43 non-zero (e.g. 0x000001000000f000n) falls through to raw (flags=0).
  writeU64(buf, 48, 0x000001000000f000n);
  // Slot 7 (off 56): unaligned VA -> skipped
  writeU64(buf, 56, 0x000001000000f002n);
  // Slot 8 (off 64): PAC-signed but low48 == 0 -> va == 0 -> skipped
  writeU64(buf, 64, 0x1234000000000000n);
  // Slot 9 (off 72): chained offset whose target is unaligned -> skipped
  writeU64(buf, 72, encodeChained64(0x4001n, { next: 1n }));

  const opts = {
    imageBase,
    stripPac: true,
    allowChainedOffset: true,
    allowChainedVmaddr: true,
  };
  const wasmRes = scanObjcPtrList(buf, baseOpts(opts));
  const jsRes = scanObjcPtrList(buf, { ...opts, engine: 'js' });

  assert.equal(wasmRes.engine, 'wasm');
  assert.equal(jsRes.engine, 'js');
  assert.equal(wasmRes.truncated, false);
  assert.deepEqual(wasmRes.entries, jsRes.entries);

  assert.equal(wasmRes.entries.length, 4);
  assert.deepEqual(wasmRes.entries[0], {
    slotOff: 8,
    targetVa: 0x100004000n,
    flags: 2,
    encoding: 'chained_offset',
    pacStripped: false,
  });
  assert.deepEqual(wasmRes.entries[1], {
    slotOff: 16,
    targetVa: 0x100008000n,
    flags: 4,
    encoding: 'chained_vmaddr',
    pacStripped: false,
  });
  assert.deepEqual(wasmRes.entries[2], {
    slotOff: 24,
    targetVa: 0x10000c000n,
    flags: 1,
    encoding: 'pac',
    pacStripped: true,
  });
  assert.deepEqual(wasmRes.entries[3], {
    slotOff: 48,
    targetVa: 0x000001000000f000n,
    flags: 0,
    encoding: 'raw',
    pacStripped: false,
  });
});

test('2. ObjC pointer list: raw mode (no chained, no PAC strip) preserves bit63=1 pointers', () => {
  const buf = new Uint8Array(16);
  writeU64(buf, 0, 0xfffffff007001000n); // kernel/high VA with bit63=1
  writeU64(buf, 8, 0x0000000100002000n);

  const opts = {
    imageBase: 0n,
    stripPac: false,
    allowChainedOffset: false,
    allowChainedVmaddr: false,
  };
  const wasmRes = scanObjcPtrList(buf, baseOpts(opts));
  const jsRes = scanObjcPtrList(buf, { ...opts, engine: 'js' });

  assert.equal(wasmRes.engine, 'wasm');
  assert.deepEqual(wasmRes.entries, jsRes.entries);
  assert.equal(wasmRes.entries.length, 2);
  assert.equal(wasmRes.entries[0].targetVa, 0xfffffff007001000n);
  assert.equal(wasmRes.entries[0].flags, 0);
  assert.equal(wasmRes.entries[1].targetVa, 0x100002000n);
});

test('3. Swift 5 rel32 list: positive/negative disp, INT32_MIN safe, indirect bit, disp==0 and disp==1 skip', () => {
  const secVa = 0x100010000n;
  const buf = new Uint8Array(4 * 8);

  // Slot 0 (off 0): disp = 0 -> skip
  writeI32(buf, 0, 0);
  // Slot 1 (off 4): disp = 1 with allowIndirect=true -> eff_disp = 0 -> MUST skip
  writeI32(buf, 4, 1);
  // Slot 2 (off 8): positive disp = +0x100 -> 0x100010108, flags=0
  writeI32(buf, 8, 0x100);
  // Slot 3 (off 12): negative disp = -0x200 -> 0x10000fe0c, flags=0
  writeI32(buf, 12, -0x200);
  // Slot 4 (off 16): indirect positive disp = 0x201 -> eff_disp = 0x200 -> 0x100010210, flags=1
  writeI32(buf, 16, 0x201);
  // Slot 5 (off 20): indirect negative disp = -0x1ff (-511; -511 & ~1 = -512 = -0x200) -> 0x10000fe14, flags=1
  writeI32(buf, 20, -0x1ff);
  // Slot 6 (off 24): INT32_MIN (-2147483648 = -0x80000000) -> 0x100010018 - 0x80000000 = 0x80010018
  writeI32(buf, 24, -2147483648);
  // Slot 7 (off 28): INT32_MIN + 1 (-2147483647; & ~1 = INT32_MIN) -> indirect, 0x8001001c
  writeI32(buf, 28, -2147483647);

  const opts = { secVa, allowIndirect: true };
  const wasmRes = scanSwift5Rel32List(buf, baseOpts(opts));
  const jsRes = scanSwift5Rel32List(buf, { ...opts, engine: 'js' });

  assert.equal(wasmRes.engine, 'wasm');
  assert.equal(jsRes.engine, 'js');
  assert.deepEqual(wasmRes.entries, jsRes.entries);

  assert.equal(wasmRes.entries.length, 6);
  assert.deepEqual(wasmRes.entries[0], { slotOff: 8, targetVa: 0x100010108n, flags: 0, indirect: false });
  assert.deepEqual(wasmRes.entries[1], { slotOff: 12, targetVa: 0x10000fe0cn, flags: 0, indirect: false });
  assert.deepEqual(wasmRes.entries[2], { slotOff: 16, targetVa: 0x100010210n, flags: 1, indirect: true });
  assert.deepEqual(wasmRes.entries[3], { slotOff: 20, targetVa: 0x10000fe14n, flags: 1, indirect: true });
  assert.deepEqual(wasmRes.entries[4], { slotOff: 24, targetVa: 0x80010018n, flags: 0, indirect: false });
  assert.deepEqual(wasmRes.entries[5], { slotOff: 28, targetVa: 0x8001001cn, flags: 1, indirect: true });

  // Underflow / overflow guard check: secVa = 0x10n with INT32_MIN must be skipped safely
  const smallBuf = new Uint8Array(8);
  writeI32(smallBuf, 0, -2147483648); // underflows 0x10
  writeI32(smallBuf, 4, 1);           // with allowIndirect=false -> 0x14 + 1 = 0x15
  const uWasm = scanSwift5Rel32List(smallBuf, baseOpts({ secVa: 0x10n, allowIndirect: false }));
  const uJs = scanSwift5Rel32List(smallBuf, { secVa: 0x10n, allowIndirect: false, engine: 'js' });
  assert.equal(uWasm.engine, 'wasm');
  assert.deepEqual(uWasm.entries, uJs.entries);
  assert.equal(uWasm.entries.length, 1);
  assert.equal(uWasm.entries[0].slotOff, 4);
  assert.equal(uWasm.entries[0].targetVa, 0x15n);
});

test('4. Swift 5 fieldmd: multiple descriptors, num_fields==0 && record_size==0, invalid record_size stop, overflow defense, small chunkSize boundary', () => {
  const secVa = 0x100020000n;
  const buf = new Uint8Array(256);
  let pos = 0;

  // Descriptor 0: struct (kind=0), 2 fields, recordSize=12 (total 40B), mangled=+0x400, superclass=0
  pos += writeFieldDescriptor(buf, pos, {
    mangledTypeName: 0x400,
    superclass: 0,
    kind: 0,
    recordSize: 12,
    numFields: 2,
  });
  // Descriptor 1: empty enum/struct (kind=3), num_fields=0, record_size=0 (total 16B), mangled=-0x100, superclass=+0x20
  pos += writeFieldDescriptor(buf, pos, {
    mangledTypeName: -0x100,
    superclass: 0x20,
    kind: 3,
    recordSize: 0,
    numFields: 0,
  });
  // Descriptor 2: class (kind=1), 4 fields, recordSize=24 (total 112B -> exceeds chunkSize=64!)
  pos += writeFieldDescriptor(buf, pos, {
    mangledTypeName: 0x800,
    superclass: -0x40,
    kind: 1,
    recordSize: 24,
    numFields: 4,
  });
  // Descriptor 3: struct (kind=0), 1 field, recordSize=12 (total 28B)
  const desc3Off = pos;
  pos += writeFieldDescriptor(buf, pos, {
    mangledTypeName: 0,
    superclass: 0,
    kind: 0,
    recordSize: 12,
    numFields: 1,
  });
  const expectedConsumed = pos;

  // Descriptor 4 (invalid record_size=13, not multiple of 4) -> must stop here!
  writeFieldDescriptor(buf, pos, {
    mangledTypeName: 0x10,
    superclass: 0,
    kind: 0,
    recordSize: 13,
    numFields: 1,
  });

  // Full scan (WASM vs JS)
  const wasmFull = scanSwift5FieldMd(buf, baseOpts({ secVa }));
  const jsFull = scanSwift5FieldMd(buf, { secVa, engine: 'js' });
  assert.equal(wasmFull.engine, 'wasm');
  assert.equal(jsFull.engine, 'js');
  assert.deepEqual(wasmFull.descriptors, jsFull.descriptors);
  assert.equal(wasmFull.consumedBytes, expectedConsumed);
  assert.equal(jsFull.consumedBytes, expectedConsumed);
  assert.equal(wasmFull.descriptors.length, 4);

  assert.deepEqual(wasmFull.descriptors[0], {
    descOff: 0,
    numFields: 2,
    kind: 0,
    recordSize: 12,
    flags: 1,
    hasMangledTypeName: true,
    hasSuperclass: false,
    mangledTypeNameVa: 0x100020400n,
  });
  assert.deepEqual(wasmFull.descriptors[1], {
    descOff: 40,
    numFields: 0,
    kind: 3,
    recordSize: 0,
    flags: 3,
    hasMangledTypeName: true,
    hasSuperclass: true,
    mangledTypeNameVa: 0x100020000n + 40n - 0x100n,
  });
  assert.deepEqual(wasmFull.descriptors[2], {
    descOff: 56,
    numFields: 4,
    kind: 1,
    recordSize: 24,
    flags: 3,
    hasMangledTypeName: true,
    hasSuperclass: true,
    mangledTypeNameVa: 0x100020000n + 56n + 0x800n,
  });
  assert.deepEqual(wasmFull.descriptors[3], {
    descOff: desc3Off,
    numFields: 1,
    kind: 0,
    recordSize: 12,
    flags: 0,
    hasMangledTypeName: false,
    hasSuperclass: false,
    mangledTypeNameVa: 0n,
  });

  // Small chunkSize (64B) forces record-boundary advancing AND single-record JS fallback for Descriptor 2 (112B > 64B)
  const wasmChunked = scanSwift5FieldMd(buf, baseOpts({ secVa, chunkSize: 64 }));
  const jsChunked = scanSwift5FieldMd(buf, { secVa, chunkSize: 64, engine: 'js' });
  assert.equal(wasmChunked.engine, 'wasm');
  assert.equal(wasmChunked.consumedBytes, expectedConsumed);
  assert.deepEqual(wasmChunked.descriptors, wasmFull.descriptors);
  assert.deepEqual(jsChunked.descriptors, wasmFull.descriptors);

  // 32-bit multiplication overflow defense: num_fields = 0x20000000, record_size = 16 -> 64-bit product = 0x200000000 > remaining
  const ovfBuf = new Uint8Array(64);
  writeI32(ovfBuf, 0, 0x100);
  writeI32(ovfBuf, 4, 0);
  writeU16(ovfBuf, 8, 0);
  writeU16(ovfBuf, 10, 16);
  writeU32(ovfBuf, 12, 0x20000000); // 0x20000000 * 16 wraps to 0 in u32!
  const ovfWasm = scanSwift5FieldMd(ovfBuf, baseOpts({ secVa }));
  const ovfJs = scanSwift5FieldMd(ovfBuf, { secVa, engine: 'js' });
  assert.equal(ovfWasm.engine, 'wasm');
  assert.equal(ovfWasm.descriptors.length, 0);
  assert.equal(ovfWasm.consumedBytes, 0);
  assert.deepEqual(ovfWasm.descriptors, ovfJs.descriptors);
});

test('5. scanObjcSwiftMetadataFromImage: extracts and aggregates all 8 ObjC/Swift5 sections with WASM === JS parity', () => {
  const imageBase = 0x100000000n;
  const imageBytes = new Uint8Array(1024);

  // __objc_classlist at fileOffset 0x00, size 16 (2 ptrs: 1 chained_offset, 1 bind skipped)
  writeU64(imageBytes, 0x00, encodeChained64(0x10000n, { next: 1n }));
  writeU64(imageBytes, 0x08, encodeChained64(0x20000n, { next: 0n, bind: 1n }));

  // __objc_catlist at fileOffset 0x20, size 8 (1 PAC ptr)
  writeU64(imageBytes, 0x20, 0x2233000100012000n);

  // __objc_protolist at fileOffset 0x30, size 8 (1 chained_offset ptr)
  writeU64(imageBytes, 0x30, encodeChained64(0x14000n));

  // __objc_selrefs at fileOffset 0x40, size 16 (2 chained_offset ptrs)
  writeU64(imageBytes, 0x40, encodeChained64(0x18000n));
  writeU64(imageBytes, 0x48, encodeChained64(0x18010n));

  // __swift5_types at fileOffset 0x60, size 12 (2 valid rel32 + 1 indirect-zero skipped)
  writeI32(imageBytes, 0x60, 0x100);
  writeI32(imageBytes, 0x64, 1); // indirect with eff_disp=0 -> skipped
  writeI32(imageBytes, 0x68, 0x201); // indirect +0x200

  // __swift5_proto at fileOffset 0x70, size 4
  writeI32(imageBytes, 0x70, -0x40);

  // __swift5_protos at fileOffset 0x80, size 4
  writeI32(imageBytes, 0x80, 0x80);

  // __swift5_fieldmd at fileOffset 0x100, size 56 (2 descriptors: 40B + 16B)
  writeFieldDescriptor(imageBytes, 0x100, {
    mangledTypeName: 0x300,
    superclass: 0,
    kind: 0,
    recordSize: 12,
    numFields: 2,
  });
  writeFieldDescriptor(imageBytes, 0x100 + 40, {
    mangledTypeName: -0x20,
    superclass: 0x10,
    kind: 2,
    recordSize: 0,
    numFields: 0,
  });

  const mockImage = {
    imageBase,
    bytes: imageBytes,
    sections: [
      { name: '__objc_classlist', fileOffset: 0x00, size: 16, vaddr: 0x100050000n },
      { name: '__objc_catlist', fileOffset: 0x20, size: 8, vaddr: 0x100050020n },
      { name: '__objc_protolist', fileOffset: 0x30, size: 8, vaddr: 0x100050030n },
      { name: '__objc_selrefs', fileOffset: 0x40, size: 16, vaddr: 0x100050040n },
      { name: '__swift5_types', fileOffset: 0x60, size: 12, vaddr: 0x100060000n },
      { name: '__swift5_proto', fileOffset: 0x70, size: 4, vaddr: 0x100060100n },
      { name: '__swift5_protos', fileOffset: 0x80, size: 4, vaddr: 0x100060200n },
      { name: '__swift5_fieldmd', fileOffset: 0x100, size: 56, vaddr: 0x100070000n },
      { name: '__text', fileOffset: 0x200, size: 64, vaddr: 0x100004000n }, // ignored
    ],
  };

  const wasmRes = scanObjcSwiftMetadataFromImage(mockImage, baseOpts());
  const jsRes = scanObjcSwiftMetadataFromImage(mockImage, { engine: 'js' });

  assert.equal(wasmRes.engine, 'wasm');
  assert.equal(jsRes.engine, 'js');
  assert.equal(wasmRes.truncated, false);
  assert.deepEqual(wasmRes.sectionsScanned, [
    '__objc_classlist',
    '__objc_catlist',
    '__objc_protolist',
    '__objc_selrefs',
    '__swift5_types',
    '__swift5_proto',
    '__swift5_protos',
    '__swift5_fieldmd',
  ]);
  assert.deepEqual(wasmRes.counts, {
    objcClassList: 1,
    objcCatList: 1,
    objcProtoList: 1,
    objcSelRefs: 2,
    swift5Types: 2,
    swift5Proto: 1,
    swift5Protos: 1,
    swift5FieldMd: 2,
    total: 11,
  });
  assert.deepEqual(wasmRes.objc, jsRes.objc);
  assert.deepEqual(wasmRes.swift5, jsRes.swift5);
  assert.deepEqual(wasmRes.counts, jsRes.counts);
});
