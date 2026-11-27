import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');

// ============================================================================
// 1. Compile Track 2 C++20 sources into a standalone wasm32 module (0 imports)
// ============================================================================

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hex-track02-'));
const wasmPath = path.join(tmpDir, 'track02.wasm');

const cppSources = [
  path.join(ROOT, 'cpp/src/analysis/bitfield_struct_scanner.cpp'),
  path.join(ROOT, 'cpp/src/analysis/hexsig_engine.cpp'),
  path.join(ROOT, 'cpp/src/analysis/sparse_switch_lsda.cpp'),
];

try {
  execFileSync(
    'clang++',
    [
      '--target=wasm32',
      '-std=c++20',
      '-O3',
      '-nostdlib',
      '-fno-exceptions',
      '-fno-rtti',
      '-mbulk-memory',
      '-Wall',
      '-Wextra',
      '-Werror',
      `-I${path.join(ROOT, 'cpp/include')}`,
      '-Wl,--no-entry',
      '-Wl,--export-dynamic',
      '-Wl,--initial-memory=1048576',
      '-Wl,--max-memory=4194304',
      '-o',
      wasmPath,
      ...cppSources,
    ],
    { stdio: 'pipe' }
  );
} catch (err) {
  console.error('WASM compilation failed:\n', err.stderr?.toString() || err.message);
  fs.rmSync(tmpDir, { recursive: true, force: true });
  process.exit(1);
}

const wasmBytes = fs.readFileSync(wasmPath);
const wasmMod = new WebAssembly.Module(wasmBytes);
const imports = WebAssembly.Module.imports(wasmMod);
assert.equal(imports.length, 0, `Expected 0 external WASM imports, got: ${JSON.stringify(imports)}`);

const instance = new WebAssembly.Instance(wasmMod, {});
const ex = instance.exports;

for (const fnName of [
  'hex_bitfield_struct_scan',
  'hex_hexsig_mount',
  'hex_hexsig_normalize_arm64',
  'hex_hexsig_normalize_x64',
  'hex_hexsig_match_fn',
  'hex_sparse_switch_detect',
  'hex_lsda_parse',
]) {
  assert.equal(typeof ex[fnName], 'function', `Missing WASM export: ${fnName}`);
}

const mem = ex.memory;
let heapCursor = 256 * 1024;
function resetHeap() {
  heapCursor = 256 * 1024;
}
function alloc(bytes, align = 8) {
  heapCursor = (heapCursor + align - 1) & ~(align - 1);
  const ptr = heapCursor;
  heapCursor += bytes;
  assert.ok(heapCursor <= mem.buffer.byteLength, 'Test scratch heap overflow');
  new Uint8Array(mem.buffer, ptr, bytes).fill(0);
  return ptr;
}
function writeBytes(ptr, bytes) {
  new Uint8Array(mem.buffer, ptr, bytes.length).set(bytes);
}
function writeArm64(insns) {
  const ptr = alloc(insns.length * 4, 8);
  const dv = new DataView(mem.buffer, ptr, insns.length * 4);
  for (let i = 0; i < insns.length; i++) {
    dv.setUint32(i * 4, insns[i] >>> 0, true);
  }
  return { ptr, len: insns.length * 4 };
}

// ============================================================================
// ARM64 Instruction Encoders
// ============================================================================

const encLdrUoff = (size, rt, rn, immBytes) => {
  const imm12 = (immBytes >>> size) & 0xfff;
  return (((size & 3) << 30) | 0x39400000 | (imm12 << 10) | ((rn & 31) << 5) | (rt & 31)) >>> 0;
};
const encStrUoff = (size, rt, rn, immBytes) => {
  const imm12 = (immBytes >>> size) & 0xfff;
  return (((size & 3) << 30) | 0x39000000 | (imm12 << 10) | ((rn & 31) << 5) | (rt & 31)) >>> 0;
};
const encLdrF32 = (rt, rn, immBytes) => {
  const imm12 = (immBytes >>> 2) & 0xfff;
  return (0xbd400000 | (imm12 << 10) | ((rn & 31) << 5) | (rt & 31)) >>> 0;
};
const encUbfx32 = (rd, rn, lsb, width) => {
  const immr = lsb & 0x1f;
  const imms = (lsb + width - 1) & 0x1f;
  return (0x53000000 | (immr << 16) | (imms << 10) | ((rn & 31) << 5) | (rd & 31)) >>> 0;
};
const encSbfx32 = (rd, rn, lsb, width) => {
  const immr = lsb & 0x1f;
  const imms = (lsb + width - 1) & 0x1f;
  return (0x13000000 | (immr << 16) | (imms << 10) | ((rn & 31) << 5) | (rd & 31)) >>> 0;
};
const encSxtw = (rd, rn) => (0x93407c00 | ((rn & 31) << 5) | (rd & 31)) >>> 0;
const encUxtb = (rd, rn) => (0x53001c00 | ((rn & 31) << 5) | (rd & 31)) >>> 0;
const encUxth = (rd, rn) => (0x53003c00 | ((rn & 31) << 5) | (rd & 31)) >>> 0;
const encSxtb = (rd, rn) => (0x13001c00 | ((rn & 31) << 5) | (rd & 31)) >>> 0;
const encBfi32 = (rd, rn, lsb, width) => {
  const immr = (32 - lsb) & 0x1f;
  const imms = (width - 1) & 0x1f;
  return (0x33000000 | (immr << 16) | (imms << 10) | ((rn & 31) << 5) | (rd & 31)) >>> 0;
};
const encBfxil32 = (rd, rn, lsb, width) => {
  const immr = lsb & 0x1f;
  const imms = (lsb + width - 1) & 0x1f;
  return (0x33000000 | (immr << 16) | (imms << 10) | ((rn & 31) << 5) | (rd & 31)) >>> 0;
};
const encLsr32 = (rd, rn, shift) => (0x53007c00 | ((shift & 0x1f) << 16) | ((rn & 31) << 5) | (rd & 31)) >>> 0;
const encAndLowMask32 = (rd, rn, width) => {
  const imms = (width - 1) & 0x1f;
  return (0x12000000 | (imms << 10) | ((rn & 31) << 5) | (rd & 31)) >>> 0;
};
// AND Wd, Wn, #(((1<<width)-1) << lsb) (rotated contiguous mask)
const encAndShiftedMask32 = (rd, rn, lsb, width) => {
  const immr = (32 - lsb) & 0x1f;
  const imms = (width - 1) & 0x1f;
  return (0x12000000 | (immr << 16) | (imms << 10) | ((rn & 31) << 5) | (rd & 31)) >>> 0;
};
const encMovz32 = (rd, imm16) => (0x52800000 | ((imm16 & 0xffff) << 5) | (rd & 31)) >>> 0;
const encCmpImm32 = (rn, imm12) => (0x7100001f | ((imm12 & 0xfff) << 10) | ((rn & 31) << 5)) >>> 0;
const encSubImm32 = (rd, rn, imm12) => (0x51000000 | ((imm12 & 0xfff) << 10) | ((rn & 31) << 5) | (rd & 31)) >>> 0;
const encBCond = (cond, deltaInsns) => (0x54000000 | ((deltaInsns & 0x7ffff) << 5) | (cond & 0xf)) >>> 0;
const encB = (deltaInsns) => (0x14000000 | (deltaInsns & 0x03ffffff)) >>> 0;
const encBl = (deltaInsns) => (0x94000000 | (deltaInsns & 0x03ffffff)) >>> 0;
const encCbz32 = (rt, deltaInsns) => (0x34000000 | ((deltaInsns & 0x7ffff) << 5) | (rt & 31)) >>> 0;
const encAdrp = (rd, pageDelta) => {
  const immlo = pageDelta & 3;
  const immhi = (pageDelta >> 2) & 0x7ffff;
  return (0x90000000 | (immlo << 29) | (immhi << 5) | (rd & 31)) >>> 0;
};
const encAddImm64 = (rd, rn, imm12) => (0x91000000 | ((imm12 & 0xfff) << 10) | ((rn & 31) << 5) | (rd & 31)) >>> 0;
const encLdrswRegOff = (rt, rn, rm, scaled = true) =>
  (0xb8a06800 | ((rm & 31) << 16) | (scaled ? 0x1000 : 0) | ((rn & 31) << 5) | (rt & 31)) >>> 0;
const encAddReg64 = (rd, rn, rm) => (0x8b000000 | ((rm & 31) << 16) | ((rn & 31) << 5) | (rd & 31)) >>> 0;
const encBr = (rn) => (0xd61f0000 | ((rn & 31) << 5)) >>> 0;
const encRet = () => 0xd65f03c0;

// ============================================================================
// Helper: FNV-1a 32 & CRC-16/CCITT
// ============================================================================

function fnv1a32Pack(bytes) {
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    const b = i >= 0x1c && i < 0x20 ? 0 : bytes[i];
    h ^= b;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

function crc16Ccitt(bytes) {
  let crc = 0xffff;
  for (let i = 0; i < bytes.length; i++) {
    crc ^= (bytes[i] << 8) & 0xffff;
    for (let b = 0; b < 8; b++) {
      if (crc & 0x8000) crc = ((crc << 1) ^ 0x1021) & 0xffff;
      else crc = (crc << 1) & 0xffff;
    }
  }
  return crc;
}

function buildHsig1Pack({ archMask, entries, strings }) {
  const strChunks = [];
  const strOffs = new Map();
  let curStrOff = 0;
  for (const s of strings) {
    strOffs.set(s, curStrOff);
    const enc = Buffer.from(s + '\0', 'utf8');
    strChunks.push(enc);
    curStrOff += enc.length;
  }
  const strPool = Buffer.concat(strChunks);

  const entrySize = 96;
  const entriesOff = 32;
  const strPoolOff = entriesOff + entries.length * entrySize;
  const totalSize = strPoolOff + strPool.length;
  const buf = new Uint8Array(totalSize);
  const dv = new DataView(buf.buffer);

  buf[0] = 0x48; // 'H'
  buf[1] = 0x53; // 'S'
  buf[2] = 0x49; // 'I'
  buf[3] = 0x47; // 'G'
  dv.setUint16(0x04, 1, true);
  dv.setUint16(0x06, archMask, true);
  dv.setUint32(0x08, entries.length, true);
  dv.setUint32(0x0c, entriesOff, true);
  dv.setUint32(0x10, strPoolOff, true);
  dv.setUint32(0x14, strPool.length, true);
  dv.setUint32(0x18, totalSize, true);

  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    const off = entriesOff + i * entrySize;
    const nameOff = strOffs.get(e.name);
    dv.setBigUint64(off + 0x00, e.prologueHash64, true);
    dv.setUint32(off + 0x08, nameOff, true);
    dv.setUint16(off + 0x0c, Buffer.byteLength(e.name, 'utf8'), true);
    dv.setUint16(off + 0x0e, e.tailCrc16 ?? 0, true);
    dv.setUint16(off + 0x10, e.tailOffset ?? 0, true);
    dv.setUint16(off + 0x12, e.tailLen ?? 0, true);
    dv.setUint16(off + 0x14, e.flags ?? 0, true);
    buf[off + 0x16] = e.arch;
    buf[off + 0x17] = e.prologueLen ?? 32;
    dv.setUint16(off + 0x18, e.minFuncLen ?? 32, true);
    dv.setUint16(off + 0x1a, e.libId ?? 0, true);
    dv.setUint16(off + 0x1c, e.baseConfidence ?? 880, true);
    dv.setUint16(off + 0x1e, 0, true);
    buf.set(e.pattern, off + 0x20);
    buf.set(e.wildcardMask, off + 0x40);
  }

  buf.set(strPool, strPoolOff);
  dv.setUint32(0x1c, fnv1a32Pack(buf), true);
  return buf;
}

// ============================================================================
// TEST 1: ARM64 Bitfield (UBFX/SBFX/BFI/BFXIL/AND+LSR) + Struct + Padding + Union
// ============================================================================
{
  resetHeap();
  const insns = [
    encLdrUoff(0, 1, 0, 0x00),       // ldrb w1, [x0, #0x00]
    encLdrUoff(2, 2, 0, 0x04),       // ldr  w2, [x0, #0x04]
    encUbfx32(3, 2, 4, 6),           // ubfx w3, w2, #4, #6
    encSbfx32(4, 2, 10, 6),          // sbfx w4, w2, #10, #6
    encBfi32(2, 5, 16, 4),           // bfi  w2, w5, #16, #4
    encBfxil32(6, 2, 20, 4),         // bfxil w6, w2, #20, #4
    encLsr32(7, 2, 24),              // lsr  w7, w2, #24
    encAndLowMask32(7, 7, 4),        // and  w7, w7, #0xf  (LSR+AND -> lsb=24, width=4)
    encStrUoff(2, 2, 0, 0x04),       // str  w2, [x0, #0x04]
    encLdrUoff(2, 8, 0, 0x08),       // ldr  w8, [x0, #0x08]
    encLdrF32(0, 0, 0x08),           // ldr  s0, [x0, #0x08]
    encLdrUoff(3, 9, 0, 0x08),       // ldr  x9, [x0, #0x08]
    encLdrUoff(3, 10, 0, 0x10),      // ldr  x10, [x0, #0x10]
    encRet(),
  ];

  const { ptr: codePtr, len: codeLen } = writeArm64(insns);
  const outBf = alloc(24 * 16, 8);
  const outFields = alloc(24 * 16, 4);
  const outUnions = alloc(20 * 8, 4);
  const outSummary = alloc(20, 4);

  const st = ex.hex_bitfield_struct_scan(codePtr, codeLen, outBf, 16, outFields, 16, outUnions, 8, outSummary);
  assert.equal(st, 0, 'hex_bitfield_struct_scan should return HEX_OK');

  const sdv = new DataView(mem.buffer, outSummary, 20);
  const bfCount = sdv.getUint32(0, true);
  const fieldCount = sdv.getUint32(4, true);
  const unionCount = sdv.getUint32(8, true);
  const structSize = sdv.getUint32(12, true);
  const structAlign = sdv.getUint16(16, true);
  const totalPadding = sdv.getUint16(18, true);

  assert.equal(bfCount, 5, 'Should detect 5 bitfield ops');
  assert.equal(fieldCount, 6, 'Should detect 6 coalesced field candidates');
  assert.equal(unionCount, 1, 'Should detect 1 union overlap group');
  assert.equal(structAlign, 8);
  assert.equal(structSize, 24);
  assert.equal(totalPadding, 3);

  const bfOps = [];
  for (let i = 0; i < bfCount; i++) {
    const dv = new DataView(mem.buffer, outBf + i * 24, 24);
    bfOps.push({
      structOffset: dv.getInt32(4, true),
      baseReg: dv.getUint8(8),
      opKind: dv.getUint8(11),
      lsb: dv.getUint8(12),
      width: dv.getUint8(13),
      flags: dv.getUint8(15),
      bitMask: dv.getBigUint64(16, true),
    });
  }
  assert.deepEqual(
    bfOps.map((b) => [b.opKind, b.structOffset, b.baseReg, b.lsb, b.width]),
    [
      [1, 4, 0, 4, 6],
      [2, 4, 0, 10, 6],
      [3, 4, 0, 16, 4],
      [4, 4, 0, 20, 4],
      [5, 4, 0, 24, 4],
    ]
  );
  assert.equal(bfOps[0].bitMask, 0x3f0n);
  assert.ok((bfOps[1].flags & 1) !== 0);
  assert.ok((bfOps[2].flags & 2) !== 0);

  const udv = new DataView(mem.buffer, outUnions, 20);
  assert.equal(udv.getUint8(2), 0);
  assert.equal(udv.getUint8(3), 3);
  assert.equal(udv.getInt32(4, true), 8);
  assert.equal(udv.getInt32(8, true), 16);
  assert.ok((udv.getUint32(16, true) & 0x7) === 0x7);

  console.log('  [PASS] Test 1: ARM64 UBFX/SBFX/BFI/BFXIL/LSR+AND + Struct + Padding + Union');
}

// ============================================================================
// TEST 1B (Round 1 Regression): Clobber clearing, UXTB/SXTW exclusion,
//         AND+LSR snapshot, LSR+AND bounds, and container_bytes matching
// ============================================================================
{
  resetHeap();
  const insns = [
    // Load w1 from [x0, #0x00] (4B), then execute UXTB/UXTH/SXTB/SXTW -> NONE should emit bitfield!
    encLdrUoff(2, 1, 0, 0x00),       // ldr w1, [x0, #0x00]
    encUxtb(2, 1),                   // uxtb w2, w1 (excluded!)
    encUxth(3, 1),                   // uxth w3, w1 (excluded!)
    encSxtb(4, 1),                   // sxtb w4, w1 (excluded!)
    encSxtw(5, 1),                   // sxtw x5, w1 (excluded!)
    // AND+LSR snapshot test: AND w6, w1, #(0xf << 8), then CLOBBER w1 via MOVZ, then LSR w6, w6, #8
    encAndShiftedMask32(6, 1, 8, 4), // and w6, w1, #0xf00 (snapshots [x0+0x00] onto w6)
    encMovz32(1, 0x99),              // movz w1, #0x99 (clobbers w1!)
    encLsr32(6, 6, 8),               // lsr w6, w6, #8 -> MUST still link to [x0+0x00] via w6 snapshot!
    // Clobber via BL: load w2 from [x0, #0x04], call BL (clobbers x0..x18), then UBFX w3, w2, #2, #5 -> NOT FROM_MEM!
    encLdrUoff(2, 2, 0, 0x04),       // ldr w2, [x0, #0x04]
    encBl(0x10),                     // bl helper (clobbers x0..x18!)
    encUbfx32(3, 2, 2, 5),           // ubfx w3, w2, #2, #5 -> register-only (FROM_MEM must be 0!)
    // LSR+AND out-of-range test: LSR w7, w2, #28 + AND w7, w7, #0xff (28 + 8 = 36 > 32 -> skipped!)
    encLsr32(7, 2, 28),
    encAndLowMask32(7, 7, 8),
    // Container_bytes match test: 8B load at [x0, #0x00] overlaps 4B load at [x0, #0x00];
    // the 4B AND+LSR bitfield above must only attach to the 4B field, NOT the 8B field!
    encLdrUoff(3, 8, 0, 0x00),       // ldr x8, [x0, #0x00]
    encRet(),
  ];

  const { ptr: codePtr, len: codeLen } = writeArm64(insns);
  const outBf = alloc(24 * 16, 8);
  const outFields = alloc(24 * 16, 4);
  const outUnions = alloc(20 * 8, 4);
  const outSummary = alloc(20, 4);

  assert.equal(ex.hex_bitfield_struct_scan(codePtr, codeLen, outBf, 16, outFields, 16, outUnions, 8, outSummary), 0);

  const sdv = new DataView(mem.buffer, outSummary, 20);
  const bfCount = sdv.getUint32(0, true);
  const fieldCount = sdv.getUint32(4, true);

  // Expect ONLY 2 bitfields: (1) AND+LSR at [x0+0x00], (2) register-only UBFX after BL
  // UXTB/UXTH/SXTB/SXTW (4 ops) and out-of-range LSR+AND (1 op) must all be excluded!
  assert.equal(bfCount, 2, `Expected 2 bitfields (UXTB/SXTW & OOB LSR+AND excluded), got ${bfCount}`);

  const bf0 = new DataView(mem.buffer, outBf, 24);
  assert.equal(bf0.getUint8(11), 5, 'bf0 must be HEX_BF_OP_AND_LSR');
  assert.equal(bf0.getInt32(4, true), 0, 'bf0 must preserve struct_offset=0 from snapshot despite w1 clobber');
  assert.equal(bf0.getUint8(8), 0, 'bf0 base_reg must be x0');
  assert.ok((bf0.getUint8(15) & 8) !== 0, 'bf0 must have HEX_BF_FLAG_FROM_MEM');

  const bf1 = new DataView(mem.buffer, outBf + 24, 24);
  assert.equal(bf1.getUint8(11), 1, 'bf1 must be HEX_BF_OP_UBFX');
  assert.equal(bf1.getInt32(4, true), -1, 'bf1 after BL clobber must NOT inherit stale struct_offset');
  assert.equal(bf1.getUint8(15) & 8, 0, 'bf1 after BL clobber must NOT set HEX_BF_FLAG_FROM_MEM');

  // Verify container_bytes matching: at offset 0x00, 4B field has bf_count=1, 8B field has bf_count=0
  let saw4bBf = false;
  let saw8bNoBf = false;
  for (let i = 0; i < fieldCount; i++) {
    const fdv = new DataView(mem.buffer, outFields + i * 24, 24);
    const off = fdv.getInt32(0, true);
    const sz = fdv.getUint16(4, true);
    const bfc = fdv.getUint8(11);
    if (off === 0 && sz === 4) {
      assert.equal(bfc, 1, '4B field at +0x00 should link to 4B bitfield');
      saw4bBf = true;
    }
    if (off === 0 && sz === 8) {
      assert.equal(bfc, 0, '8B field at +0x00 must NOT link to 4B bitfield');
      saw8bNoBf = true;
    }
  }
  assert.ok(saw4bBf && saw8bNoBf, 'Both 4B and 8B overlapping fields at +0x00 must be present');

  console.log('  [PASS] Test 1B: Bitfield Clobber, UXTB/SXTW Exclusion, AND+LSR Snapshot, LSR+AND Bounds & Container Size');
}

// ============================================================================
// TEST 2: HSIG1 Normalization (ARM64 & x64 + SIB disp32 + 0F ModRM), Mount,
//         2-Stage Match, Tail CRC16, Wildcards, Ambiguity & Malformed Rejection
// ============================================================================
{
  resetHeap();

  const fnA_insns = [
    0xa9bf7bfd,
    0x910003fd,
    encAdrp(0, 0x123),
    encAddImm64(0, 0, 0x45),
    encBl(0x200),
    encLdrUoff(3, 1, 0, 8),
    encUbfx32(2, 1, 0, 8),
    encCmpImm32(2, 0),
    encAddImm64(0, 1, 0x11),
    encAddImm64(0, 0, 0x22),
    0xa8c17bfd,
    encRet(),
  ];
  const fnB_insns = [
    0xa9bf7bfd,
    0x910003fd,
    encAdrp(0, 0x7ff),
    encAddImm64(0, 0, 0x9a),
    encBl(0x999),
    encLdrUoff(3, 1, 0, 8),
    encUbfx32(2, 1, 0, 8),
    encCmpImm32(2, 0),
    encAddImm64(0, 1, 0x77),
    encSubImm32(0, 0, 0x33),
    0xa8c17bfd,
    encRet(),
  ];

  const { ptr: fnAPtr, len: fnALen } = writeArm64(fnA_insns);
  const { ptr: fnBPtr, len: fnBLen } = writeArm64(fnB_insns);

  const normA = alloc(32, 8), maskA = alloc(32, 8), hashAPtr = alloc(8, 8);
  const normB = alloc(32, 8), maskB = alloc(32, 8), hashBPtr = alloc(8, 8);
  assert.equal(ex.hex_hexsig_normalize_arm64(fnAPtr, fnALen, normA, maskA, hashAPtr), 0);
  assert.equal(ex.hex_hexsig_normalize_arm64(fnBPtr, fnBLen, normB, maskB, hashBPtr), 0);

  const hashA = new DataView(mem.buffer, hashAPtr, 8).getBigUint64(0, true);
  const hashB = new DataView(mem.buffer, hashBPtr, 8).getBigUint64(0, true);
  assert.equal(hashA, hashB, 'ARM64 normalization must produce identical hash despite different ADRP/ADD/BL offsets');

  const patBytes = new Uint8Array(mem.buffer, normA, 32).slice();
  const maskBytes = new Uint8Array(mem.buffer, maskA, 32).slice();

  const tailNormA = alloc(32, 8), tailMaskA = alloc(32, 8);
  assert.equal(ex.hex_hexsig_normalize_arm64(fnAPtr + 32, 16, tailNormA, tailMaskA, 0), 0);
  const crcTailA = crc16Ccitt(new Uint8Array(mem.buffer, tailNormA, 16));

  const tailNormB = alloc(32, 8), tailMaskB = alloc(32, 8);
  assert.equal(ex.hex_hexsig_normalize_arm64(fnBPtr + 32, 16, tailNormB, tailMaskB, 0), 0);
  const crcTailB = crc16Ccitt(new Uint8Array(mem.buffer, tailNormB, 16));
  assert.notEqual(crcTailA, crcTailB);

  // x86-64 normalization regression: SIB mod==0 && base==5 (disp32!) + 0F B6 (MOVZX RIP-rel) + CALL rel32
  //   8B 04 85 10 20 30 40   -> mov eax, [rax*4 + 0x40302010]  (ModRM=0x04: mod=0,rm=4; SIB=0x85: base=5 -> 4B disp32!)
  //   0F B6 05 AA BB CC DD   -> movzx eax, byte ptr [rip + disp32] (2-byte 0F B6 + RIP-rel disp32 -> masked!)
  //   E8 11 22 33 44         -> call rel32 (masked!)
  //   C3                     -> ret
  const x64Fn1 = new Uint8Array([
    0x8b, 0x04, 0x85, 0x10, 0x20, 0x30, 0x40,
    0x0f, 0xb6, 0x05, 0xaa, 0xbb, 0xcc, 0xdd,
    0xe8, 0x11, 0x22, 0x33, 0x44,
    0xc3,
  ]);
  const x64Fn2 = new Uint8Array([
    0x8b, 0x04, 0x85, 0x10, 0x20, 0x30, 0x40,
    0x0f, 0xb6, 0x05, 0x01, 0x02, 0x03, 0x04, // different RIP-rel disp32!
    0xe8, 0x99, 0x88, 0x77, 0x66,             // different CALL rel32!
    0xc3,
  ]);
  const x64Ptr1 = alloc(x64Fn1.length, 8), x64Ptr2 = alloc(x64Fn2.length, 8);
  writeBytes(x64Ptr1, x64Fn1);
  writeBytes(x64Ptr2, x64Fn2);
  const x64Norm1 = alloc(32, 8), x64Mask1 = alloc(32, 8), x64Hash1Ptr = alloc(8, 8);
  const x64Norm2 = alloc(32, 8), x64Mask2 = alloc(32, 8), x64Hash2Ptr = alloc(8, 8);
  assert.equal(ex.hex_hexsig_normalize_x64(x64Ptr1, x64Fn1.length, x64Norm1, x64Mask1, x64Hash1Ptr), 0);
  assert.equal(ex.hex_hexsig_normalize_x64(x64Ptr2, x64Fn2.length, x64Norm2, x64Mask2, x64Hash2Ptr), 0);
  const x64Hash1 = new DataView(mem.buffer, x64Hash1Ptr, 8).getBigUint64(0, true);
  const x64Hash2 = new DataView(mem.buffer, x64Hash2Ptr, 8).getBigUint64(0, true);
  assert.equal(x64Hash1, x64Hash2, 'x86-64 normalizer must stay in sync across SIB disp32 + 0F B6 RIP-rel + CALL rel32');

  const wildPattern = patBytes.slice();
  const wildMask = maskBytes.slice();
  wildMask[24] = 0; wildMask[25] = 0; wildMask[26] = 0; wildMask[27] = 0;

  const packBytes = buildHsig1Pack({
    archMask: 3,
    strings: ['_zlib_inflate_fast', '_zlib_deflate_fast', '_wildcard_helper', '_x64_init_ctx'],
    entries: [
      {
        name: '_zlib_inflate_fast',
        prologueHash64: hashA,
        tailCrc16: crcTailA,
        tailOffset: 32,
        tailLen: 16,
        flags: 0x02,
        arch: 1,
        prologueLen: 32,
        minFuncLen: 48,
        libId: 1,
        baseConfidence: 900,
        pattern: patBytes,
        wildcardMask: maskBytes,
      },
      {
        name: '_zlib_deflate_fast',
        prologueHash64: hashA,
        tailCrc16: crcTailB,
        tailOffset: 32,
        tailLen: 16,
        flags: 0x02,
        arch: 1,
        prologueLen: 32,
        minFuncLen: 48,
        libId: 1,
        baseConfidence: 900,
        pattern: patBytes,
        wildcardMask: maskBytes,
      },
      {
        name: '_wildcard_helper',
        prologueHash64: 0n,
        flags: 0x01,
        arch: 1,
        prologueLen: 32,
        minFuncLen: 32,
        libId: 2,
        baseConfidence: 820,
        pattern: wildPattern,
        wildcardMask: wildMask,
      },
      {
        name: '_x64_init_ctx',
        prologueHash64: x64Hash1,
        flags: 0,
        arch: 2,
        prologueLen: x64Fn1.length,
        minFuncLen: x64Fn1.length,
        libId: 3,
        baseConfidence: 880,
        pattern: new Uint8Array(mem.buffer, x64Norm1, 32).slice(),
        wildcardMask: new Uint8Array(mem.buffer, x64Mask1, 32).slice(),
      },
    ],
  });

  const packPtr = alloc(packBytes.length, 8);
  writeBytes(packPtr, packBytes);
  assert.equal(ex.hex_hexsig_mount(packPtr, packBytes.length), 0);

  const resPtr = alloc(32, 8);

  // Match fnA -> entry 0 (_zlib_inflate_fast), and cand_count == 2 (entry 0 + entry 2; entry 1 failed tail CRC16!)
  assert.equal(ex.hex_hexsig_match_fn(fnAPtr, fnALen, 1, resPtr), 0);
  {
    const dv = new DataView(mem.buffer, resPtr, 32);
    assert.equal(dv.getUint32(8, true), 0);
    assert.equal(dv.getUint8(28), 2, 'Status must be HEX_SIG_MATCH_FULL');
    assert.equal(dv.getUint8(29), 1);
    assert.equal(dv.getUint16(26, true), crcTailA);
    assert.equal(dv.getUint16(30, true), 2, 'cand_count must exclude entry 1 which failed Tail CRC16');
    assert.ok(dv.getUint16(20, true) >= 850);
  }

  // Match fnB -> entry 1 (_zlib_deflate_fast)
  assert.equal(ex.hex_hexsig_match_fn(fnBPtr, fnBLen, 1, resPtr), 0);
  {
    const dv = new DataView(mem.buffer, resPtr, 32);
    assert.equal(dv.getUint32(8, true), 1);
    assert.equal(dv.getUint8(28), 2);
    assert.equal(dv.getUint16(26, true), crcTailB);
  }

  // Match wildcard-mutated ARM64 function -> entry 2
  const fnWildInsns = fnA_insns.slice(0, 8);
  fnWildInsns[6] = encSbfx32(2, 1, 2, 12);
  const { ptr: fnWildPtr, len: fnWildLen } = writeArm64(fnWildInsns);
  assert.equal(ex.hex_hexsig_match_fn(fnWildPtr, fnWildLen, 1, resPtr), 0);
  {
    const dv = new DataView(mem.buffer, resPtr, 32);
    assert.equal(dv.getUint32(8, true), 2);
    assert.equal(dv.getUint8(28), 1);
    assert.equal(dv.getUint16(30, true), 1);
  }

  // Match x86-64 fn2 -> entry 3
  assert.equal(ex.hex_hexsig_match_fn(x64Ptr2, x64Fn2.length, 2, resPtr), 0);
  {
    const dv = new DataView(mem.buffer, resPtr, 32);
    assert.equal(dv.getUint32(8, true), 3);
    assert.equal(dv.getUint8(28), 1);
  }

  // Ambiguity margin test: two entries within < 40 confidence points -> HEX_SIG_MATCH_AMBIGUOUS (3)
  const ambigPack = buildHsig1Pack({
    archMask: 1,
    strings: ['_dup_a', '_dup_b'],
    entries: [
      {
        name: '_dup_a',
        prologueHash64: hashA,
        flags: 0,
        arch: 1,
        prologueLen: 32,
        minFuncLen: 32,
        baseConfidence: 900,
        pattern: patBytes,
        wildcardMask: maskBytes,
      },
      {
        name: '_dup_b',
        prologueHash64: hashA,
        flags: 0,
        arch: 1,
        prologueLen: 32,
        minFuncLen: 32,
        baseConfidence: 880,
        pattern: patBytes,
        wildcardMask: maskBytes,
      },
    ],
  });
  const ambigPtr = alloc(ambigPack.length, 8);
  writeBytes(ambigPtr, ambigPack);
  assert.equal(ex.hex_hexsig_mount(ambigPtr, ambigPack.length), 0);
  assert.equal(ex.hex_hexsig_match_fn(fnAPtr, fnALen, 1, resPtr), 0);
  assert.equal(new DataView(mem.buffer, resPtr, 32).getUint8(28), 3, 'Tight margin must yield HEX_SIG_MATCH_AMBIGUOUS');

  // Malformed HSIG1 pack rejections (including ARM64 unaligned prologue_len)
  const badPtr = alloc(packBytes.length, 8);

  const badMagic = packBytes.slice();
  badMagic[0] = 0x58;
  writeBytes(badPtr, badMagic);
  assert.notEqual(ex.hex_hexsig_mount(badPtr, badMagic.length), 0);

  const badCrc = packBytes.slice();
  badCrc[badCrc.length - 2] ^= 0xff;
  writeBytes(badPtr, badCrc);
  assert.notEqual(ex.hex_hexsig_mount(badPtr, badCrc.length), 0);

  const badVer = packBytes.slice();
  new DataView(badVer.buffer).setUint16(4, 99, true);
  new DataView(badVer.buffer).setUint32(0x1c, fnv1a32Pack(badVer), true);
  writeBytes(badPtr, badVer);
  assert.equal(ex.hex_hexsig_mount(badPtr, badVer.length), 4);

  assert.notEqual(ex.hex_hexsig_mount(badPtr, 16), 0);

  const badStr = packBytes.slice();
  const strPoolOff = new DataView(badStr.buffer).getUint32(0x10, true);
  const nameLen0 = new DataView(badStr.buffer).getUint16(32 + 0x0c, true);
  badStr[strPoolOff + nameLen0] = 0x41;
  new DataView(badStr.buffer).setUint32(0x1c, fnv1a32Pack(badStr), true);
  writeBytes(badPtr, badStr);
  assert.notEqual(ex.hex_hexsig_mount(badPtr, badStr.length), 0);

  // Round 1 Regression: ARM64 entry with unaligned prologue_len (15) must be rejected!
  const badArmAlign = packBytes.slice();
  badArmAlign[32 + 0x17] = 15; // entry 0 is ARM64, prologue_len=15 (not multiple of 4)
  new DataView(badArmAlign.buffer).setUint32(0x1c, fnv1a32Pack(badArmAlign), true);
  writeBytes(badPtr, badArmAlign);
  assert.notEqual(ex.hex_hexsig_mount(badPtr, badArmAlign.length), 0, 'Unaligned ARM64 prologue_len must fail');

  console.log('  [PASS] Test 2: HSIG1 Normalize (ARM64+x64 SIB/0F), Mount, Tail CRC16, Ambiguity & Malformed Rejection');
}

// ============================================================================
// TEST 3: Sparse Switch BST, Dense Jump-Table & Cluster Separation
// ============================================================================
{
  resetHeap();
  const funcVa = 0x100004000n;

  const bstInsns = [
    encCmpImm32(0, 50),
    encBCond(12, 5),
    encBCond(0, 10),
    encCbz32(0, 12),
    encCmpImm32(0, 10),
    encBCond(0, 14),
    encB(20),
    encCmpImm32(0, 200),
    encBCond(0, 16),
    encB(18),
    encRet(),
  ];

  const { ptr: bstPtr, len: bstLen } = writeArm64(bstInsns);
  const plansPtr = alloc(48 * 8, 8);
  const casesPtr = alloc(24 * 32, 8);
  const planCntPtr = alloc(4, 4);
  const caseCntPtr = alloc(4, 4);

  assert.equal(
    ex.hex_sparse_switch_detect(bstPtr, bstLen, funcVa, plansPtr, 8, casesPtr, 32, planCntPtr, caseCntPtr),
    0
  );
  const planCount = new DataView(mem.buffer, planCntPtr, 4).getUint32(0, true);
  const caseCount = new DataView(mem.buffer, caseCntPtr, 4).getUint32(0, true);
  assert.equal(planCount, 1);
  assert.equal(caseCount, 4);

  const pdv = new DataView(mem.buffer, plansPtr, 48);
  assert.equal(pdv.getBigInt64(0x18, true), 0n);
  assert.equal(pdv.getBigInt64(0x20, true), 200n);
  assert.equal(pdv.getUint8(0x2a), 2);
  assert.equal(pdv.getUint8(0x2b), 0);
  assert.ok((pdv.getUint16(0x2e, true) & 0x05) === 0x05);

  const vals = [];
  for (let i = 0; i < caseCount; i++) {
    vals.push(new DataView(mem.buffer, casesPtr + i * 24, 24).getBigInt64(0, true));
  }
  assert.deepEqual(vals, [0n, 10n, 50n, 200n]);

  // Dense Jump Table
  const jtInsns = [
    encSubImm32(8, 0, 5),
    encCmpImm32(8, 4),
    encBCond(8, 10),
    encAdrp(9, 1),
    encAddImm64(9, 9, 0x100),
    encLdrswRegOff(10, 9, 8, true),
    encAddReg64(10, 9, 10),
    encBr(10),
  ];
  const { ptr: jtPtr, len: jtLen } = writeArm64(jtInsns);
  assert.equal(
    ex.hex_sparse_switch_detect(jtPtr, jtLen, funcVa, plansPtr, 8, casesPtr, 32, planCntPtr, caseCntPtr),
    0
  );
  assert.equal(new DataView(mem.buffer, planCntPtr, 4).getUint32(0, true), 1);
  const jdv = new DataView(mem.buffer, plansPtr, 48);
  assert.equal(jdv.getUint8(0x2a), 1);
  assert.equal(jdv.getBigInt64(0x18, true), 5n);
  assert.equal(jdv.getBigInt64(0x20, true), 9n);
  assert.equal(jdv.getUint16(0x28, true), 5);
  assert.equal(jdv.getBigUint64(0x08, true), funcVa + 0x30n);
  assert.equal(jdv.getBigUint64(0x10, true), 0x100005100n);
  assert.equal(jdv.getUint8(0x2c), 4);
  assert.equal(jdv.getUint8(0x2d), 2);

  // Round 1 Regression: Two separate 2-case chains separated by BL must NOT merge into a 4-case switch!
  const splitInsns = [
    encCmpImm32(0, 1),
    encBCond(0, 8),
    encCmpImm32(0, 2),
    encBCond(0, 8),
    encBl(0x40),           // BL separates clusters!
    encCmpImm32(0, 3),
    encBCond(0, 8),
    encCmpImm32(0, 4),
    encBCond(0, 8),
    encRet(),
  ];
  const { ptr: splitPtr, len: splitLen } = writeArm64(splitInsns);
  assert.equal(
    ex.hex_sparse_switch_detect(splitPtr, splitLen, funcVa, plansPtr, 8, casesPtr, 32, planCntPtr, caseCntPtr),
    0
  );
  assert.equal(new DataView(mem.buffer, planCntPtr, 4).getUint32(0, true), 0, 'BL must separate switch clusters');

  console.log('  [PASS] Test 3: Sparse Switch BST, Dense Jump-Table & Cluster Separation');
}

// ============================================================================
// TEST 4: DWARF/Itanium .gcc_except_table LSDA ULEB128/SLEB128 Parser & Safety
// ============================================================================
{
  resetHeap();
  const funcVa = 0x100008000n;

  const validLsda = new Uint8Array([
    0xff,
    0xff,
    0x01,
    0x09,
    0x10, 0x20, 0x50, 0x00,
    0x40, 0x80, 0x01, 0x60, 0x03,
    0x00, 0x00,
    0x01, 0x7d,
  ]);

  const lsdaPtr = alloc(validLsda.length, 8);
  writeBytes(lsdaPtr, validLsda);
  const hdrPtr = alloc(32, 8);
  const sitesPtr = alloc(32 * 8, 8);
  const actsPtr = alloc(16 * 8, 4);

  assert.equal(ex.hex_lsda_parse(lsdaPtr, validLsda.length, funcVa, hdrPtr, sitesPtr, 8, actsPtr, 8), 0);

  const hdv = new DataView(mem.buffer, hdrPtr, 32);
  assert.equal(hdv.getBigUint64(0x00, true), funcVa);
  assert.equal(hdv.getUint32(0x08, true), 2);
  assert.equal(hdv.getUint32(0x0c, true), 2);
  assert.equal(hdv.getUint32(0x14, true), 13);

  const cs0 = new DataView(mem.buffer, sitesPtr, 32);
  assert.equal(cs0.getBigUint64(0x00, true), funcVa + 0x10n);
  assert.equal(cs0.getBigUint64(0x08, true), funcVa + 0x30n);
  assert.equal(cs0.getBigUint64(0x10, true), funcVa + 0x50n);
  assert.equal(cs0.getUint16(0x1e, true), 0x03);

  const cs1 = new DataView(mem.buffer, sitesPtr + 32, 32);
  assert.equal(cs1.getBigUint64(0x00, true), funcVa + 0x40n);
  assert.equal(cs1.getBigUint64(0x08, true), funcVa + 0xc0n);
  assert.equal(cs1.getBigUint64(0x10, true), funcVa + 0x60n);
  assert.equal(cs1.getUint16(0x1c, true), 0);
  assert.equal(cs1.getUint16(0x1e, true), 0x07);

  const act0 = new DataView(mem.buffer, actsPtr, 16);
  const act1 = new DataView(mem.buffer, actsPtr + 16, 16);
  assert.equal(act0.getInt32(0, true), 1);
  assert.equal(act0.getInt32(4, true), -3);
  assert.equal(act0.getUint16(12, true), 1);
  assert.equal(act1.getInt32(0, true), 0);
  assert.equal(act1.getUint16(12, true), 0xffff);

  // Malformed LSDA safety tests (including Round 1 regressions: indirect, pcrel, SLEB128 overflow, truncated bad CS)
  const malformedCases = [
    { name: 'too short', bytes: new Uint8Array([0xff, 0xff]), maxSites: 8 },
    { name: 'omitted cs_enc', bytes: new Uint8Array([0xff, 0xff, 0xff, 0x00]), maxSites: 8 },
    { name: 'cs_tbl_len OOB', bytes: new Uint8Array([0xff, 0xff, 0x01, 0x7f, 0x00]), maxSites: 8 },
    {
      name: '10-byte ULEB128 overflow',
      bytes: new Uint8Array([0xff, 0xff, 0x01, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x02]),
      maxSites: 8,
    },
    {
      name: 'unterminated ULEB128',
      bytes: new Uint8Array([0xff, 0xff, 0x01, 0x81, 0x82]),
      maxSites: 8,
    },
    {
      name: 'action offset OOB',
      bytes: new Uint8Array([0xff, 0xff, 0x01, 0x04, 0x10, 0x10, 0x20, 0x05, 0x00, 0x00]),
      maxSites: 8,
    },
    {
      name: 'cyclic action chain (self-loop next_disp=-1)',
      bytes: new Uint8Array([0xff, 0xff, 0x01, 0x04, 0x10, 0x10, 0x20, 0x01, 0x01, 0x7f]),
      maxSites: 8,
    },
    {
      name: 'indirect LPStart encoding (0x80 | udata4)',
      bytes: new Uint8Array([0x83, 0x10, 0x20, 0x30, 0x40, 0xff, 0x01, 0x00]),
      maxSites: 8,
    },
    {
      name: 'unresolved pcrel LPStart encoding (0x10 | sdata4)',
      bytes: new Uint8Array([0x1b, 0x10, 0x00, 0x00, 0x00, 0xff, 0x01, 0x00]),
      maxSites: 8,
    },
    {
      name: '10-byte SLEB128 overflow in action table',
      bytes: new Uint8Array([
        0xff, 0xff, 0x01, 0x04,
        0x10, 0x10, 0x20, 0x01,
        0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x40, 0x00,
      ]),
      maxSites: 8,
    },
    {
      name: 'truncated 2nd call site with OOB action_offset (max_sites=1)',
      bytes: new Uint8Array([
        0xff, 0xff, 0x01, 0x08,
        0x10, 0x10, 0x20, 0x00, // CS0: valid
        0x30, 0x10, 0x40, 0x09, // CS1: truncated by max_sites=1, but action_offset=9 is OOB!
        0x00, 0x00,
      ]),
      maxSites: 1,
    },
  ];

  for (const mc of malformedCases) {
    const mp = alloc(mc.bytes.length, 8);
    writeBytes(mp, mc.bytes);
    const st = ex.hex_lsda_parse(mp, mc.bytes.length, funcVa, hdrPtr, sitesPtr, mc.maxSites, actsPtr, 8);
    assert.equal(st, 1, `Malformed LSDA (${mc.name}) must return HEX_ERR_INVALID_ARG`);
  }

  console.log('  [PASS] Test 4: DWARF/Itanium LSDA ULEB128/SLEB128 Parsing & All Malformed/Truncated Safety Checks');
}

fs.rmSync(tmpDir, { recursive: true, force: true });
console.log('ALL TRACK 2 TESTS PASSED (0 external WASM imports verified).');
