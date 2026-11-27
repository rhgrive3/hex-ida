import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const HEX_OK = 0;
const HEX_ERR_INVALID_ARG = 1;
const HEX_ERR_RESOURCE_LIMIT = 3;

const HEX_MANUAL_SEG_NO_FILE = 0xffffffffffffffffn;
const HEX_MANUAL_NAME_NONE = 0xffffffff;

const HEX_MSEG_UNDEF = 0;
const HEX_MSEG_CODE = 1;
const HEX_MSEG_DATA_U8 = 2;
const HEX_MSEG_DATA_U32 = 4;
const HEX_MSEG_STR = 6;

const HEX_MSEG_PERM_R = 1;
const HEX_MSEG_PERM_W = 2;
const HEX_MSEG_PERM_X = 4;

const HEX_CHUNK_PRIMARY = 0;
const HEX_CHUNK_COLD_BLOCK = 1;
const HEX_CHUNK_TAIL_CALL = 2;
const HEX_CHUNK_OUTLINE = 3;

const HEX_CHUNK_FLAG_MANUAL = 1 << 0;
const HEX_CHUNK_FLAG_UNWIND_COLD = 1 << 1;
const HEX_CHUNK_FLAG_OUTLINED_TAIL = 1 << 2;
const HEX_CHUNK_FLAG_DETACHED = 1 << 4;

const HEX_ABILOC_NONE = 0;
const HEX_ABILOC_GPR = 1;
const HEX_ABILOC_FPR_SIMD = 2;
const HEX_ABILOC_GPR_PAIR = 3;
const HEX_ABILOC_FPR_PAIR = 4;
const HEX_ABILOC_STACK = 5;

const HEX_ABILOC_FLAG_ALLOW_FP_LR = 1 << 3;

const HEX_STACK_FLAG_FORCE_SPLIT = 1 << 0;
const HEX_STACK_FLAG_FORCE_MERGE = 1 << 1;
const HEX_STACK_FLAG_NO_REG_PROMOTE = 1 << 2;
const HEX_STACK_FLAG_FP_REL = 1 << 3;

const HEX_SHIFTED_FLAG_PREFER_CONTAINER_OF = 1 << 0;
const HEX_SHIFTED_FLAG_ALLOW_NEG_OFFSET = 1 << 1;

// POD struct byte sizes (must match static_asserts in hex_manual_recovery.hpp)
const SIZE_MANUAL_SEG_ENTRY = 24;
const SIZE_FUNC_CHUNK = 32;
const SIZE_FUNC_CHUNK_RANGE = 24;
const SIZE_CUSTOM_ABI = 192;

function compileTrack3Wasm() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hex-track03-'));
  const outWasm = path.join(tmpDir, 'track03_manual_recovery.wasm');
  const srcs = [
    path.join(ROOT, 'cpp/src/recovery/manual_segment_map.cpp'),
    path.join(ROOT, 'cpp/src/recovery/func_chunk_cfg.cpp'),
    path.join(ROOT, 'cpp/src/recovery/custom_abi_spec.cpp'),
  ];
  const args = [
    '--target=wasm32',
    '-std=c++20',
    '-O3',
    '-nostdlib',
    '-fno-exceptions',
    '-fno-rtti',
    '-mbulk-memory',
    `-I${path.join(ROOT, 'cpp/include')}`,
    '-Wl,--no-entry',
    '-o',
    outWasm,
    ...srcs,
  ];
  execFileSync('clang++', args, { stdio: 'inherit' });
  const bytes = fs.readFileSync(outWasm);
  fs.rmSync(tmpDir, { recursive: true, force: true });
  return bytes;
}

function writeManualSeg(dv, ptr, s) {
  dv.setBigUint64(ptr + 0x00, BigInt(s.base_va), true);
  dv.setBigUint64(ptr + 0x08, BigInt(s.size), true);
  dv.setBigUint64(ptr + 0x10, BigInt(s.file_offset ?? HEX_MANUAL_SEG_NO_FILE), true);
  dv.setUint32(ptr + 0x18, s.perms ?? HEX_MSEG_PERM_R, true);
  dv.setUint32(ptr + 0x1c, s.flags ?? 0, true);
  dv.setUint32(ptr + 0x20, s.name_off ?? HEX_MANUAL_NAME_NONE, true);
  dv.setUint8(ptr + 0x24, s.seg_kind ?? HEX_MSEG_UNDEF);
  dv.setUint8(ptr + 0x25, s.elem_size ?? 1);
  dv.setUint8(ptr + 0x26, s.align_pow2 ?? 0);
  dv.setUint8(ptr + 0x27, s.reserved ?? 0);
}

function writeManualSegEntry24(dv, ptr, e) {
  dv.setBigUint64(ptr + 0x00, BigInt(e.start_va), true);
  dv.setUint32(ptr + 0x08, e.byte_len, true);
  dv.setUint8(ptr + 0x0c, e.kind ?? HEX_MSEG_UNDEF);
  dv.setUint8(ptr + 0x0d, e.elem_size ?? 1);
  dv.setUint8(ptr + 0x0e, e.str_encoding ?? 0);
  dv.setUint8(ptr + 0x0f, e.align_pow2 ?? 0);
  dv.setUint32(ptr + 0x10, e.flags ?? 0, true);
  dv.setInt32(ptr + 0x14, e.offset_base_rel ?? 0, true);
}

function readManualSeg(dv, ptr) {
  return {
    base_va: dv.getBigUint64(ptr + 0x00, true),
    size: dv.getBigUint64(ptr + 0x08, true),
    file_offset: dv.getBigUint64(ptr + 0x10, true),
    perms: dv.getUint32(ptr + 0x18, true),
    flags: dv.getUint32(ptr + 0x1c, true),
    name_off: dv.getUint32(ptr + 0x20, true),
    seg_kind: dv.getUint8(ptr + 0x24),
    elem_size: dv.getUint8(ptr + 0x25),
    align_pow2: dv.getUint8(ptr + 0x26),
    reserved: dv.getUint8(ptr + 0x27),
  };
}

function writeFuncChunk(dv, ptr, c) {
  dv.setBigUint64(ptr + 0x00, BigInt(c.owner_fn_va), true);
  dv.setBigUint64(ptr + 0x08, BigInt(c.start_va), true);
  dv.setBigUint64(ptr + 0x10, BigInt(c.end_va), true);
  dv.setUint32(ptr + 0x18, c.chunk_kind ?? HEX_CHUNK_PRIMARY, true);
  dv.setUint32(ptr + 0x1c, c.flags ?? 0, true);
}

function readFuncChunk(dv, ptr) {
  return {
    owner_fn_va: dv.getBigUint64(ptr + 0x00, true),
    start_va: dv.getBigUint64(ptr + 0x08, true),
    end_va: dv.getBigUint64(ptr + 0x10, true),
    chunk_kind: dv.getUint32(ptr + 0x18, true),
    flags: dv.getUint32(ptr + 0x1c, true),
  };
}

function readFuncChunkRange(dv, ptr) {
  return {
    start_va: dv.getBigUint64(ptr + 0x00, true),
    end_va: dv.getBigUint64(ptr + 0x08, true),
    raw_offset: dv.getUint32(ptr + 0x10, true),
    chunk_ord: dv.getUint16(ptr + 0x14, true),
    chunk_flags: dv.getUint16(ptr + 0x16, true),
  };
}

function writeAbiLoc(dv, ptr, loc) {
  dv.setUint8(ptr + 0x00, loc.loc_kind ?? HEX_ABILOC_NONE);
  dv.setUint8(ptr + 0x01, loc.reg_id ?? 0xff);
  dv.setUint8(ptr + 0x02, loc.reg_id_hi ?? 0xff);
  dv.setUint8(ptr + 0x03, loc.byte_width ?? 0);
  dv.setInt16(ptr + 0x04, loc.sp_offset ?? 0, true);
  dv.setUint16(ptr + 0x06, loc.loc_flags ?? 0, true);
}

function readAbiLoc(dv, ptr) {
  return {
    loc_kind: dv.getUint8(ptr + 0x00),
    reg_id: dv.getUint8(ptr + 0x01),
    reg_id_hi: dv.getUint8(ptr + 0x02),
    byte_width: dv.getUint8(ptr + 0x03),
    sp_offset: dv.getInt16(ptr + 0x04, true),
    loc_flags: dv.getUint16(ptr + 0x06, true),
  };
}

function inferRetCount(retLoc) {
  if (!retLoc || retLoc.loc_kind === HEX_ABILOC_NONE) return 0;
  if (retLoc.loc_kind === HEX_ABILOC_GPR_PAIR || retLoc.loc_kind === HEX_ABILOC_FPR_PAIR) return 2;
  return 1;
}

function writeCustomAbi(dv, ptr, spec) {
  for (let i = 0; i < SIZE_CUSTOM_ABI; i += 4) dv.setUint32(ptr + i, 0, true);
  const retLoc = spec.ret_loc ?? { loc_kind: HEX_ABILOC_NONE };
  dv.setBigUint64(ptr + 0x00, BigInt(spec.func_va), true);
  dv.setUint32(ptr + 0x08, spec.abi_flags ?? 0, true);
  dv.setUint16(ptr + 0x0c, spec.sp_purge_bytes ?? 0, true);
  dv.setUint8(ptr + 0x0e, spec.arg_count ?? (spec.arg_locs ? spec.arg_locs.length : 0));
  dv.setUint8(ptr + 0x0f, spec.ret_count !== undefined ? spec.ret_count : inferRetCount(retLoc));
  writeAbiLoc(dv, ptr + 0x10, retLoc);
  dv.setUint32(ptr + 0x18, spec.ret_hex_type ?? 0, true);
  dv.setUint32(ptr + 0x1c, spec.clobber_gp_mask ?? 0, true);
  dv.setUint32(ptr + 0x20, spec.clobber_fp_mask ?? 0, true);
  dv.setUint32(ptr + 0x24, 0, true);
  const argLocs = spec.arg_locs ?? [];
  for (let i = 0; i < argLocs.length && i < 12; ++i) {
    writeAbiLoc(dv, ptr + 0x28 + i * 8, argLocs[i]);
  }
  const argTypes = spec.arg_hex_types ?? [];
  for (let i = 0; i < argTypes.length && i < 12; ++i) {
    dv.setUint32(ptr + 0x88 + i * 4, argTypes[i], true);
  }
}

function readCustomAbi(dv, ptr) {
  const arg_count = dv.getUint8(ptr + 0x0e);
  const arg_locs = [];
  const arg_hex_types = [];
  for (let i = 0; i < arg_count && i < 12; ++i) {
    arg_locs.push(readAbiLoc(dv, ptr + 0x28 + i * 8));
    arg_hex_types.push(dv.getUint32(ptr + 0x88 + i * 4, true));
  }
  return {
    func_va: dv.getBigUint64(ptr + 0x00, true),
    abi_flags: dv.getUint32(ptr + 0x08, true),
    sp_purge_bytes: dv.getUint16(ptr + 0x0c, true),
    arg_count,
    ret_count: dv.getUint8(ptr + 0x0f),
    ret_loc: readAbiLoc(dv, ptr + 0x10),
    ret_hex_type: dv.getUint32(ptr + 0x18, true),
    clobber_gp_mask: dv.getUint32(ptr + 0x1c, true),
    clobber_fp_mask: dv.getUint32(ptr + 0x20, true),
    arg_locs,
    arg_hex_types,
  };
}

function writeStackOverride(dv, ptr, s) {
  dv.setInt32(ptr + 0x00, s.sp_offset, true);
  dv.setUint32(ptr + 0x04, s.byte_size, true);
  dv.setUint32(ptr + 0x08, s.hex_type_id ?? 0, true);
  dv.setUint32(ptr + 0x0c, s.array_len ?? 0, true);
  dv.setUint32(ptr + 0x10, s.slot_flags ?? 0, true);
  dv.setUint32(ptr + 0x14, s.name_off ?? HEX_MANUAL_NAME_NONE, true);
}

function readStackOverride(dv, ptr) {
  return {
    sp_offset: dv.getInt32(ptr + 0x00, true),
    byte_size: dv.getUint32(ptr + 0x04, true),
    hex_type_id: dv.getUint32(ptr + 0x08, true),
    array_len: dv.getUint32(ptr + 0x0c, true),
    slot_flags: dv.getUint32(ptr + 0x10, true),
    name_off: dv.getUint32(ptr + 0x14, true),
  };
}

function writeShiftedPtr(dv, ptr, s) {
  dv.setUint32(ptr + 0x00, s.var_key_hash, true);
  dv.setUint16(ptr + 0x04, s.parent_tid ?? 0, true);
  dv.setUint16(ptr + 0x06, s.spec_flags ?? 0, true);
  dv.setInt32(ptr + 0x08, s.shift_offset, true);
  dv.setInt32(ptr + 0x0c, s.member_off ?? 0, true);
  dv.setUint32(ptr + 0x10, s.member_name_off ?? HEX_MANUAL_NAME_NONE, true);
  dv.setUint32(ptr + 0x14, 0, true);
}

function readShiftedPtr(dv, ptr) {
  return {
    var_key_hash: dv.getUint32(ptr + 0x00, true),
    parent_tid: dv.getUint16(ptr + 0x04, true),
    spec_flags: dv.getUint16(ptr + 0x06, true),
    shift_offset: dv.getInt32(ptr + 0x08, true),
    member_off: dv.getInt32(ptr + 0x0c, true),
    member_name_off: dv.getUint32(ptr + 0x10, true),
    reserved: dv.getUint32(ptr + 0x14, true),
  };
}

async function runTests() {
  const wasmBytes = compileTrack3Wasm();
  const mod = new WebAssembly.Module(wasmBytes);

  // 1. Verify strictly 0 external WASM imports
  const imports = WebAssembly.Module.imports(mod);
  assert.equal(imports.length, 0, `Expected 0 external imports, got: ${JSON.stringify(imports)}`);

  const instance = await WebAssembly.instantiate(mod, {});
  const ex = instance.exports;
  const dv = new DataView(ex.memory.buffer);
  const scratch = ex.hex_recovery_scratch_ptr();
  const scratchSize = ex.hex_recovery_scratch_size();
  assert.ok(scratch > 0 && scratchSize >= 65536, 'Scratch buffer must be valid and >= 64 KiB');

  let passed = 0;
  function test(name, fn) {
    fn();
    passed += 1;
    console.log(`PASS: ${name}`);
  }

  // --------------------------------------------------------------------------
  // Suite 0: NULL pointer safety across ALL APIs
  // --------------------------------------------------------------------------
  test('null_pointer_safety: all pointer-taking exports reject NULL cleanly', () => {
    ex.hex_manual_recovery_reset_all();
    assert.equal(ex.hex_manual_seg_add(0), HEX_ERR_INVALID_ARG);
    assert.equal(ex.hex_manual_seg_add_entry(0), HEX_ERR_INVALID_ARG);
    assert.equal(ex.hex_manual_seg_load_entries(0, 0), HEX_ERR_INVALID_ARG);
    assert.equal(ex.hex_manual_seg_load_entries(0, 1), HEX_ERR_INVALID_ARG);
    assert.equal(ex.hex_manual_seg_get_at(0, 0), HEX_ERR_INVALID_ARG);

    assert.equal(ex.hex_func_chunk_add(0), HEX_ERR_INVALID_ARG);
    assert.equal(ex.hex_func_chunk_list_for_fn(0x10000n, 0, 0, 0), HEX_ERR_INVALID_ARG);
    assert.equal(ex.hex_func_chunk_merge_cfg_ranges(0x10000n, 16, 0, 0, 0), HEX_ERR_INVALID_ARG);

    assert.equal(ex.hex_custom_abi_set(0), HEX_ERR_INVALID_ARG);
    assert.equal(ex.hex_custom_abi_get(0x10000n, 0), HEX_ERR_INVALID_ARG);

    assert.equal(ex.hex_stack_override_set(0x10000n, 0), HEX_ERR_INVALID_ARG);
    assert.equal(ex.hex_stack_override_get(0x10000n, 0, 0), HEX_ERR_INVALID_ARG);
    assert.equal(ex.hex_stack_override_get_ex(0x10000n, 0, 1, 0), HEX_ERR_INVALID_ARG);

    assert.equal(ex.hex_shifted_ptr_set(0x10000n, 0), HEX_ERR_INVALID_ARG);
    assert.equal(ex.hex_shifted_ptr_get(0x10000n, 1, 0), HEX_ERR_INVALID_ARG);
  });

  // --------------------------------------------------------------------------
  // Suite 1: Manual Segment Map (40B HexManualSegment + 24B HexManualSegEntry)
  // --------------------------------------------------------------------------
  test('manual_segment_map: add out-of-order, sorted lookup, VA->file_offset, adjacent allowed', () => {
    ex.hex_manual_seg_reset();
    assert.equal(ex.hex_manual_seg_count(), 0);

    const inPtr = scratch;
    const outSegPtr = scratch + 256;
    const outFileOffPtr = scratch + 512;

    writeManualSeg(dv, inPtr, {
      base_va: 0x4000n,
      size: 0x800n,
      file_offset: 0x1400n,
      perms: HEX_MSEG_PERM_R | HEX_MSEG_PERM_W,
      flags: 0x20,
      name_off: 42,
      seg_kind: HEX_MSEG_DATA_U32,
      elem_size: 4,
      align_pow2: 2,
    });
    assert.equal(ex.hex_manual_seg_add(inPtr), HEX_OK);

    writeManualSeg(dv, inPtr, {
      base_va: 0x1000n,
      size: 0x1000n,
      file_offset: 0x0n,
      perms: HEX_MSEG_PERM_R | HEX_MSEG_PERM_X,
      flags: 0x01,
      name_off: 0,
      seg_kind: HEX_MSEG_CODE,
      elem_size: 4,
      align_pow2: 2,
    });
    assert.equal(ex.hex_manual_seg_add(inPtr), HEX_OK);

    writeManualSeg(dv, inPtr, {
      base_va: 0x2000n,
      size: 0x500n,
      file_offset: HEX_MANUAL_SEG_NO_FILE,
      perms: HEX_MSEG_PERM_R | HEX_MSEG_PERM_W,
      flags: 0x40,
      name_off: 16,
      seg_kind: HEX_MSEG_DATA_U8,
      elem_size: 1,
      align_pow2: 0,
    });
    assert.equal(ex.hex_manual_seg_add(inPtr), HEX_OK);
    assert.equal(ex.hex_manual_seg_count(), 3);

    assert.equal(ex.hex_manual_seg_get_at(0, outSegPtr), HEX_OK);
    assert.equal(readManualSeg(dv, outSegPtr).base_va, 0x1000n);
    assert.equal(ex.hex_manual_seg_get_at(1, outSegPtr), HEX_OK);
    assert.equal(readManualSeg(dv, outSegPtr).base_va, 0x2000n);
    assert.equal(ex.hex_manual_seg_get_at(2, outSegPtr), HEX_OK);
    assert.equal(readManualSeg(dv, outSegPtr).base_va, 0x4000n);
    assert.equal(ex.hex_manual_seg_get_at(3, outSegPtr), HEX_ERR_INVALID_ARG);

    assert.equal(ex.hex_manual_seg_lookup(0x4000n, outSegPtr, outFileOffPtr), HEX_OK);
    assert.equal(dv.getBigUint64(outFileOffPtr, true), 0x1400n);
    assert.equal(ex.hex_manual_seg_lookup(0x4234n, outSegPtr, outFileOffPtr), HEX_OK);
    assert.equal(dv.getBigUint64(outFileOffPtr, true), 0x1634n);
    assert.equal(ex.hex_manual_seg_lookup(0x47ffn, outSegPtr, outFileOffPtr), HEX_OK);
    assert.equal(dv.getBigUint64(outFileOffPtr, true), 0x1bffn);

    assert.equal(ex.hex_manual_seg_lookup(0x2100n, outSegPtr, outFileOffPtr), HEX_OK);
    assert.equal(dv.getBigUint64(outFileOffPtr, true), HEX_MANUAL_SEG_NO_FILE);

    assert.equal(ex.hex_manual_seg_lookup(0x0fffn, outSegPtr, outFileOffPtr), HEX_ERR_INVALID_ARG);
    assert.equal(ex.hex_manual_seg_lookup(0x2500n, outSegPtr, outFileOffPtr), HEX_ERR_INVALID_ARG);
    assert.equal(ex.hex_manual_seg_lookup(0x4800n, outSegPtr, outFileOffPtr), HEX_ERR_INVALID_ARG);

    assert.equal(ex.hex_manual_seg_remove(0x2000n), HEX_OK);
    assert.equal(ex.hex_manual_seg_count(), 2);
    assert.equal(ex.hex_manual_seg_lookup(0x2100n, outSegPtr, outFileOffPtr), HEX_ERR_INVALID_ARG);
    assert.equal(ex.hex_manual_seg_remove(0x2000n), HEX_ERR_INVALID_ARG);
  });

  test('manual_segment_map: 24B HexManualSegEntry add_entry & load_entries batch API', () => {
    ex.hex_manual_seg_reset();
    const inPtr = scratch;
    const outSegPtr = scratch + 4096;

    // Single 24B entry add + coexistence with 40B add
    writeManualSegEntry24(dv, inPtr, {
      start_va: 0x8000n,
      byte_len: 16,
      kind: HEX_MSEG_CODE,
      elem_size: 4,
      str_encoding: 0,
      align_pow2: 2,
      flags: 0x01,
      offset_base_rel: 0,
    });
    assert.equal(ex.hex_manual_seg_add_entry(inPtr), HEX_OK);

    writeManualSeg(dv, inPtr + 64, {
      base_va: 0x9000n,
      size: 0x100n,
      file_offset: 0x500n,
      seg_kind: HEX_MSEG_DATA_U32,
      elem_size: 4,
    });
    assert.equal(ex.hex_manual_seg_add(inPtr + 64), HEX_OK);
    assert.equal(ex.hex_manual_seg_count(), 2);

    assert.equal(ex.hex_manual_seg_lookup(0x8004n, outSegPtr, 0), HEX_OK);
    const s = readManualSeg(dv, outSegPtr);
    assert.equal(s.base_va, 0x8000n);
    assert.equal(s.size, 16n);
    assert.equal(s.seg_kind, HEX_MSEG_CODE);
    assert.equal(s.perms, HEX_MSEG_PERM_R | HEX_MSEG_PERM_X);

    // Invalid 24B entry (bad str_encoding, unaligned CODE, zero byte_len)
    writeManualSegEntry24(dv, inPtr, { start_va: 0xa000n, byte_len: 8, kind: HEX_MSEG_STR, str_encoding: 4 });
    assert.equal(ex.hex_manual_seg_add_entry(inPtr), HEX_ERR_INVALID_ARG);
    writeManualSegEntry24(dv, inPtr, { start_va: 0xa002n, byte_len: 8, kind: HEX_MSEG_CODE, elem_size: 4 });
    assert.equal(ex.hex_manual_seg_add_entry(inPtr), HEX_ERR_INVALID_ARG);
    writeManualSegEntry24(dv, inPtr, { start_va: 0xa000n, byte_len: 0, kind: HEX_MSEG_DATA_U8 });
    assert.equal(ex.hex_manual_seg_add_entry(inPtr), HEX_ERR_INVALID_ARG);

    // Batch load replaces table cleanly
    const batchEntries = [
      { start_va: 0x3000n, byte_len: 32, kind: HEX_MSEG_STR, elem_size: 1, str_encoding: 0, flags: 0x20 },
      { start_va: 0x1000n, byte_len: 64, kind: HEX_MSEG_CODE, elem_size: 4, align_pow2: 2, flags: 0x01 },
    ];
    for (let i = 0; i < batchEntries.length; ++i) {
      writeManualSegEntry24(dv, inPtr + i * SIZE_MANUAL_SEG_ENTRY, batchEntries[i]);
    }
    assert.equal(ex.hex_manual_seg_load_entries(inPtr, batchEntries.length), HEX_OK);
    assert.equal(ex.hex_manual_seg_count(), 2);
    assert.equal(ex.hex_manual_seg_lookup(0x1010n, outSegPtr, 0), HEX_OK);
    assert.equal(readManualSeg(dv, outSegPtr).seg_kind, HEX_MSEG_CODE);

    // Fail-Closed rollback if any entry in batch overlaps
    writeManualSegEntry24(dv, inPtr + 0 * SIZE_MANUAL_SEG_ENTRY, { start_va: 0x1000n, byte_len: 32, kind: HEX_MSEG_CODE, elem_size: 4 });
    writeManualSegEntry24(dv, inPtr + 1 * SIZE_MANUAL_SEG_ENTRY, { start_va: 0x1010n, byte_len: 32, kind: HEX_MSEG_DATA_U8, elem_size: 1 });
    assert.equal(ex.hex_manual_seg_load_entries(inPtr, 2), HEX_ERR_INVALID_ARG);
    assert.equal(ex.hex_manual_seg_count(), 0);
  });

  test('manual_segment_map: overlap, overflow, alignment & capacity enforcement', () => {
    ex.hex_manual_seg_reset();
    const inPtr = scratch;

    writeManualSeg(dv, inPtr, { base_va: 0x10000n, size: 0x1000n, file_offset: 0x0n, seg_kind: HEX_MSEG_CODE, elem_size: 4 });
    assert.equal(ex.hex_manual_seg_add(inPtr), HEX_OK);

    for (const [b, sz] of [
      [0x0f800n, 0x0804n],
      [0x10ffcn, 0x0100n],
      [0x10000n, 0x1000n],
      [0x10100n, 0x0100n],
      [0x0f000n, 0x3000n],
    ]) {
      writeManualSeg(dv, inPtr, { base_va: b, size: sz, file_offset: 0n, seg_kind: HEX_MSEG_UNDEF });
      assert.equal(ex.hex_manual_seg_add(inPtr), HEX_ERR_INVALID_ARG);
    }

    writeManualSeg(dv, inPtr, { base_va: 0x20000n, size: 0n });
    assert.equal(ex.hex_manual_seg_add(inPtr), HEX_ERR_INVALID_ARG);
    writeManualSeg(dv, inPtr, { base_va: 0xfffffffffffff000n, size: 0x2000n });
    assert.equal(ex.hex_manual_seg_add(inPtr), HEX_ERR_INVALID_ARG);
    writeManualSeg(dv, inPtr, { base_va: 0x20000n, size: 0x2000n, file_offset: 0xfffffffffffff000n });
    assert.equal(ex.hex_manual_seg_add(inPtr), HEX_ERR_INVALID_ARG);
    writeManualSeg(dv, inPtr, { base_va: 0x20002n, size: 0x100n, seg_kind: HEX_MSEG_CODE, elem_size: 4 });
    assert.equal(ex.hex_manual_seg_add(inPtr), HEX_ERR_INVALID_ARG);

    ex.hex_manual_seg_reset();
    const cap = ex.hex_manual_seg_capacity();
    for (let i = 0; i < cap; ++i) {
      writeManualSeg(dv, inPtr, {
        base_va: BigInt(0x100000 + i * 0x100),
        size: 0x80n,
        file_offset: BigInt(i * 0x80),
        seg_kind: HEX_MSEG_DATA_U8,
      });
      assert.equal(ex.hex_manual_seg_add(inPtr), HEX_OK);
    }
    writeManualSeg(dv, inPtr, { base_va: BigInt(0x100000 + cap * 0x100), size: 0x80n, file_offset: 0n });
    assert.equal(ex.hex_manual_seg_add(inPtr), HEX_ERR_RESOURCE_LIMIT);
    ex.hex_manual_seg_reset();
  });

  // --------------------------------------------------------------------------
  // Suite 2: Discontiguous Function Chunks & CFG Range Merge
  // --------------------------------------------------------------------------
  test('func_chunk_cfg: alignment, remove, owner lookup, measurement coalescing parity & cap limit', () => {
    ex.hex_func_chunk_reset();
    const inPtr = scratch;
    const outOwnerPtr = scratch + 256;
    const outChunkPtr = scratch + 512;
    const outListPtr = scratch + 1024;
    const outCountPtr = scratch + 4096;
    const outRangesPtr = scratch + 8192;

    const fnA = 0x10000n;
    const fnB = 0x20000n;

    // ARM64 4-byte alignment enforcement
    writeFuncChunk(dv, inPtr, { owner_fn_va: fnA, start_va: 0x10002n, end_va: 0x10020n, chunk_kind: HEX_CHUNK_PRIMARY });
    assert.equal(ex.hex_func_chunk_add(inPtr), HEX_ERR_INVALID_ARG);
    writeFuncChunk(dv, inPtr, { owner_fn_va: fnA, start_va: 0x10000n, end_va: 0x10022n, chunk_kind: HEX_CHUNK_PRIMARY });
    assert.equal(ex.hex_func_chunk_add(inPtr), HEX_ERR_INVALID_ARG);

    const chunks = [
      { owner_fn_va: fnA, start_va: 0x90000n, end_va: 0x90080n, chunk_kind: HEX_CHUNK_COLD_BLOCK, flags: HEX_CHUNK_FLAG_UNWIND_COLD },
      { owner_fn_va: fnA, start_va: 0x90080n, end_va: 0x90100n, chunk_kind: HEX_CHUNK_COLD_BLOCK, flags: HEX_CHUNK_FLAG_UNWIND_COLD },
      { owner_fn_va: fnA, start_va: 0x10000n, end_va: 0x10200n, chunk_kind: HEX_CHUNK_PRIMARY, flags: HEX_CHUNK_FLAG_MANUAL },
      { owner_fn_va: fnA, start_va: 0x50000n, end_va: 0x50040n, chunk_kind: HEX_CHUNK_TAIL_CALL, flags: HEX_CHUNK_FLAG_OUTLINED_TAIL },
      { owner_fn_va: fnA, start_va: 0x95000n, end_va: 0x95040n, chunk_kind: HEX_CHUNK_OUTLINE, flags: HEX_CHUNK_FLAG_DETACHED },
      { owner_fn_va: fnB, start_va: 0x20000n, end_va: 0x20100n, chunk_kind: HEX_CHUNK_PRIMARY, flags: 0 },
    ];
    for (const c of chunks) {
      writeFuncChunk(dv, inPtr, c);
      assert.equal(ex.hex_func_chunk_add(inPtr), HEX_OK);
    }
    assert.equal(ex.hex_func_chunk_count(), 6);

    // Owner lookup + detached exclusion
    assert.equal(ex.hex_func_chunk_find_owner(0x5003cn, outOwnerPtr, outChunkPtr), HEX_OK);
    assert.equal(dv.getBigUint64(outOwnerPtr, true), fnA);
    assert.equal(readFuncChunk(dv, outChunkPtr).chunk_kind, HEX_CHUNK_TAIL_CALL);
    assert.equal(ex.hex_func_chunk_find_owner(0x95010n, outOwnerPtr, outChunkPtr), HEX_ERR_INVALID_ARG);

    // Measurement mode (out_ranges = 0, max_ranges = 0) MUST return exact coalesced count (3, not 4!)
    assert.equal(ex.hex_func_chunk_merge_cfg_ranges(fnA, 16, 0, 0, outCountPtr), HEX_OK);
    const measuredCount = dv.getUint32(outCountPtr, true);
    assert.equal(measuredCount, 3, 'Measurement mode must match coalesced range count');

    // Actual output matches measurement mode 1:1
    assert.equal(ex.hex_func_chunk_merge_cfg_ranges(fnA, 16, outRangesPtr, 16, outCountPtr), HEX_OK);
    assert.equal(dv.getUint32(outCountPtr, true), measuredCount);

    const r0 = readFuncChunkRange(dv, outRangesPtr + 0 * SIZE_FUNC_CHUNK_RANGE);
    const r1 = readFuncChunkRange(dv, outRangesPtr + 1 * SIZE_FUNC_CHUNK_RANGE);
    const r2 = readFuncChunkRange(dv, outRangesPtr + 2 * SIZE_FUNC_CHUNK_RANGE);
    assert.equal(r0.start_va, 0x10000n);
    assert.equal(r0.chunk_ord, 0);
    assert.equal(r1.start_va, 0x50000n);
    assert.equal(r1.raw_offset, 0x200);
    assert.equal(r2.start_va, 0x90000n);
    assert.equal(r2.end_va, 0x90100n);
    assert.equal(r2.raw_offset, 0x240);

    // max_chunks_cap exceeded MUST return HEX_ERR_RESOURCE_LIMIT (no silent truncation)
    assert.equal(ex.hex_func_chunk_merge_cfg_ranges(fnA, 2, outRangesPtr, 16, outCountPtr), HEX_ERR_RESOURCE_LIMIT);
    assert.equal(dv.getUint32(outCountPtr, true), 2);
    assert.equal(ex.hex_func_chunk_merge_cfg_ranges(fnA, 2, 0, 0, outCountPtr), HEX_ERR_RESOURCE_LIMIT);
    assert.equal(dv.getUint32(outCountPtr, true), 2);

    // hex_func_chunk_remove test
    assert.equal(ex.hex_func_chunk_remove(0x50000n), HEX_OK);
    assert.equal(ex.hex_func_chunk_count(), 5);
    assert.equal(ex.hex_func_chunk_find_owner(0x50010n, outOwnerPtr, outChunkPtr), HEX_ERR_INVALID_ARG);
    assert.equal(ex.hex_func_chunk_remove(0x50000n), HEX_ERR_INVALID_ARG);

    // List for fnA now has 3 active chunks
    assert.equal(ex.hex_func_chunk_list_for_fn(fnA, outListPtr, 8, outCountPtr), HEX_OK);
    assert.equal(dv.getUint32(outCountPtr, true), 3);
    assert.equal(readFuncChunk(dv, outListPtr + 0 * SIZE_FUNC_CHUNK).start_va, 0x10000n);
  });

  // --------------------------------------------------------------------------
  // Suite 3: Custom ABI Specs (FP/LR gating, ret_count consistency, capacity)
  // --------------------------------------------------------------------------
  test('custom_abi_spec: FP/LR gating, ret_count consistency, upsert & validation', () => {
    ex.hex_custom_abi_reset();
    const inPtr = scratch;
    const outPtr = scratch + 512;

    const baseSpec = {
      func_va: 0x10004000n,
      abi_flags: 0x05,
      sp_purge_bytes: 32,
      arg_count: 2,
      ret_count: 1,
      ret_loc: { loc_kind: HEX_ABILOC_GPR, reg_id: 0, byte_width: 8 },
      ret_hex_type: 0x101,
      clobber_gp_mask: 0x0003ffff,
      clobber_fp_mask: 0x000000ff,
      arg_locs: [
        { loc_kind: HEX_ABILOC_GPR, reg_id: 20, byte_width: 8 },
        { loc_kind: HEX_ABILOC_STACK, reg_id: 0xff, byte_width: 8, sp_offset: 16 },
      ],
      arg_hex_types: [0x201, 0x202],
    };

    writeCustomAbi(dv, inPtr, baseSpec);
    assert.equal(ex.hex_custom_abi_set(inPtr), HEX_OK);
    assert.equal(ex.hex_custom_abi_get(0x10004000n, outPtr), HEX_OK);
    assert.equal(readCustomAbi(dv, outPtr).ret_count, 1);

    // FP (x29) and LR (x30) rejected without ALLOW_FP_LR in both GPR and GPR_PAIR
    for (const badArg of [
      { loc_kind: HEX_ABILOC_GPR, reg_id: 29, byte_width: 8, loc_flags: 0 },
      { loc_kind: HEX_ABILOC_GPR, reg_id: 30, byte_width: 8, loc_flags: 0 },
      { loc_kind: HEX_ABILOC_GPR_PAIR, reg_id: 28, reg_id_hi: 29, byte_width: 16, loc_flags: 0 },
      { loc_kind: HEX_ABILOC_GPR_PAIR, reg_id: 30, reg_id_hi: 1, byte_width: 16, loc_flags: 0 },
    ]) {
      writeCustomAbi(dv, inPtr, { ...baseSpec, func_va: 0x2000n, arg_count: 1, arg_locs: [badArg] });
      assert.equal(ex.hex_custom_abi_set(inPtr), HEX_ERR_INVALID_ARG);
    }

    // FP/LR accepted when HEX_ABILOC_FLAG_ALLOW_FP_LR is explicitly set
    writeCustomAbi(dv, inPtr, {
      ...baseSpec,
      func_va: 0x2004n,
      arg_count: 2,
      arg_locs: [
        { loc_kind: HEX_ABILOC_GPR, reg_id: 29, byte_width: 8, loc_flags: HEX_ABILOC_FLAG_ALLOW_FP_LR },
        { loc_kind: HEX_ABILOC_GPR, reg_id: 30, byte_width: 8, loc_flags: HEX_ABILOC_FLAG_ALLOW_FP_LR },
      ],
    });
    assert.equal(ex.hex_custom_abi_set(inPtr), HEX_OK);

    // ret_count consistency: NONE->0, GPR/FPR/STACK->1, PAIR->2
    // Valid NONE->0 and PAIR->2
    writeCustomAbi(dv, inPtr, {
      ...baseSpec,
      func_va: 0x2010n,
      ret_loc: { loc_kind: HEX_ABILOC_NONE },
      ret_count: 0,
    });
    assert.equal(ex.hex_custom_abi_set(inPtr), HEX_OK);

    writeCustomAbi(dv, inPtr, {
      ...baseSpec,
      func_va: 0x2014n,
      ret_loc: { loc_kind: HEX_ABILOC_GPR_PAIR, reg_id: 0, reg_id_hi: 1, byte_width: 16 },
      ret_count: 2,
    });
    assert.equal(ex.hex_custom_abi_set(inPtr), HEX_OK);

    // Mismatched ret_count rejected
    writeCustomAbi(dv, inPtr, {
      ...baseSpec,
      func_va: 0x2020n,
      ret_loc: { loc_kind: HEX_ABILOC_GPR, reg_id: 0, byte_width: 8 },
      ret_count: 0,
    });
    assert.equal(ex.hex_custom_abi_set(inPtr), HEX_ERR_INVALID_ARG);

    writeCustomAbi(dv, inPtr, {
      ...baseSpec,
      func_va: 0x2020n,
      ret_loc: { loc_kind: HEX_ABILOC_GPR_PAIR, reg_id: 0, reg_id_hi: 1, byte_width: 16 },
      ret_count: 1,
    });
    assert.equal(ex.hex_custom_abi_set(inPtr), HEX_ERR_INVALID_ARG);

    writeCustomAbi(dv, inPtr, {
      ...baseSpec,
      func_va: 0x2020n,
      ret_loc: { loc_kind: HEX_ABILOC_NONE },
      ret_count: 1,
    });
    assert.equal(ex.hex_custom_abi_set(inPtr), HEX_ERR_INVALID_ARG);

    // SP (reg 31) forbidden even with ALLOW_FP_LR
    writeCustomAbi(dv, inPtr, {
      ...baseSpec,
      func_va: 0x2030n,
      arg_count: 1,
      arg_locs: [{ loc_kind: HEX_ABILOC_GPR, reg_id: 31, byte_width: 8, loc_flags: HEX_ABILOC_FLAG_ALLOW_FP_LR }],
    });
    assert.equal(ex.hex_custom_abi_set(inPtr), HEX_ERR_INVALID_ARG);
  });

  // --------------------------------------------------------------------------
  // Suite 4: Stack Overrides (SP vs FP_REL separation, interval overlap, int32 overflow)
  // --------------------------------------------------------------------------
  test('stack_override: SP vs FP_REL coexistence, interval overlap & int32 overflow rejection', () => {
    ex.hex_stack_override_reset();
    const inPtr = scratch;
    const outPtr = scratch + 256;
    const fn = 0x400100n;

    // Same sp_offset (0x20) in SP-relative and FP-relative spaces MUST coexist cleanly
    writeStackOverride(dv, inPtr, {
      sp_offset: 0x20,
      byte_size: 16,
      hex_type_id: 0x111,
      slot_flags: HEX_STACK_FLAG_FORCE_SPLIT,
    });
    assert.equal(ex.hex_stack_override_set(fn, inPtr), HEX_OK);

    writeStackOverride(dv, inPtr, {
      sp_offset: 0x20,
      byte_size: 8,
      hex_type_id: 0x222,
      slot_flags: HEX_STACK_FLAG_FP_REL | HEX_STACK_FLAG_NO_REG_PROMOTE,
    });
    assert.equal(ex.hex_stack_override_set(fn, inPtr), HEX_OK);
    assert.equal(ex.hex_stack_override_count(), 2);

    // Lookup SP-relative via both get() and get_ex(..., 0)
    assert.equal(ex.hex_stack_override_get(fn, 0x20, outPtr), HEX_OK);
    assert.equal(readStackOverride(dv, outPtr).hex_type_id, 0x111);
    assert.equal(ex.hex_stack_override_get_ex(fn, 0x20, 0, outPtr), HEX_OK);
    assert.equal(readStackOverride(dv, outPtr).hex_type_id, 0x111);

    // Lookup FP-relative via get_ex(..., 1)
    assert.equal(ex.hex_stack_override_get_ex(fn, 0x20, 1, outPtr), HEX_OK);
    assert.equal(readStackOverride(dv, outPtr).hex_type_id, 0x222);

    // Adjacent slot in SP space [0x30, 0x38) MUST succeed
    writeStackOverride(dv, inPtr, { sp_offset: 0x30, byte_size: 8, hex_type_id: 0x333, slot_flags: 0 });
    assert.equal(ex.hex_stack_override_set(fn, inPtr), HEX_OK);

    // Overlapping intervals in SP space MUST be rejected:
    // partial left [0x18, 0x24), interior [0x24, 0x28), partial right [0x28, 0x34), enclosing [0x10, 0x40)
    for (const [off, sz] of [
      [0x18, 12],
      [0x24, 4],
      [0x28, 12],
      [0x10, 48],
    ]) {
      writeStackOverride(dv, inPtr, { sp_offset: off, byte_size: sz, hex_type_id: 1, slot_flags: 0 });
      assert.equal(ex.hex_stack_override_set(fn, inPtr), HEX_ERR_INVALID_ARG);
    }

    // Upsert expanding [0x20, 0x34) into successor [0x30, 0x38) MUST be rejected
    writeStackOverride(dv, inPtr, { sp_offset: 0x20, byte_size: 20, hex_type_id: 0x111, slot_flags: 0 });
    assert.equal(ex.hex_stack_override_set(fn, inPtr), HEX_ERR_INVALID_ARG);

    // Upsert shrinking [0x20, 0x28) succeeds
    writeStackOverride(dv, inPtr, { sp_offset: 0x20, byte_size: 8, hex_type_id: 0x112, slot_flags: 0 });
    assert.equal(ex.hex_stack_override_set(fn, inPtr), HEX_OK);
    assert.equal(ex.hex_stack_override_get_ex(fn, 0x20, 0, outPtr), HEX_OK);
    assert.equal(readStackOverride(dv, outPtr).hex_type_id, 0x112);

    // int32_t addition overflow in sp_offset + byte_size MUST be rejected
    writeStackOverride(dv, inPtr, { sp_offset: 0x7ffffff0, byte_size: 32, hex_type_id: 1, slot_flags: 0 });
    assert.equal(ex.hex_stack_override_set(fn, inPtr), HEX_ERR_INVALID_ARG);
  });

  // --------------------------------------------------------------------------
  // Suite 5: Shifted Pointers & Isolated Reset Non-Interference
  // --------------------------------------------------------------------------
  test('isolated_resets: individual resets do not clobber sibling tables, reset_all clears everything', () => {
    ex.hex_manual_recovery_reset_all();
    const inPtr = scratch;
    const fn = 0x500200n;

    writeManualSeg(dv, inPtr, { base_va: 0x1000n, size: 0x100n, file_offset: 0n, seg_kind: HEX_MSEG_CODE, elem_size: 4 });
    assert.equal(ex.hex_manual_seg_add(inPtr), HEX_OK);

    writeFuncChunk(dv, inPtr, { owner_fn_va: fn, start_va: fn, end_va: fn + 0x40n, chunk_kind: HEX_CHUNK_PRIMARY });
    assert.equal(ex.hex_func_chunk_add(inPtr), HEX_OK);

    writeCustomAbi(dv, inPtr, {
      func_va: fn,
      ret_loc: { loc_kind: HEX_ABILOC_GPR, reg_id: 0, byte_width: 8 },
      ret_count: 1,
      arg_count: 0,
    });
    assert.equal(ex.hex_custom_abi_set(inPtr), HEX_OK);

    writeStackOverride(dv, inPtr, { sp_offset: 0x10, byte_size: 8, hex_type_id: 1 });
    assert.equal(ex.hex_stack_override_set(fn, inPtr), HEX_OK);

    writeShiftedPtr(dv, inPtr, {
      var_key_hash: 0x811c9dc5,
      parent_tid: 77,
      spec_flags: HEX_SHIFTED_FLAG_PREFER_CONTAINER_OF,
      shift_offset: 0x18,
    });
    assert.equal(ex.hex_shifted_ptr_set(fn, inPtr), HEX_OK);

    // hex_custom_abi_reset clears ONLY custom_abi (NOT stack_override or shifted_ptr)
    ex.hex_custom_abi_reset();
    assert.equal(ex.hex_custom_abi_count(), 0);
    assert.equal(ex.hex_stack_override_count(), 1);
    assert.equal(ex.hex_shifted_ptr_count(), 1);
    assert.equal(ex.hex_manual_seg_count(), 1);
    assert.equal(ex.hex_func_chunk_count(), 1);

    // hex_stack_override_reset clears ONLY stack_override
    ex.hex_stack_override_reset();
    assert.equal(ex.hex_stack_override_count(), 0);
    assert.equal(ex.hex_shifted_ptr_count(), 1);

    // Re-populate and verify hex_shifted_ptr_reset clears ONLY shifted_ptr
    writeStackOverride(dv, inPtr, { sp_offset: 0x10, byte_size: 8, hex_type_id: 1 });
    assert.equal(ex.hex_stack_override_set(fn, inPtr), HEX_OK);
    ex.hex_shifted_ptr_reset();
    assert.equal(ex.hex_shifted_ptr_count(), 0);
    assert.equal(ex.hex_stack_override_count(), 1);

    // hex_manual_recovery_reset_all clears all 5 tables
    ex.hex_manual_recovery_reset_all();
    assert.equal(ex.hex_manual_seg_count(), 0);
    assert.equal(ex.hex_func_chunk_count(), 0);
    assert.equal(ex.hex_custom_abi_count(), 0);
    assert.equal(ex.hex_stack_override_count(), 0);
    assert.equal(ex.hex_shifted_ptr_count(), 0);
  });

  test('shifted_ptr: negative shift gating & capacity boundary', () => {
    ex.hex_shifted_ptr_reset();
    const inPtr = scratch;
    const outPtr = scratch + 256;
    const fn = 0x600000n;

    writeShiftedPtr(dv, inPtr, { var_key_hash: 0x1111, parent_tid: 5, spec_flags: 0, shift_offset: -8 });
    assert.equal(ex.hex_shifted_ptr_set(fn, inPtr), HEX_ERR_INVALID_ARG);

    writeShiftedPtr(dv, inPtr, {
      var_key_hash: 0x1111,
      parent_tid: 5,
      spec_flags: HEX_SHIFTED_FLAG_ALLOW_NEG_OFFSET,
      shift_offset: -8,
    });
    assert.equal(ex.hex_shifted_ptr_set(fn, inPtr), HEX_OK);
    assert.equal(ex.hex_shifted_ptr_get(fn, 0x1111, outPtr), HEX_OK);
    assert.equal(readShiftedPtr(dv, outPtr).shift_offset, -8);

    ex.hex_shifted_ptr_reset();
    const cap = ex.hex_shifted_ptr_capacity();
    for (let i = 0; i < cap; ++i) {
      writeShiftedPtr(dv, inPtr, { var_key_hash: i + 1, parent_tid: 1, shift_offset: 8 });
      assert.equal(ex.hex_shifted_ptr_set(fn, inPtr), HEX_OK);
    }
    writeShiftedPtr(dv, inPtr, { var_key_hash: cap + 1, parent_tid: 1, shift_offset: 8 });
    assert.equal(ex.hex_shifted_ptr_set(fn, inPtr), HEX_ERR_RESOURCE_LIMIT);
    ex.hex_manual_recovery_reset_all();
  });

  console.log(`\nALL ${passed}/${passed} Track 3 Manual Recovery WASM tests PASSED (wasm=${wasmBytes.length} bytes, imports=0).`);
}

runTests().catch((err) => {
  console.error('Track 3 test FAILED:', err);
  process.exit(1);
});
