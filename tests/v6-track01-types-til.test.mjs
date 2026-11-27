import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compileTil1 } from '../js/analysis/types/core/til-binary-compiler.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hex-v6-track01-'));

const HEX_OK = 0;
const HEX_ERR_INVALID_ARG = 1;
const HEX_ERR_OOM = 2;
const HEX_ERR_RESOURCE_LIMIT = 3;
const HEX_ERR_UNSUPPORTED = 4;

const HEX_PROFILE_MOBILE = 0;
const HEX_PROFILE_DESKTOP = 1;

const HEX_ABI_FLAG_HAS_THIS = 1 << 1;
const HEX_ABI_FLAG_IS_VARIADIC = 1 << 3;
const HEX_ABI_FLAG_IS_RECURSIVE = 1 << 5;
const HEX_CONFIDENCE_USER_PINNED = 255;

const HEX_ARG_CLASS_I32 = 3;
const HEX_ARG_CLASS_F64 = 8;
const HEX_ARG_CLASS_PTR = 9;
const HEX_ARG_CLASS_STRUCT_PTR = 10;
const HEX_ARG_CLASS_ENUM = 12;

const HEX_PIN_GP0 = 1 << 0;
const HEX_PIN_RET = 1 << 8;

const HEX_RET_USED_PASSTHROUGH = 1 << 1;
const HEX_RET_USED_TAILCALL = 1 << 3;

const HEX_SITE_FLAG_VARIADIC = 1 << 2;

const HEX_TIL_FLAG_IS_CORE = 1 << 0;
const HEX_TIL_FLAG_LOCAL_TID_RELATIVE = 1 << 1;

const HEX_TIL_LOOKUP_RAW_ONLY = 1 << 0;
const HEX_TIL_LOOKUP_DEFAULT = (1 << 1) | (1 << 2);

const KiB = 1024;
const MiB = 1024 * 1024;

function fnv1a64(str) {
  const bytes = Buffer.from(str, 'utf8');
  let h = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  for (let i = 0; i < bytes.length; i++) {
    h ^= BigInt(bytes[i]);
    h = (h * prime) & mask;
  }
  return h;
}

function fnv1a32Til(buf) {
  let h = 0x811c9dc5;
  for (let i = 0; i < buf.length; i++) {
    const b = i >= 0x20 && i <= 0x23 ? 0 : buf[i];
    h = Math.imul(h ^ b, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

function makeHexTypeId(baseTil, ptrDepth = 0, isConst = 0, isPac = 0, kindTag = 0, auxMeta = 0) {
  return (
    ((auxMeta & 0xff) << 24) |
    ((kindTag & 7) << 21) |
    ((ptrDepth >= 1 && isPac ? 1 : 0) << 20) |
    ((isConst ? 1 : 0) << 19) |
    ((ptrDepth & 7) << 16) |
    (baseTil & 0xffff)
  ) >>> 0;
}

// Local helper builder (dense implicit local_tid=0) for low-level malformed tests
function buildTil1Blob({ flags = 0, symbols = [], selectors = [], types = [] }) {
  const strChunks = [];
  let strCursor = 0;
  const addStr = (s) => {
    const off = strCursor;
    const b = Buffer.from(s + '\0', 'utf8');
    strChunks.push(b);
    strCursor += b.length;
    return off;
  };

  const sigBlobs = [];
  let sigRelCursor = 0;
  const buildSig = (item) => {
    const nameOff = addStr(item.name);
    const params = item.params || [];
    assert(params.length <= 12);
    const relOff = sigRelCursor;
    const sz = 12 + params.length * 4;
    const buf = Buffer.alloc(sz);
    buf.writeUInt32LE(nameOff, 0);
    buf.writeUInt32LE(item.retType >>> 0, 4);
    buf.writeUInt8(item.flags || 0, 8);
    buf.writeUInt8(params.length, 9);
    buf.writeUInt8(item.fmtArgIdx ?? 0xff, 10);
    buf.writeUInt8(item.callConv || 0, 11);
    for (let i = 0; i < params.length; i++) {
      buf.writeUInt32LE(params[i] >>> 0, 12 + i * 4);
    }
    sigBlobs.push(buf);
    sigRelCursor += sz;
    return relOff;
  };

  const symEntries = symbols.map((s) => ({
    hash: fnv1a64(s.name),
    relSigOff: buildSig(s),
  }));
  symEntries.sort((a, b) => (a.hash < b.hash ? -1 : a.hash > b.hash ? 1 : 0));

  const selEntries = selectors.map((s) => ({
    hash: fnv1a64(s.name),
    relSigOff: buildSig(s),
  }));
  selEntries.sort((a, b) => (a.hash < b.hash ? -1 : a.hash > b.hash ? 1 : 0));

  const typeEntries = types.map((t) => ({
    kind: t.kind || 0,
    bits: t.bits || 0,
    qualifiers: t.qualifiers || 0,
    pointeeTid: t.pointeeTid || 0,
    localTid: t.localTid || 0,
    nameOff: addStr(t.name),
  }));

  const hashIndexOff = 552;
  const selIndexOff = hashIndexOff + symEntries.length * 12;
  const typeDescOff = selIndexOff + selEntries.length * 12;
  const sigPoolOff = typeDescOff + typeEntries.length * 12;
  const strPoolOff = sigPoolOff + sigRelCursor;
  const strBuf = Buffer.concat(strChunks.length ? strChunks : [Buffer.from([0])]);
  const totalLen = strPoolOff + strBuf.length;

  const out = Buffer.alloc(totalLen);
  out.write('TIL1', 0, 4, 'ascii');
  out.writeUInt16LE(1, 4);
  out.writeUInt16LE(flags, 6);
  out.writeUInt32LE(symEntries.length, 8);
  out.writeUInt32LE(selEntries.length, 12);
  out.writeUInt32LE(typeEntries.length, 16);
  out.writeUInt32LE(sigPoolOff, 20);
  out.writeUInt32LE(strPoolOff, 24);
  out.writeUInt32LE(0, 28);
  out.writeUInt32LE(0, 32);

  const counts = new Uint16Array(256);
  for (const e of symEntries) counts[Number((e.hash >> 56n) & 0xffn)]++;
  let acc = 0;
  for (let b = 0; b < 256; b++) {
    out.writeUInt16LE(acc, 36 + b * 2);
    acc += counts[b];
  }
  out.writeUInt16LE(acc, 36 + 256 * 2);
  out.writeUInt16LE(0, 36 + 257 * 2);

  for (let i = 0; i < symEntries.length; i++) {
    const off = hashIndexOff + i * 12;
    out.writeUInt32LE(Number(symEntries[i].hash & 0xffffffffn), off);
    out.writeUInt32LE(Number((symEntries[i].hash >> 32n) & 0xffffffffn), off + 4);
    out.writeUInt32LE(sigPoolOff + symEntries[i].relSigOff, off + 8);
  }
  for (let i = 0; i < selEntries.length; i++) {
    const off = selIndexOff + i * 12;
    out.writeUInt32LE(Number(selEntries[i].hash & 0xffffffffn), off);
    out.writeUInt32LE(Number((selEntries[i].hash >> 32n) & 0xffffffffn), off + 4);
    out.writeUInt32LE(sigPoolOff + selEntries[i].relSigOff, off + 8);
  }
  for (let i = 0; i < typeEntries.length; i++) {
    const off = typeDescOff + i * 12;
    const t = typeEntries[i];
    out.writeUInt16LE(t.kind, off);
    out.writeUInt8(t.bits, off + 2);
    out.writeUInt8(t.qualifiers, off + 3);
    out.writeUInt16LE(t.pointeeTid, off + 4);
    out.writeUInt16LE(t.localTid, off + 6);
    out.writeUInt32LE(t.nameOff, off + 8);
  }
  let curSig = sigPoolOff;
  for (const sb of sigBlobs) {
    sb.copy(out, curSig);
    curSig += sb.length;
  }
  strBuf.copy(out, strPoolOff);
  out.writeUInt32LE(fnv1a32Til(out), 32);
  return out;
}

const CPP_SRCS = [
  path.join(ROOT, 'cpp/src/analysis/type_arena.cpp'),
  path.join(ROOT, 'cpp/src/analysis/sig_prop_wasm.cpp'),
  path.join(ROOT, 'cpp/src/analysis/til_engine.cpp'),
];

try {
  // --------------------------------------------------------------------------
  // 1. Compile Track 1 C++ sources for BOTH host syntax/static_assert AND wasm32
  // --------------------------------------------------------------------------
  console.log('[Track 1] Checking host C++20 compilation & static_asserts...');
  for (const src of CPP_SRCS) {
    execFileSync(
      'clang++',
      ['-std=c++20', '-O2', '-Wall', '-Wextra', '-fsyntax-only', `-I${path.join(ROOT, 'cpp/include')}`, src],
      { stdio: 'inherit' }
    );
  }

  const wasmOut = path.join(TMP_DIR, 'v6_track01.wasm');
  console.log('[Track 1] Compiling standalone wasm32 module...');
  execFileSync(
    'clang++',
    [
      '--target=wasm32',
      '-std=c++20',
      '-O3',
      '-nostdlib',
      '-fno-exceptions',
      '-fno-rtti',
      '-fno-builtin',
      '-mbulk-memory',
      '-Wall',
      '-Wextra',
      `-I${path.join(ROOT, 'cpp/include')}`,
      '-Wl,--no-entry',
      '-Wl,--export-dynamic',
      '-Wl,--initial-memory=262144',
      '-Wl,--max-memory=67108864',
      '-Wl,-z,stack-size=65536',
      '-o',
      wasmOut,
      ...CPP_SRCS,
    ],
    { stdio: 'inherit' }
  );

  const wasmBytes = fs.readFileSync(wasmOut);
  const wasmMod = new WebAssembly.Module(wasmBytes);
  const imports = WebAssembly.Module.imports(wasmMod);
  assert.equal(imports.length, 0, `Expected 0 external WASM imports, got: ${JSON.stringify(imports)}`);
  console.log(`[Track 1] Verified wasm32 build (${wasmBytes.length} B, 0 external imports).`);

  const instance = await WebAssembly.instantiate(wasmMod, {});
  const ex = instance.exports;

  const dv = () => new DataView(ex.memory.buffer);
  const u8 = () => new Uint8Array(ex.memory.buffer);

  const writeBytesToSlot = (slotId, bytes) => {
    const ptr = ex.hex_type_arena_bump_alloc(slotId, bytes.length, 8);
    assert(ptr !== 0, `bump_alloc failed on slot ${slotId} for ${bytes.length} bytes`);
    u8().set(bytes, ptr);
    return ptr;
  };

  // --------------------------------------------------------------------------
  // 2. Profile Switching (Mobile / Desktop) & Slot Boundaries
  // --------------------------------------------------------------------------
  assert.equal(ex.hex_type_arena_init(), HEX_OK);
  assert.equal(ex.hex_get_runtime_profile(), HEX_PROFILE_MOBILE);
  assert.equal(ex.hex_set_runtime_profile(99), HEX_ERR_INVALID_ARG);

  const expectedMobileCaps = [
    160 * KiB,
    256 * KiB,
    256 * KiB,
    128 * KiB,
    224 * KiB,
    512 * KiB,
    512 * KiB,
    4 * MiB,
    2 * MiB,
  ];
  let expectedOff = 0;
  const infoScratch = ex.hex_type_arena_bump_alloc(5, 64, 8);
  assert(infoScratch !== 0);
  for (let s = 0; s < 9; s++) {
    assert.equal(ex.hex_type_arena_slot_cap(s), expectedMobileCaps[s], `Mobile slot ${s} cap`);
    assert.equal(ex.hex_type_arena_slot_info(s, infoScratch), HEX_OK);
    const view = dv();
    assert.equal(view.getUint32(infoScratch + 0, true), s);
    assert.equal(view.getUint32(infoScratch + 4, true), expectedOff, `Mobile slot ${s} offset`);
    assert.equal(view.getUint32(infoScratch + 8, true), expectedMobileCaps[s]);
    expectedOff += expectedMobileCaps[s];
  }
  assert.equal(expectedOff, 8 * MiB);

  const memBeforeGrow = ex.memory.buffer.byteLength;
  const volBPtr = ex.hex_type_arena_slot_ptr(8);
  assert(volBPtr !== 0);
  assert(ex.memory.buffer.byteLength > memBeforeGrow, 'Expected lazy memory.grow');
  u8()[volBPtr] = 0xaa;
  u8()[volBPtr + 2 * MiB - 1] = 0xbb;
  assert.equal(u8()[volBPtr], 0xaa);
  assert.equal(u8()[volBPtr + 2 * MiB - 1], 0xbb);

  assert.equal(ex.hex_set_runtime_profile(HEX_PROFILE_DESKTOP), HEX_OK);
  assert.equal(ex.hex_get_runtime_profile(), HEX_PROFILE_DESKTOP);
  const expectedDesktopCaps = [
    160 * KiB,
    256 * KiB,
    256 * KiB,
    128 * KiB,
    224 * KiB,
    3 * MiB,
    4 * MiB,
    24 * MiB,
    16 * MiB,
  ];
  expectedOff = 0;
  const infoScratchD = ex.hex_type_arena_bump_alloc(5, 64, 8);
  for (let s = 0; s < 9; s++) {
    assert.equal(ex.hex_type_arena_slot_cap(s), expectedDesktopCaps[s]);
    assert.equal(ex.hex_type_arena_slot_info(s, infoScratchD), HEX_OK);
    assert.equal(dv().getUint32(infoScratchD + 4, true), expectedOff);
    expectedOff += expectedDesktopCaps[s];
  }
  assert.equal(expectedOff, 48 * MiB);

  assert.equal(ex.hex_type_arena_slot_cap(9), 0);
  assert.equal(ex.hex_type_arena_slot_ptr(9), 0);
  assert.equal(ex.hex_type_arena_alloc_slot(0, 160 * KiB + 1), 0);
  assert.equal(ex.hex_type_arena_alloc_slot(0, 0), 0);
  assert.equal(ex.hex_type_arena_bump_alloc(3, 128 * KiB + 1, 8), 0);
  assert.equal(ex.hex_type_arena_bump_alloc(3, 16, 3), 0);
  assert.equal(ex.hex_type_arena_reset_slot(9), HEX_ERR_INVALID_ARG);

  assert.equal(ex.hex_set_runtime_profile(HEX_PROFILE_MOBILE), HEX_OK);
  console.log('[Track 1] PASS: Profile switching, 9-slot boundaries, lazy grow, and OOB checks.');

  // --------------------------------------------------------------------------
  // 3. Real compileTil1() JS <-> WASM Integration, Sparse TIDs, Priority,
  //    Arena Reset Invalidation & Malformed Rejection
  // --------------------------------------------------------------------------
  const VOID_PTR = makeHexTypeId(0x0001, 1, 0, 0, 0, 0);
  const CONST_CHAR_PTR = makeHexTypeId(0x0003, 1, 1, 0, 0, 0);
  const U64_T = makeHexTypeId(0x000a, 0, 0, 0, 0, 0);
  const I32_T = makeHexTypeId(0x0007, 0, 0, 0, 0, 0);
  const OBJC_ID_T = makeHexTypeId(0x0011, 0, 0, 0, 6, 0);

  // Build real TIL1 blobs using js/analysis/types/core/til-binary-compiler.js compileTil1()
  const coreBlob = compileTil1({
    isCore: true,
    localTidRelative: false,
    functions: [
      { name: 'malloc', retHexType: VOID_PTR, flags: 1 << 5, paramHexTypes: [U64_T] },
      { name: 'strlen', retHexType: U64_T, paramHexTypes: [CONST_CHAR_PTR] },
      { name: '_Z3fooi', retHexType: I32_T, paramHexTypes: [I32_T] },
    ],
    selectors: [
      { name: '+NSObject:alloc', retHexType: OBJC_ID_T, paramHexTypes: [OBJC_ID_T] },
    ],
    types: [
      { tid: 0x0040, name: 'FILE', kind: 1, bits: 64, qualifiers: 0, pointeeTid: 0 },
      { tid: 0x0048, name: 'SparseCoreType', kind: 1, bits: 32, qualifiers: 0, pointeeTid: 0x0007 },
    ],
  });

  // Pack A (Slot 1) with sparse explicit pack-local TIDs (0x1005, 0x102A) + non-pack Local TID ref (0x6010)
  const packABlob = compileTil1({
    isCore: false,
    localTidRelative: true,
    functions: [
      { name: 'malloc', retHexType: makeHexTypeId(0x1005, 1, 0, 0, 1, 0), paramHexTypes: [U64_T] },
      {
        name: 'pack_a_local_ref',
        // 0x6010 is in Local Header range [0x6000..0x7FFF]: must NOT be remapped by remap_tid!
        retHexType: makeHexTypeId(0x6010, 1, 0, 0, 1, 0),
        paramHexTypes: [makeHexTypeId(0x102a, 1, 0, 0, 1, 0)],
      },
    ],
    types: [
      { tid: 0x1005, name: 'SparsePackAType5', kind: 1, bits: 64, qualifiers: 0, pointeeTid: 0x0007 },
      { tid: 0x102a, name: 'SparsePackAType42', kind: 1, bits: 128, qualifiers: 1, pointeeTid: 0x1005 },
    ],
  });

  // Pack B (Slot 2) with tid_base = 0x2000 -> local 0x1000 remaps to 0x2000
  const packBBlob = compileTil1({
    isCore: false,
    localTidRelative: true,
    functions: [
      { name: 'malloc', retHexType: makeHexTypeId(0x1000, 1, 0, 0, 1, 0), paramHexTypes: [U64_T, U64_T] },
    ],
    types: [
      { tid: 0x1000, name: 'PackBType', kind: 1, bits: 128, qualifiers: 1, pointeeTid: 0x1000 },
    ],
  });

  // User Header (Slot 3) with explicit Local TID 0x6010 (stays 0x6010, not remapped!)
  const userBlob = compileTil1({
    isCore: false,
    localTidRelative: true,
    functions: [
      { name: 'malloc', retHexType: makeHexTypeId(0x6010, 1, 0, 0, 1, 0), paramHexTypes: [U64_T, I32_T, I32_T] },
    ],
    types: [
      { tid: 0x6010, name: 'UserCustomStruct', kind: 1, bits: 64, qualifiers: 0, pointeeTid: 0 },
    ],
  });

  ex.hex_type_arena_reset_slot(8);
  const corePtr = writeBytesToSlot(8, coreBlob);
  const packAPtr = writeBytesToSlot(8, packABlob);
  const packBPtr = writeBytesToSlot(8, packBBlob);
  const userPtr = writeBytesToSlot(8, userBlob);

  // Verify Slot 1..3 reject tid_base < TIL_PACK_MIN (0x1000)
  assert.equal(ex.hex_til_mount(1, packAPtr, packABlob.length, 0x0040, 0x100), HEX_ERR_INVALID_ARG);
  assert.equal(ex.hex_til_mount(2, packBPtr, packBBlob.length, 0x0fff, 0x100), HEX_ERR_INVALID_ARG);
  assert.equal(ex.hex_til_mount(3, userPtr, userBlob.length, 0x0000, 0x100), HEX_ERR_INVALID_ARG);

  assert.equal(ex.hex_til_load(corePtr, coreBlob.length), HEX_OK);
  assert.equal(ex.hex_til_mount_pack(1, 0x1800, 0x0a00, packAPtr, packABlob.length), HEX_OK);
  assert.equal(ex.hex_til_mount_pack(2, 0x2000, 0x0a00, packBPtr, packBBlob.length), HEX_OK);
  assert.equal(ex.hex_til_mount_pack(3, 0x6000, 0x1000, userPtr, userBlob.length), HEX_OK);

  const recPtr = ex.hex_type_arena_bump_alloc(5, 64, 8);
  const statsPtr = ex.hex_type_arena_bump_alloc(5, 32, 8);
  const typeRecPtr = ex.hex_type_arena_bump_alloc(5, 24, 8);
  const nameBufPtr = ex.hex_type_arena_bump_alloc(5, 64, 8);
  const nameLenPtr = ex.hex_type_arena_bump_alloc(5, 8, 8);

  const lookupSym = (sym, slotMask = 0x0f, flags = HEX_TIL_LOOKUP_DEFAULT) => {
    ex.hex_type_arena_reset_slot(6);
    const sp = writeBytesToSlot(6, Buffer.from(sym, 'utf8'));
    const st = ex.hex_til_lookup_symbol(sp, Buffer.byteLength(sym, 'utf8'), slotMask, flags, recPtr);
    if (st !== HEX_OK) return { status: st };
    const v = dv();
    return {
      status: st,
      retHexType: v.getUint32(recPtr + 0, true),
      flags: v.getUint8(recPtr + 4),
      arity: v.getUint8(recPtr + 5),
      matchedSlot: v.getUint8(recPtr + 10),
      param0: v.getUint32(recPtr + 16, true),
    };
  };

  // Verify sparse explicit TIDs from compileTil1():
  // Core sparse TID 0x0048
  assert.equal(ex.hex_til_lookup_type(0x0048, typeRecPtr), HEX_OK);
  assert.equal(dv().getUint32(typeRecPtr + 8, true), 4);
  assert.equal(ex.hex_til_get_type_name(0x0048, nameBufPtr, 64, nameLenPtr), HEX_OK);
  assert.equal(
    Buffer.from(u8().subarray(nameBufPtr, nameBufPtr + dv().getUint32(nameLenPtr, true))).toString('utf8'),
    'SparseCoreType'
  );

  // Pack A mounted at tid_base=0x1800: local 0x1005 -> 0x1805, local 0x102A -> 0x182A
  assert.equal(ex.hex_til_lookup_type(0x182a, typeRecPtr), HEX_OK);
  assert.equal(dv().getUint16(typeRecPtr + 18, true), 0x1805, 'pointeeTid 0x1005 must remap to 0x1805');
  assert.equal(dv().getUint8(typeRecPtr + 23), 1);

  // Verify remap_tid leaves 0x6010 (Local Header range) untouched in Pack A function sig
  let res = lookupSym('pack_a_local_ref');
  assert.equal(res.status, HEX_OK);
  assert.equal(res.retHexType & 0xffff, 0x6010, '0x6010 must NOT be remapped');
  assert.equal(res.param0 & 0xffff, 0x182a, '0x102a must remap to 0x182a');

  // Verify alignment-safe hex_til_lookup (unaligned output pointer +1)
  ex.hex_type_arena_reset_slot(6);
  const unalignedOut = ex.hex_type_arena_bump_alloc(6, 80, 8) + 1;
  const symBufP = writeBytesToSlot(6, Buffer.from('malloc', 'utf8'));
  assert.equal(ex.hex_til_lookup(symBufP, 6, 0x0f, HEX_TIL_LOOKUP_DEFAULT, unalignedOut), HEX_OK);
  assert.equal(dv().getUint8(unalignedOut + 10), 3);

  // Priority test: Slot 3 > Slot 2 > Slot 1 > Slot 0
  res = lookupSym('malloc');
  assert.equal(res.status, HEX_OK);
  assert.equal(res.matchedSlot, 3);
  assert.equal(res.arity, 3);
  assert.equal(res.retHexType & 0xffff, 0x6010);

  // Underscore stripping & RAW_ONLY & mangled symbol preservation
  assert.equal(lookupSym('_malloc').matchedSlot, 3);
  assert.equal(lookupSym('_malloc', 0x0f, HEX_TIL_LOOKUP_RAW_ONLY).status, HEX_ERR_RESOURCE_LIMIT);
  assert.equal(lookupSym('_Z3fooi').matchedSlot, 0);

  // Selector lookup via unaligned buffer
  ex.hex_type_arena_reset_slot(6);
  const selUnaligned = ex.hex_type_arena_bump_alloc(6, 80, 8) + 1;
  const selKey = '+NSObject:alloc';
  const selPtr = writeBytesToSlot(6, Buffer.from(selKey, 'utf8'));
  assert.equal(ex.hex_til_lookup_selector(selPtr, selKey.length, 0x0f, selUnaligned), HEX_OK);
  assert.equal(dv().getUint32(selUnaligned + 0, true), OBJC_ID_T);

  // Arena Reset Invalidation test (Use-After-Reset protection):
  // Reset Slot 3 directly in type_arena WITHOUT calling hex_til_unmount_pack(3)
  assert.equal(ex.hex_type_arena_reset_slot(3), HEX_OK);
  res = lookupSym('malloc');
  assert.equal(res.status, HEX_OK);
  assert.equal(res.matchedSlot, 2, 'Resetting Slot 3 in arena must invalidate Slot 3 TIL immediately');
  assert.equal(ex.hex_til_lookup_type(0x6010, typeRecPtr), HEX_ERR_RESOURCE_LIMIT);
  assert.equal(ex.hex_til_stats(statsPtr), HEX_OK);
  assert.equal(dv().getUint32(statsPtr + 0, true), 0x07, 'Stats must exclude arena-reset Slot 3');

  // Purge packs -> Slot 0 (Core TIL) remains live
  ex.hex_til_purge_packs();
  res = lookupSym('malloc');
  assert.equal(res.status, HEX_OK);
  assert.equal(res.matchedSlot, 0);
  assert.equal(res.retHexType, VOID_PTR);

  // Malformed TIL1 rejection
  ex.hex_type_arena_reset_slot(8);
  const rawBlob = buildTil1Blob({
    flags: HEX_TIL_FLAG_IS_CORE,
    symbols: [{ name: 'test_fn', retType: I32_T, params: [I32_T] }],
  });
  assert.equal(ex.hex_til_mount(1, writeBytesToSlot(8, rawBlob.subarray(0, 100)), 100, 0x1000, 0x100), HEX_ERR_INVALID_ARG);
  const badMagic = Buffer.from(rawBlob);
  badMagic[3] = 'X'.charCodeAt(0);
  badMagic.writeUInt32LE(fnv1a32Til(badMagic), 32);
  assert.equal(ex.hex_til_mount(1, writeBytesToSlot(8, badMagic), badMagic.length, 0x1000, 0x100), HEX_ERR_INVALID_ARG);
  const badVer = Buffer.from(rawBlob);
  badVer.writeUInt16LE(2, 4);
  badVer.writeUInt32LE(fnv1a32Til(badVer), 32);
  assert.equal(ex.hex_til_mount(1, writeBytesToSlot(8, badVer), badVer.length, 0x1000, 0x100), HEX_ERR_UNSUPPORTED);
  const badCksum = Buffer.from(rawBlob);
  badCksum[badCksum.length - 2] ^= 0xff;
  assert.equal(ex.hex_til_mount(1, writeBytesToSlot(8, badCksum), badCksum.length, 0x1000, 0x100), HEX_ERR_INVALID_ARG);
  assert.equal(ex.hex_til_mount(3, corePtr, 128 * KiB + 16, 0x6000, 0x100), HEX_ERR_OOM);

  console.log('[Track 1] PASS: compileTil1() integration, sparse TIDs, priority, reset invalidation, malformed rejection.');

  // --------------------------------------------------------------------------
  // 4. Direct hex_analyze_callgraph_scc_order + hex_propagate_sig_window tests
  // --------------------------------------------------------------------------
  ex.hex_type_arena_reset_slot(8);
  const sccEdgeSrc = Buffer.alloc(4 * 4);
  const sccEdgeDst = Buffer.alloc(4 * 4);
  // 0 -> 1, 1 -> 2, 2 -> 1 (cycle {1,2}), 0 -> 3 (leaf 3)
  [0, 1, 2, 0].forEach((s, i) => sccEdgeSrc.writeUInt32LE(s, i * 4));
  [1, 2, 1, 3].forEach((d, i) => sccEdgeDst.writeUInt32LE(d, i * 4));
  const srcPtr = writeBytesToSlot(8, sccEdgeSrc);
  const dstPtr = writeBytesToSlot(8, sccEdgeDst);
  const scratchPtr = ex.hex_type_arena_bump_alloc(8, 4096, 8);
  const sccOut = ex.hex_type_arena_bump_alloc(8, 16, 8);
  const topoOut = ex.hex_type_arena_bump_alloc(8, 16, 8);
  const numSccsOut = ex.hex_type_arena_bump_alloc(8, 8, 8);

  // Unaligned scratch_ptr must be rejected with HEX_ERR_INVALID_ARG
  assert.equal(
    ex.hex_analyze_callgraph_scc_order(4, srcPtr, dstPtr, 4, scratchPtr + 1, 4000, sccOut, topoOut, numSccsOut),
    HEX_ERR_INVALID_ARG
  );
  // Valid aligned call
  assert.equal(
    ex.hex_analyze_callgraph_scc_order(4, srcPtr, dstPtr, 4, scratchPtr, 4096, sccOut, topoOut, numSccsOut),
    HEX_OK
  );
  assert.equal(dv().getUint32(numSccsOut, true), 3);
  assert.equal(dv().getUint32(sccOut + 4, true), dv().getUint32(sccOut + 8, true), '{1,2} share SCC');
  assert(dv().getUint32(sccOut + 4, true) < dv().getUint32(sccOut + 0, true), 'callee SCC before caller 0');

  // hex_propagate_sig_window CSR validation + non-NULL pin_mask + variadic guard + arg_class lattice
  const writeSigBuf = (buf, idx, s) => {
    const o = idx * 16;
    buf.writeUInt8(s.abiFlags || 0, o + 0);
    buf.writeUInt8(s.gpMask || 0, o + 1);
    buf.writeUInt8(s.fpMask || 0, o + 2);
    buf.writeUInt8(s.ptrMask || 0, o + 3);
    buf.writeUInt8(s.retInfo || 0, o + 4);
    buf.writeUInt8(s.confidence || 0, o + 5);
    buf.writeUInt16LE(s.retTil || 0, o + 6);
    buf.writeUInt16LE(s.thisTil || 0, o + 8);
    buf.writeUInt16LE(s.extIdx ?? 0xffff, o + 10);
    buf.writeUInt16LE(s.argClass || 0, o + 12);
    buf.writeUInt16LE(s.signedMask || 0, o + 14);
  };

  // Test invalid CSR row_ptr in hex_propagate_sig_window
  const badRow0 = Buffer.alloc(12);
  badRow0.writeUInt32LE(1, 0); // row_ptr[0] != 0
  badRow0.writeUInt32LE(1, 4);
  badRow0.writeUInt32LE(1, 8);
  const badRowNonMono = Buffer.alloc(12);
  badRowNonMono.writeUInt32LE(0, 0);
  badRowNonMono.writeUInt32LE(2, 4);
  badRowNonMono.writeUInt32LE(1, 8); // decreasing!
  const dummySigs = ex.hex_type_arena_bump_alloc(8, 32, 8);
  const dummyFacts = ex.hex_type_arena_bump_alloc(8, 32, 8);
  assert.equal(
    ex.hex_propagate_sig_window(2, writeBytesToSlot(8, badRow0), dummyFacts, 2, dummySigs, 2, 0, 0, 0, 4),
    HEX_ERR_INVALID_ARG
  );
  assert.equal(
    ex.hex_propagate_sig_window(2, writeBytesToSlot(8, badRowNonMono), dummyFacts, 2, dummySigs, 2, 0, 0, 0, 4),
    HEX_ERR_INVALID_ARG
  );

  // Test valid hex_propagate_sig_window with:
  //   caller 0 -> callee 2 (normal): pin_mask pins GP0 & RET on caller 0, leaves GP1 unpinned
  //   caller 1 -> callee 3 (variadic printf-like: gp_arg_mask=0x01, ptr_arg_mask=0x03, arg_class x1=ENUM):
  //     fixed x0 must propagate, variadic x1 must be blocked!
  const winRow = Buffer.alloc(3 * 4);
  winRow.writeUInt32LE(0, 0);
  winRow.writeUInt32LE(1, 4);
  winRow.writeUInt32LE(2, 8);
  const winFacts = Buffer.alloc(2 * 16);
  // fact 0: caller 0 -> callee 2 (x0->x0, x1->x1, x2->x2, passthrough ret)
  winFacts.writeUInt32LE(2, 0);
  winFacts.writeUInt32LE(0xfffff210 >>> 0, 4);
  winFacts.writeUInt16LE(0xffff, 8);
  winFacts.writeUInt8(HEX_RET_USED_PASSTHROUGH, 10);
  winFacts.writeUInt8(0, 11);
  winFacts.writeUInt32LE(0xffffffff, 12);
  // fact 1: caller 1 -> callee 3 (variadic, x0->x0, x1->x1, tailcall)
  winFacts.writeUInt32LE(3, 16);
  winFacts.writeUInt32LE(0xffffff10 >>> 0, 20);
  winFacts.writeUInt16LE(0xffff, 24);
  winFacts.writeUInt8(HEX_RET_USED_TAILCALL, 26);
  winFacts.writeUInt8(HEX_SITE_FLAG_VARIADIC, 27);
  winFacts.writeUInt32LE(0xffffffff, 28);

  const winSigs = Buffer.alloc(4 * 16);
  // caller 0: x0 pinned, x1=STRUCT_PTR(10), x2=I32(3), ret pinned to 0x0007
  writeSigBuf(winSigs, 0, {
    retTil: 0x0007,
    argClass: (HEX_ARG_CLASS_STRUCT_PTR << 4) | (HEX_ARG_CLASS_I32 << 8),
  });
  // caller 1: empty
  writeSigBuf(winSigs, 1, {});
  // callee 2: gp=0x07, ptr=0x03, ret=0x6010 (Local Header), x1=ENUM(12), x2=F64(8)
  writeSigBuf(winSigs, 2, {
    gpMask: 0x07,
    ptrMask: 0x03,
    retInfo: 1,
    confidence: 240,
    retTil: 0x6010,
    argClass: (HEX_ARG_CLASS_PTR << 0) | (HEX_ARG_CLASS_ENUM << 4) | (HEX_ARG_CLASS_F64 << 8),
  });
  // callee 3 (variadic): gp_arg_mask=0x01 (only x0 is fixed), fp_arg_mask=0x03, ptr_arg_mask=0x03
  writeSigBuf(winSigs, 3, {
    abiFlags: HEX_ABI_FLAG_IS_VARIADIC,
    gpMask: 0x01,
    fpMask: 0x03,
    ptrMask: 0x03,
    retInfo: 1,
    confidence: 240,
    retTil: 0x0007,
  });

  const winPins = Buffer.alloc(2 * 4);
  winPins.writeUInt32LE(HEX_PIN_GP0 | HEX_PIN_RET, 0);
  winPins.writeUInt32LE(0, 4);

  const winSigsAddr = writeBytesToSlot(8, winSigs);
  assert.equal(
    ex.hex_propagate_sig_window(
      2,
      writeBytesToSlot(8, winRow),
      writeBytesToSlot(8, winFacts),
      2,
      winSigsAddr,
      4,
      writeBytesToSlot(8, winPins),
      0,
      0,
      4
    ),
    HEX_OK
  );

  // Verify caller 0: GP0 & RET stayed pinned, GP1/GP2 propagated, STRUCT_PTR NOT overwritten by ENUM, I32 NOT overwritten by F64
  assert.equal(dv().getUint8(winSigsAddr + 1), 0x06, 'GP0 pinned (0), GP1 & GP2 propagated (0x06)');
  assert.equal(dv().getUint16(winSigsAddr + 6, true), 0x0007, 'RET pinned to 0x0007');
  const c0ArgCls = dv().getUint16(winSigsAddr + 12, true);
  assert.equal((c0ArgCls >> 4) & 0xf, HEX_ARG_CLASS_STRUCT_PTR, 'STRUCT_PTR must not be overwritten by ENUM');
  assert.equal((c0ArgCls >> 8) & 0xf, HEX_ARG_CLASS_I32, 'I32 must not be overwritten by F64');

  // Verify caller 1 (variadic call): fixed x0 propagated, variadic x1 & FP tail-call blocked!
  assert.equal(dv().getUint8(winSigsAddr + 16 + 1), 0x01, 'Only fixed x0 propagates on variadic call');
  assert.equal(dv().getUint8(winSigsAddr + 16 + 3), 0x01, 'Variadic x1 ptr_mask must be blocked');
  assert.equal(dv().getUint8(winSigsAddr + 16 + 2), 0x00, 'Variadic tail-call FP inheritance must be blocked');

  console.log('[Track 1] PASS: scc_order alignment, sig_window CSR validation, pin_mask, variadic guard, arg_class lattice.');

  // --------------------------------------------------------------------------
  // 5. Full hex_sig_prop_run: Tarjan SCC + Fixed-Point + TIL_LOCAL > TIL_RECOVERED
  //    + OOB row_ptr limit check BEFORE dereference
  // --------------------------------------------------------------------------
  ex.hex_type_arena_reset_slot(8);
  const numNodes = 6;
  const edgesByCaller = [
    [{ callee: 1, regMap: 0xffffff10, retUsed: HEX_RET_USED_PASSTHROUGH }],
    [{ callee: 2, regMap: 0xffffff10, retUsed: HEX_RET_USED_PASSTHROUGH }],
    [],
    [{ callee: 4, regMap: 0xffffff10, retUsed: HEX_RET_USED_PASSTHROUGH }],
    [
      { callee: 3, regMap: 0xffffff10, retUsed: 0 },
      { callee: 2, regMap: 0xffffff10, retUsed: HEX_RET_USED_PASSTHROUGH },
    ],
    [{ callee: 2, regMap: 0xffffff10, retUsed: HEX_RET_USED_PASSTHROUGH }],
  ];

  const rowPtrBuf = Buffer.alloc((numNodes + 1) * 4);
  const flatFacts = [];
  let edgeCur = 0;
  for (let u = 0; u < numNodes; u++) {
    rowPtrBuf.writeUInt32LE(edgeCur, u * 4);
    for (const e of edgesByCaller[u]) {
      const fb = Buffer.alloc(16);
      fb.writeUInt32LE(e.callee, 0);
      fb.writeUInt32LE(e.regMap >>> 0, 4);
      fb.writeUInt16LE(0xffff, 8);
      fb.writeUInt8(e.retUsed, 10);
      fb.writeUInt8(0, 11);
      fb.writeUInt32LE(0xffffffff, 12);
      flatFacts.push(fb);
      edgeCur++;
    }
  }
  rowPtrBuf.writeUInt32LE(edgeCur, numNodes * 4);
  const factsBuf = Buffer.concat(flatFacts);

  const sigsBuf = Buffer.alloc(numNodes * 16);
  // Node 0: has Recovered Struct (0x8009, rank 4) -> SHOULD be promoted by Local Header (0x6010, rank 5)!
  // Also x1 has I32 (rank 1) -> SHOULD be promoted by ENUM (rank 2)!
  writeSigBuf(sigsBuf, 0, {
    retTil: 0x8009,
    retInfo: 5,
    confidence: 100,
    argClass: HEX_ARG_CLASS_I32 << 4,
  });
  writeSigBuf(sigsBuf, 1, {});
  // Node 2 (leaf): Local Header retTil 0x6010 (rank 5 > recovered 0x8009 rank 4) + x1 ENUM
  writeSigBuf(sigsBuf, 2, {
    abiFlags: HEX_ABI_FLAG_HAS_THIS,
    gpMask: 0x03,
    ptrMask: 0x01,
    retInfo: 1,
    confidence: 240,
    retTil: 0x6010,
    thisTil: 0x8001,
    argClass: HEX_ARG_CLASS_ENUM << 4,
  });
  writeSigBuf(sigsBuf, 3, {});
  writeSigBuf(sigsBuf, 4, {});
  writeSigBuf(sigsBuf, 5, {
    gpMask: 0x04,
    ptrMask: 0x00,
    retInfo: 2,
    confidence: HEX_CONFIDENCE_USER_PINNED,
    retTil: 0x000e,
  });

  const rowPtrAddr = writeBytesToSlot(8, rowPtrBuf);
  const factsAddr = writeBytesToSlot(8, factsBuf);
  const sigsAddr = writeBytesToSlot(8, sigsBuf);
  const outSccAddr = ex.hex_type_arena_bump_alloc(8, numNodes * 4, 8);
  const outTopoAddr = ex.hex_type_arena_bump_alloc(8, numNodes * 4, 8);
  const outNumSccsAddr = ex.hex_type_arena_bump_alloc(8, 4, 8);

  assert.equal(
    ex.hex_sig_prop_run(
      numNodes,
      rowPtrAddr,
      factsAddr,
      edgeCur,
      sigsAddr,
      0,
      0,
      0,
      0,
      outSccAddr,
      outTopoAddr,
      outNumSccsAddr
    ),
    HEX_OK
  );

  assert.equal(dv().getUint32(outNumSccsAddr, true), 5);
  assert.equal(dv().getUint32(outSccAddr + 3 * 4, true), dv().getUint32(outSccAddr + 4 * 4, true));
  assert(dv().getUint32(outSccAddr + 2 * 4, true) < dv().getUint32(outSccAddr + 1 * 4, true));
  assert(dv().getUint32(outSccAddr + 1 * 4, true) < dv().getUint32(outSccAddr + 0 * 4, true));

  const readSig = (idx) => {
    const o = sigsAddr + idx * 16;
    const vw = dv();
    return {
      abiFlags: vw.getUint8(o + 0),
      gpMask: vw.getUint8(o + 1),
      ptrMask: vw.getUint8(o + 3),
      confidence: vw.getUint8(o + 5),
      retTil: vw.getUint16(o + 6, true),
      thisTil: vw.getUint16(o + 8, true),
      argClass: vw.getUint16(o + 12, true),
    };
  };

  // Node 0: Local Header (0x6010) promoted over Recovered Struct (0x8009), I32 promoted to ENUM
  const s0 = readSig(0);
  assert.equal(s0.retTil, 0x6010, 'TIL_LOCAL (0x6010) must outrank TIL_RECOVERED (0x8009)');
  assert.equal((s0.argClass >> 4) & 0xf, HEX_ARG_CLASS_ENUM, 'I32 must promote to ENUM');

  // Cyclic SCC {3, 4} converged and marked recursive
  for (const idx of [3, 4]) {
    const sc = readSig(idx);
    assert.equal(sc.gpMask, 0x03);
    assert.equal(sc.retTil, 0x6010);
    assert((sc.abiFlags & HEX_ABI_FLAG_IS_RECURSIVE) !== 0);
  }

  // USER_PINNED node 5 remained immutable
  const s5 = readSig(5);
  assert.equal(s5.confidence, HEX_CONFIDENCE_USER_PINNED);
  assert.equal(s5.gpMask, 0x04);
  assert.equal(s5.retTil, 0x000e);

  // CRITICAL check: num_nodes > max_sig_prop_nodes with row_ptr near end of linear memory
  // MUST return HEX_ERR_RESOURCE_LIMIT without dereferencing row_ptr[num_nodes] (no OOB trap!)
  const nearEndPtr = ex.memory.buffer.byteLength - 8;
  assert.equal(
    ex.hex_sig_prop_run(0x100000, nearEndPtr, factsAddr, 0, sigsAddr, 0, 0, 0, 0, 0, 0, 0),
    HEX_ERR_RESOURCE_LIMIT
  );

  console.log('[Track 1] PASS: Tarjan SCC, fixed-point propagation, TIL_LOCAL rank, USER_PINNED, OOB-safe limits.');
  console.log('[Track 1] ALL TESTS PASSED (100%).');
} finally {
  fs.rmSync(TMP_DIR, { recursive: true, force: true });
}
