import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');

// Compile Track 5 C++20 files into a standalone wasm32 module and verify 0 external imports.
function buildAndLoadTrack5Wasm() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hex-ida-track05-'));
  const wasmPath = path.join(tmpDir, 'track05_deobf_emu.wasm');
  const sources = [
    'cpp/src/cfg/cff_unflatten.cpp',
    'cpp/src/decompiler/mba_simplifier.cpp',
    'cpp/src/analysis/mini_arm64_emu.cpp',
    'cpp/src/analysis/deobf_eval_arm64.cpp',
  ];
  const args = [
    '--target=wasm32',
    '-std=c++20',
    '-O3',
    '-nostdlib',
    '-fno-exceptions',
    '-fno-rtti',
    '-mbulk-memory',
    '-Wl,--no-entry',
    '-Wl,--export-dynamic',
    '-Icpp/include',
    ...sources,
    '-o',
    wasmPath,
  ];

  try {
    execFileSync('clang++', args, { cwd: REPO_ROOT, stdio: 'pipe' });
    const bytes = fs.readFileSync(wasmPath);
    const mod = new WebAssembly.Module(bytes);
    const imports = WebAssembly.Module.imports(mod);
    assert.equal(
      imports.length,
      0,
      `Track 5 standalone WASM must have 0 external imports, got ${imports.length}: ${JSON.stringify(imports)}`
    );
    return { bytes, mod };
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

const { bytes: WASM_BYTES } = buildAndLoadTrack5Wasm();
const { instance: WASM_INST } = await WebAssembly.instantiate(WASM_BYTES, {});
const EXPORTS = WASM_INST.exports;

// Simple bump allocator over the exported 128 KiB scratch buffer in WASM linear memory.
class ScratchAlloc {
  constructor() {
    this.base = EXPORTS.hex_deobf_scratch_ptr() >>> 0;
    this.size = EXPORTS.hex_deobf_scratch_size() >>> 0;
    this.off = 0;
  }
  reset() {
    this.off = 0;
  }
  alloc(bytes, align = 8) {
    const aligned = (this.off + (align - 1)) & ~(align - 1);
    assert.ok(aligned + bytes <= this.size, 'scratch overflow');
    this.off = aligned + bytes;
    return this.base + aligned;
  }
  view() {
    return new DataView(EXPORTS.memory.buffer);
  }
}

const alloc = new ScratchAlloc();

// ============================================================================
// Constants matching cpp/include/hex_deobf.hpp
// ============================================================================
const HEX_OK = 0;
const HEX_ERR_INVALID_ARG = 1;
const HEX_ERR_RESOURCE_LIMIT = 3;
const HEX_ERR_UNSUPPORTED = 4;

const CFF_BLK_ENTRY = 1 << 0;
const CFF_BLK_HAS_SWITCH = 1 << 1;
const CFF_BLK_UPDATES_STATE = 1 << 2;
const CFF_BLK_COND_UPDATE = 1 << 3;
const CFF_BLK_HAS_EXIT = 1 << 4;
const CFF_BLK_STATE_EXTERN = 1 << 7;

const CFF_EDGE_UNCOND = 1;
const CFF_EDGE_COND_TRUE = 2;
const CFF_EDGE_COND_FALSE = 3;
const CFF_EDGE_SWITCH = 4;
const CFF_EDGE_BACKEDGE = 5;

const CFF_STATUS_RECOVERED = 0;
const CFF_STATUS_ABORT_GUARD = 2;
const CFF_GUARD_NATURAL_FSM = 2;
const CFF_GUARD_UNRESOLVED_EDGE = 4;

const MBA_VAR = 0;
const MBA_CONST = 1;
const MBA_ADD = 2;
const MBA_SUB = 3;
const MBA_NEG = 4;
const MBA_NOT = 5;
const MBA_AND = 6;
const MBA_OR = 7;
const MBA_XOR = 8;
const MBA_MUL_CONST = 9;

const MBA_SIMP_LINEAR_VAR = 2;
const MBA_SIMP_BITWISE_AND = 3;
const MBA_SIMP_NEG_VAR = 6;

const EMU_STATE_SIZE = 0x1138;
const EMU_FAULT_NONE = 0;
const EMU_FAULT_HALTED_RET = 1;
const EMU_FAULT_STEP_LIMIT = 2;
const EMU_FAULT_MEM_OOB = 4;
const EMU_FAULT_UNSUPPORTED_INSN = 5;

const OPAQUE_UNKNOWN = 0;
const OPAQUE_ALWAYS_TAKEN = 1;
const OPAQUE_NEVER_TAKEN = 2;

// ============================================================================
// Struct Marshaling Helpers
// ============================================================================
function writeCffBlocks(blocks) {
  const ptr = alloc.alloc(blocks.length * 48, 8);
  const dv = alloc.view();
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    const o = ptr + i * 48;
    dv.setUint32(o + 0x00, b.block_id >>> 0, true);
    dv.setUint32(o + 0x04, (b.flags ?? 0) >>> 0, true);
    dv.setUint32(o + 0x08, (b.state_var_id ?? 0) >>> 0, true);
    dv.setUint32(o + 0x0c, (b.cond_id ?? 0) >>> 0, true);
    dv.setBigUint64(o + 0x10, BigInt(b.match_state ?? 0), true);
    dv.setBigUint64(o + 0x18, BigInt(b.next_state_true ?? 0), true);
    dv.setBigUint64(o + 0x20, BigInt(b.next_state_false ?? 0), true);
    dv.setUint32(o + 0x28, (b.has_match_state ?? 0) >>> 0, true);
    dv.setUint32(o + 0x2c, 0, true);
  }
  return ptr;
}

function writeCffEdges(edges) {
  const ptr = alloc.alloc(edges.length * 16, 4);
  const dv = alloc.view();
  for (let i = 0; i < edges.length; i++) {
    const e = edges[i];
    const o = ptr + i * 16;
    dv.setUint32(o + 0x00, e.src >>> 0, true);
    dv.setUint32(o + 0x04, e.dst >>> 0, true);
    dv.setUint32(o + 0x08, (e.kind ?? 0) >>> 0, true);
    dv.setUint32(o + 0x0c, (e.cond_id ?? 0) >>> 0, true);
  }
  return ptr;
}

function readCffEdges(ptr, count) {
  const dv = alloc.view();
  const out = [];
  for (let i = 0; i < count; i++) {
    const o = ptr + i * 16;
    out.push({
      src: dv.getUint32(o + 0x00, true),
      dst: dv.getUint32(o + 0x04, true),
      kind: dv.getUint32(o + 0x08, true),
      cond_id: dv.getUint32(o + 0x0c, true),
    });
  }
  return out;
}

function readCffResult(ptr) {
  const dv = alloc.view();
  return {
    status: dv.getUint32(ptr + 0x00, true),
    guard_fail_reason: dv.getUint32(ptr + 0x04, true),
    dispatcher_block: dv.getUint32(ptr + 0x08, true),
    state_var_id: dv.getUint32(ptr + 0x0c, true),
    real_block_count: dv.getUint32(ptr + 0x10, true),
    spine_block_count: dv.getUint32(ptr + 0x14, true),
    recovered_edge_count: dv.getUint32(ptr + 0x18, true),
    uncond_edge_count: dv.getUint32(ptr + 0x1c, true),
    cond_edge_count: dv.getUint32(ptr + 0x20, true),
    exit_block_count: dv.getUint32(ptr + 0x24, true),
  };
}

function writeMbaNodes(nodes) {
  const ptr = alloc.alloc(nodes.length * 24, 8);
  const dv = alloc.view();
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    const o = ptr + i * 24;
    dv.setUint32(o + 0x00, n.op >>> 0, true);
    dv.setUint32(o + 0x04, (n.lhs ?? 0) >>> 0, true);
    dv.setUint32(o + 0x08, (n.rhs ?? 0) >>> 0, true);
    dv.setUint32(o + 0x0c, (n.flags ?? 0) >>> 0, true);
    dv.setBigInt64(o + 0x10, BigInt(n.imm ?? 0), true);
  }
  return ptr;
}

function readMbaProof(ptr) {
  const dv = alloc.view();
  const coeff = [];
  for (let i = 0; i < 8; i++) {
    coeff.push(dv.getBigInt64(ptr + 0x20 + i * 8, true));
  }
  return {
    layer1_tt_ok: dv.getUint32(ptr + 0x00, true),
    layer2_basis_ok: dv.getUint32(ptr + 0x04, true),
    layer3_rand64_ok: dv.getUint32(ptr + 0x08, true),
    simplified_kind: dv.getUint32(ptr + 0x0c, true),
    committed: dv.getUint32(ptr + 0x10, true),
    orig_cost: dv.getUint32(ptr + 0x14, true),
    simp_cost: dv.getUint32(ptr + 0x18, true),
    out_node_count: dv.getUint32(ptr + 0x1c, true),
    coeff,
  };
}

// ============================================================================
// ARM64 Instruction Encoders
// ============================================================================
const NOP = 0xd503201f;
const RET = 0xd65f03c0;

const encMovz64 = (rd, imm16, hw = 0) =>
  (0xd2800000 | ((hw & 3) << 21) | ((imm16 & 0xffff) << 5) | (rd & 31)) >>> 0;
const encMovk64 = (rd, imm16, hw = 0) =>
  (0xf2800000 | ((hw & 3) << 21) | ((imm16 & 0xffff) << 5) | (rd & 31)) >>> 0;
const encAddImm64 = (rd, rn, imm12) =>
  (0x91000000 | ((imm12 & 0xfff) << 10) | ((rn & 31) << 5) | (rd & 31)) >>> 0;
const encSubImm64 = (rd, rn, imm12) =>
  (0xd1000000 | ((imm12 & 0xfff) << 10) | ((rn & 31) << 5) | (rd & 31)) >>> 0;
const encSubsImm64 = (rd, rn, imm12) =>
  (0xf1000000 | ((imm12 & 0xfff) << 10) | ((rn & 31) << 5) | (rd & 31)) >>> 0;
const encAndReg64 = (rd, rn, rm) =>
  (0x8a000000 | ((rm & 31) << 16) | ((rn & 31) << 5) | (rd & 31)) >>> 0;
const encOrrReg64 = (rd, rn, rm) =>
  (0xaa000000 | ((rm & 31) << 16) | ((rn & 31) << 5) | (rd & 31)) >>> 0;
const encEorReg64 = (rd, rn, rm) =>
  (0xca000000 | ((rm & 31) << 16) | ((rn & 31) << 5) | (rd & 31)) >>> 0;
const encMul64 = (rd, rn, rm) =>
  (0x9b007c00 | ((rm & 31) << 16) | ((rn & 31) << 5) | (rd & 31)) >>> 0;
const encAdrp = (rd, pageDelta) => {
  const u21 = pageDelta & 0x1fffff;
  return (0x90000000 | ((u21 & 3) << 29) | (((u21 >>> 2) & 0x7ffff) << 5) | (rd & 31)) >>> 0;
};
const encLdrLit64 = (rt, imm19Words) =>
  (0x58000000 | ((imm19Words & 0x7ffff) << 5) | (rt & 31)) >>> 0;
const encStr64Uoff = (rt, rn, imm12Scaled8) =>
  (0xf9000000 | ((imm12Scaled8 & 0xfff) << 10) | ((rn & 31) << 5) | (rt & 31)) >>> 0;
const encLdr64Uoff = (rt, rn, imm12Scaled8) =>
  (0xf9400000 | ((imm12Scaled8 & 0xfff) << 10) | ((rn & 31) << 5) | (rt & 31)) >>> 0;
const encB = (imm26Words) => (0x14000000 | (imm26Words & 0x03ffffff)) >>> 0;
const encBCond = (cond, imm19Words) =>
  (0x54000000 | ((imm19Words & 0x7ffff) << 5) | (cond & 0xf)) >>> 0;
const encCbz64 = (rt, imm19Words) =>
  (0xb4000000 | ((imm19Words & 0x7ffff) << 5) | (rt & 31)) >>> 0;
const encBr = (rn) => (0xd61f0000 | ((rn & 31) << 5)) >>> 0;

function writeCodeWords(words) {
  const ptr = alloc.alloc(words.length * 4, 8);
  const dv = alloc.view();
  for (let i = 0; i < words.length; i++) {
    dv.setUint32(ptr + i * 4, words[i] >>> 0, true);
  }
  return { ptr, len: words.length * 4 };
}

// ============================================================================
// Core & Regression Tests
// ============================================================================

test('1. Standalone Track 5 WASM module has 0 external imports and all expected exports', () => {
  const expected = [
    'hex_cff_unflatten',
    'hex_mba_eval',
    'hex_mba_verify_equiv',
    'hex_mba_simplify',
    'hex_arm64_emu_init',
    'hex_arm64_emu_step',
    'hex_arm64_emu_run',
    'hex_deobf_eval_opaque_branch',
    'hex_deobf_resolve_indirect_target',
  ];
  for (const name of expected) {
    assert.equal(typeof EXPORTS[name], 'function', `missing export ${name}`);
  }
});

test('2. CFF Unflatten detects OLLVM dispatcher and recovers original CFG edges', () => {
  alloc.reset();
  const blocks = [
    { block_id: 0, flags: CFF_BLK_ENTRY | CFF_BLK_UPDATES_STATE, state_var_id: 1, next_state_true: 0x1001n },
    { block_id: 1, flags: CFF_BLK_HAS_SWITCH, state_var_id: 1 },
    {
      block_id: 2,
      flags: CFF_BLK_UPDATES_STATE | CFF_BLK_COND_UPDATE,
      state_var_id: 1,
      cond_id: 77,
      has_match_state: 1,
      match_state: 0x1001n,
      next_state_true: 0x2002n,
      next_state_false: 0x3003n,
    },
    {
      block_id: 3,
      flags: CFF_BLK_UPDATES_STATE,
      state_var_id: 1,
      has_match_state: 1,
      match_state: 0x2002n,
      next_state_true: 0x4004n,
    },
    {
      block_id: 4,
      flags: CFF_BLK_UPDATES_STATE,
      state_var_id: 1,
      has_match_state: 1,
      match_state: 0x3003n,
      next_state_true: 0x4004n,
    },
    {
      block_id: 5,
      flags: CFF_BLK_HAS_EXIT,
      state_var_id: 1,
      has_match_state: 1,
      match_state: 0x4004n,
    },
    { block_id: 6, flags: 0, state_var_id: 0 },
  ];

  const inEdges = [
    { src: 0, dst: 1, kind: CFF_EDGE_UNCOND },
    { src: 1, dst: 2, kind: CFF_EDGE_SWITCH },
    { src: 1, dst: 3, kind: CFF_EDGE_SWITCH },
    { src: 1, dst: 4, kind: CFF_EDGE_SWITCH },
    { src: 1, dst: 5, kind: CFF_EDGE_SWITCH },
    { src: 2, dst: 6, kind: CFF_EDGE_UNCOND },
    { src: 3, dst: 6, kind: CFF_EDGE_UNCOND },
    { src: 4, dst: 6, kind: CFF_EDGE_UNCOND },
    { src: 6, dst: 1, kind: CFF_EDGE_BACKEDGE },
  ];

  const blkPtr = writeCffBlocks(blocks);
  const edgePtr = writeCffEdges(inEdges);
  const outEdgesPtr = alloc.alloc(32 * 16, 4);
  const resPtr = alloc.alloc(40, 4);

  const st = EXPORTS.hex_cff_unflatten(blkPtr, blocks.length, edgePtr, inEdges.length, outEdgesPtr, 32, resPtr);
  assert.equal(st, HEX_OK);

  const res = readCffResult(resPtr);
  assert.equal(res.status, CFF_STATUS_RECOVERED);
  assert.equal(res.dispatcher_block, 1);
  assert.equal(res.state_var_id, 1);
  assert.equal(res.real_block_count, 4);
  assert.equal(res.spine_block_count, 2);
  assert.equal(res.exit_block_count, 1);
  assert.equal(res.recovered_edge_count, 5);
  assert.equal(res.uncond_edge_count, 3);
  assert.equal(res.cond_edge_count, 2);

  const recovered = readCffEdges(outEdgesPtr, res.recovered_edge_count);
  assert.deepEqual(recovered, [
    { src: 0, dst: 2, kind: CFF_EDGE_UNCOND, cond_id: 0 },
    { src: 2, dst: 3, kind: CFF_EDGE_COND_TRUE, cond_id: 77 },
    { src: 2, dst: 4, kind: CFF_EDGE_COND_FALSE, cond_id: 77 },
    { src: 3, dst: 5, kind: CFF_EDGE_UNCOND, cond_id: 0 },
    { src: 4, dst: 5, kind: CFF_EDGE_UNCOND, cond_id: 0 },
  ]);
});

test('3. CFF Unflatten fail-closes on natural FSM, uninitialized entry, and duplicate block_id', () => {
  alloc.reset();
  // (a) Natural FSM guard
  const fsmBlocks = [
    { block_id: 0, flags: CFF_BLK_ENTRY | CFF_BLK_STATE_EXTERN, state_var_id: 1 },
    { block_id: 1, flags: CFF_BLK_HAS_SWITCH, state_var_id: 1 },
    { block_id: 2, flags: CFF_BLK_UPDATES_STATE, state_var_id: 1, has_match_state: 1, match_state: 1n, next_state_true: 2n },
    { block_id: 3, flags: CFF_BLK_UPDATES_STATE, state_var_id: 1, has_match_state: 1, match_state: 2n, next_state_true: 3n },
    { block_id: 4, flags: CFF_BLK_UPDATES_STATE, state_var_id: 1, has_match_state: 1, match_state: 3n, next_state_true: 4n },
    { block_id: 5, flags: CFF_BLK_HAS_EXIT, state_var_id: 1, has_match_state: 1, match_state: 4n },
  ];
  const fsmEdges = [
    { src: 0, dst: 1, kind: CFF_EDGE_UNCOND },
    { src: 1, dst: 2, kind: CFF_EDGE_SWITCH },
    { src: 1, dst: 3, kind: CFF_EDGE_SWITCH },
    { src: 1, dst: 4, kind: CFF_EDGE_SWITCH },
    { src: 1, dst: 5, kind: CFF_EDGE_SWITCH },
    { src: 2, dst: 1, kind: CFF_EDGE_BACKEDGE },
    { src: 3, dst: 1, kind: CFF_EDGE_BACKEDGE },
    { src: 4, dst: 1, kind: CFF_EDGE_BACKEDGE },
  ];
  const outEdgesPtr = alloc.alloc(16 * 16, 4);
  const resPtr = alloc.alloc(40, 4);
  assert.equal(
    EXPORTS.hex_cff_unflatten(writeCffBlocks(fsmBlocks), fsmBlocks.length, writeCffEdges(fsmEdges), fsmEdges.length, outEdgesPtr, 16, resPtr),
    HEX_OK
  );
  let res = readCffResult(resPtr);
  assert.equal(res.status, CFF_STATUS_ABORT_GUARD);
  assert.equal(res.guard_fail_reason, CFF_GUARD_NATURAL_FSM);

  // (b) Entry block does NOT initialize state_var -> must abort fail-closed
  const uninitEntryBlocks = fsmBlocks.map((b, i) =>
    i === 0 ? { block_id: 0, flags: CFF_BLK_ENTRY, state_var_id: 0 } : b
  );
  assert.equal(
    EXPORTS.hex_cff_unflatten(writeCffBlocks(uninitEntryBlocks), uninitEntryBlocks.length, writeCffEdges(fsmEdges), fsmEdges.length, outEdgesPtr, 16, resPtr),
    HEX_OK
  );
  res = readCffResult(resPtr);
  assert.equal(res.status, CFF_STATUS_ABORT_GUARD);
  assert.equal(res.guard_fail_reason, CFF_GUARD_UNRESOLVED_EDGE);
  assert.equal(res.recovered_edge_count, 0);

  // (c) Duplicate block_id -> HEX_ERR_INVALID_ARG
  const dupBlocks = [
    { block_id: 0, flags: CFF_BLK_ENTRY, state_var_id: 1 },
    { block_id: 0, flags: CFF_BLK_HAS_SWITCH, state_var_id: 1 },
  ];
  assert.equal(
    EXPORTS.hex_cff_unflatten(writeCffBlocks(dupBlocks), dupBlocks.length, writeCffEdges([]), 0, outEdgesPtr, 16, resPtr),
    HEX_ERR_INVALID_ARG
  );
});

test('4. MBA Simplifier reduces (x ^ y) + 2*(x & y) => x + y with 3-layer proof', () => {
  alloc.reset();
  const nodes = [
    { op: MBA_VAR, lhs: 0 },
    { op: MBA_VAR, lhs: 1 },
    { op: MBA_XOR, lhs: 0, rhs: 1 },
    { op: MBA_AND, lhs: 0, rhs: 1 },
    { op: MBA_MUL_CONST, lhs: 3, imm: 2n },
    { op: MBA_ADD, lhs: 2, rhs: 4 },
  ];
  const inPtr = writeMbaNodes(nodes);
  const outPtr = alloc.alloc(32 * 24, 8);
  const outRootPtr = alloc.alloc(4, 4);
  const proofPtr = alloc.alloc(96, 8);

  assert.equal(EXPORTS.hex_mba_simplify(inPtr, nodes.length, 5, outPtr, 32, outRootPtr, proofPtr), HEX_OK);
  const proof = readMbaProof(proofPtr);
  assert.equal(proof.layer1_tt_ok, 1);
  assert.equal(proof.layer2_basis_ok, 1);
  assert.equal(proof.layer3_rand64_ok, 1);
  assert.equal(proof.committed, 1);
  assert.equal(proof.simplified_kind, MBA_SIMP_LINEAR_VAR);
  assert.equal(proof.orig_cost, 6);
  assert.deepEqual(proof.coeff, [0n, 1n, 1n, 0n, 0n, 0n, 0n, 0n]);
  assert.ok(proof.simp_cost < proof.orig_cost);

  const outRoot = alloc.view().getUint32(outRootPtr, true);
  for (const [x, y] of [
    [0n, 0n],
    [13n, 29n],
    [0x123456789abcdef0n, 0xfedcba9876543210n],
    [0xffffffffffffffffn, 1n],
  ]) {
    const got = BigInt.asUintN(64, EXPORTS.hex_mba_eval(outPtr, proof.out_node_count, outRoot, x, y, 0n));
    assert.equal(got, BigInt.asUintN(64, x + y));
  }
});

test('5. MBA Simplifier reduces (x | y) - (x ^ y) => x & y and ~x + 1 => -x', () => {
  alloc.reset();
  const nodes1 = [
    { op: MBA_VAR, lhs: 0 },
    { op: MBA_VAR, lhs: 1 },
    { op: MBA_OR, lhs: 0, rhs: 1 },
    { op: MBA_XOR, lhs: 0, rhs: 1 },
    { op: MBA_SUB, lhs: 2, rhs: 3 },
  ];
  const inPtr1 = writeMbaNodes(nodes1);
  const outPtr1 = alloc.alloc(32 * 24, 8);
  const outRootPtr1 = alloc.alloc(4, 4);
  const proofPtr1 = alloc.alloc(96, 8);

  assert.equal(EXPORTS.hex_mba_simplify(inPtr1, nodes1.length, 4, outPtr1, 32, outRootPtr1, proofPtr1), HEX_OK);
  const p1 = readMbaProof(proofPtr1);
  assert.equal(p1.layer1_tt_ok, 1);
  assert.equal(p1.layer2_basis_ok, 1);
  assert.equal(p1.layer3_rand64_ok, 1);
  assert.equal(p1.committed, 1);
  assert.equal(p1.simplified_kind, MBA_SIMP_BITWISE_AND);
  const root1 = alloc.view().getUint32(outRootPtr1, true);
  assert.equal(
    BigInt.asUintN(64, EXPORTS.hex_mba_eval(outPtr1, p1.out_node_count, root1, 0xf0f0aa55n, 0x0ff055aan, 0n)),
    0x00f00000n
  );

  const nodes2 = [
    { op: MBA_VAR, lhs: 0 },
    { op: MBA_NOT, lhs: 0 },
    { op: MBA_CONST, imm: 1n },
    { op: MBA_ADD, lhs: 1, rhs: 2 },
  ];
  const inPtr2 = writeMbaNodes(nodes2);
  const outPtr2 = alloc.alloc(32 * 24, 8);
  const outRootPtr2 = alloc.alloc(4, 4);
  const proofPtr2 = alloc.alloc(96, 8);

  assert.equal(EXPORTS.hex_mba_simplify(inPtr2, nodes2.length, 3, outPtr2, 32, outRootPtr2, proofPtr2), HEX_OK);
  const p2 = readMbaProof(proofPtr2);
  assert.equal(p2.committed, 1);
  assert.equal(p2.simplified_kind, MBA_SIMP_NEG_VAR);
  const root2 = alloc.view().getUint32(outRootPtr2, true);
  assert.equal(
    BigInt.asUintN(64, EXPORTS.hex_mba_eval(outPtr2, p2.out_node_count, root2, 42n, 0n, 0n)),
    BigInt.asUintN(64, -42n)
  );
});

test('6. MBA 3-layer proof rejects non-linear, cyclic DAGs, and handles 32-stage shared DAG + INT64_MIN safely', () => {
  alloc.reset();
  const outPtr = alloc.alloc(32 * 24, 8);
  const outRootPtr = alloc.alloc(4, 4);
  const proofPtr = alloc.alloc(96, 8);

  // (a) Non-linear (x + 1) & y: passes Layer 1, fails Layer 2 & 3 -> committed=0
  const nonLinear = [
    { op: MBA_VAR, lhs: 0 },
    { op: MBA_CONST, imm: 1n },
    { op: MBA_ADD, lhs: 0, rhs: 1 },
    { op: MBA_VAR, lhs: 1 },
    { op: MBA_AND, lhs: 2, rhs: 3 },
  ];
  assert.equal(EXPORTS.hex_mba_simplify(writeMbaNodes(nonLinear), nonLinear.length, 4, outPtr, 32, outRootPtr, proofPtr), HEX_OK);
  const p = readMbaProof(proofPtr);
  assert.equal(p.layer1_tt_ok, 1);
  assert.equal(p.layer2_basis_ok, 0);
  assert.equal(p.layer3_rand64_ok, 0);
  assert.equal(p.committed, 0);

  // (b) Cyclic DAG rejected with HEX_ERR_INVALID_ARG in simplify & verify_equiv
  const cyclic = [
    { op: MBA_ADD, lhs: 1, rhs: 1 },
    { op: MBA_NEG, lhs: 0 },
  ];
  const cycPtr = writeMbaNodes(cyclic);
  assert.equal(EXPORTS.hex_mba_simplify(cycPtr, cyclic.length, 0, outPtr, 32, outRootPtr, proofPtr), HEX_ERR_INVALID_ARG);
  const validSimple = writeMbaNodes([{ op: MBA_VAR, lhs: 0 }]);
  assert.equal(EXPORTS.hex_mba_verify_equiv(cycPtr, 2, 0, validSimple, 1, 0, 1, proofPtr), HEX_ERR_INVALID_ARG);
  assert.equal(EXPORTS.hex_mba_verify_equiv(validSimple, 1, 0, cycPtr, 2, 0, 1, proofPtr), HEX_ERR_INVALID_ARG);

  // (c) 32-stage shared diamond DAG: n[0]=x, n[i]=n[i-1]+n[i-1] (i=1..32) => 2^32 * x
  // Without O(N) memoization this would take 2^32 calls and hang; with memoization it is instant!
  const diamond = [{ op: MBA_VAR, lhs: 0 }];
  for (let i = 1; i <= 32; i++) {
    diamond.push({ op: MBA_ADD, lhs: i - 1, rhs: i - 1 });
  }
  const diaPtr = writeMbaNodes(diamond);
  assert.equal(EXPORTS.hex_mba_simplify(diaPtr, diamond.length, 32, outPtr, 32, outRootPtr, proofPtr), HEX_OK);
  const dp = readMbaProof(proofPtr);
  assert.equal(dp.orig_cost, 33, 'orig_cost must be unique reachable node count (33)');
  assert.equal(dp.layer1_tt_ok, 1);
  assert.equal(dp.layer2_basis_ok, 1);
  assert.equal(dp.layer3_rand64_ok, 1);
  assert.equal(dp.committed, 1);
  assert.equal(dp.coeff[1], 1n << 32n);
  const dRoot = alloc.view().getUint32(outRootPtr, true);
  assert.equal(
    BigInt.asUintN(64, EXPORTS.hex_mba_eval(outPtr, dp.out_node_count, dRoot, 7n, 0n, 0n)),
    7n << 32n
  );

  // (d) INT64_MIN constant & coefficient without signed overflow UB:
  // ((x ^ y) + 2*(x & y)) + INT64_MIN  =>  x + y + INT64_MIN
  const INT64_MIN = -9223372036854775808n;
  const minExpr = [
    { op: MBA_VAR, lhs: 0 },
    { op: MBA_VAR, lhs: 1 },
    { op: MBA_XOR, lhs: 0, rhs: 1 },
    { op: MBA_AND, lhs: 0, rhs: 1 },
    { op: MBA_MUL_CONST, lhs: 3, imm: 2n },
    { op: MBA_ADD, lhs: 2, rhs: 4 },
    { op: MBA_CONST, imm: INT64_MIN },
    { op: MBA_ADD, lhs: 5, rhs: 6 },
  ];
  assert.equal(EXPORTS.hex_mba_simplify(writeMbaNodes(minExpr), minExpr.length, 7, outPtr, 32, outRootPtr, proofPtr), HEX_OK);
  const mp = readMbaProof(proofPtr);
  assert.equal(mp.layer1_tt_ok, 1);
  assert.equal(mp.layer2_basis_ok, 1);
  assert.equal(mp.layer3_rand64_ok, 1);
  assert.equal(mp.committed, 1);
  assert.equal(mp.coeff[0], INT64_MIN);
  const mRoot = alloc.view().getUint32(outRootPtr, true);
  assert.equal(
    BigInt.asUintN(64, EXPORTS.hex_mba_eval(outPtr, mp.out_node_count, mRoot, 10n, 20n, 0n)),
    BigInt.asUintN(64, 30n + 0x8000000000000000n)
  );
});

test('7. MiniArm64Emu executes core ARM64, enforces limits, and rejects FP/SIMD, PRFM, and malformed bitfield/shift/CSEL insns', () => {
  alloc.reset();
  const codeVa = 0x100004000n;
  const { ptr: codePtr, len: codeLen } = writeCodeWords([
    encMovz64(1, 0x1234, 0),
    encMovk64(1, 0x5678, 1),
    encSubImm64(31, 31, 16),
    encStr64Uoff(1, 31, 0),
    encLdr64Uoff(2, 31, 0),
    encLdrLit64(3, 7),
    encEorReg64(0, 2, 3),
    encSubsImm64(31, 0, 0),
    encBCond(1, 2),
    encMovz64(0, 0, 0),
    encAddImm64(31, 31, 16),
    RET,
    0x000000ff,
    0x00000000,
  ]);

  const statePtr = alloc.alloc(EMU_STATE_SIZE, 8);
  assert.equal(EXPORTS.hex_arm64_emu_init(statePtr, codeVa, codeVa, codeLen, 64), HEX_OK);
  assert.equal(EXPORTS.hex_arm64_emu_run(statePtr, codePtr, codeLen), HEX_OK);

  const dv = alloc.view();
  assert.equal(dv.getBigUint64(statePtr + 0, true), 0x567812cbn);
  assert.equal(dv.getUint32(statePtr + 0x114, true), EMU_FAULT_HALTED_RET);

  // Step-limit enforcement
  const { ptr: loopPtr, len: loopLen } = writeCodeWords([encB(0)]);
  assert.equal(EXPORTS.hex_arm64_emu_init(statePtr, codeVa, codeVa, loopLen, 10), HEX_OK);
  assert.equal(EXPORTS.hex_arm64_emu_run(statePtr, loopPtr, loopLen), HEX_ERR_RESOURCE_LIMIT);
  assert.equal(dv.getUint32(statePtr + 0x114, true), EMU_FAULT_STEP_LIMIT);

  // OOB memory store enforcement
  const { ptr: oobPtr, len: oobLen } = writeCodeWords([encMovz64(1, 0x1000, 0), encStr64Uoff(0, 1, 0), RET]);
  assert.equal(EXPORTS.hex_arm64_emu_init(statePtr, codeVa, codeVa, oobLen, 16), HEX_OK);
  assert.equal(EXPORTS.hex_arm64_emu_run(statePtr, oobPtr, oobLen), HEX_ERR_RESOURCE_LIMIT);
  assert.equal(dv.getUint32(statePtr + 0x114, true), EMU_FAULT_MEM_OOB);

  // Reject unsupported / malformed instructions cleanly
  const badInsns = [
    ['LDR D0, [sp, #0] (FP/SIMD V=1)', 0xfd4003e0],
    ['LDR Q0, literal (FP/SIMD V=1)', 0x9c000020],
    ['LDP D0, D1, [sp] (FP/SIMD V=1)', 0x6d4007e0],
    ['PRFM PLDL1KEEP, [sp] (size=3, opc=2)', 0xf98003e0],
    ['UBFM 32-bit with N=1', 0x53407c00],
    ['UBFM 32-bit with immr=32', 0x53200000],
    ['ADD W0, W1, W2, LSL #32 (imm6>=32)', 0x0b028020],
    ['CSEL with S=1 (bit 29 set)', 0xba820020],
    ['LDR reg-offset with invalid opt=0', 0xf8620820],
  ];
  for (const [label, word] of badInsns) {
    const { ptr: badPtr, len: badLen } = writeCodeWords([word, RET]);
    assert.equal(EXPORTS.hex_arm64_emu_init(statePtr, codeVa, codeVa, badLen, 8), HEX_OK);
    assert.equal(EXPORTS.hex_arm64_emu_step(statePtr, badPtr, badLen), HEX_ERR_UNSUPPORTED, label);
    assert.equal(dv.getUint32(statePtr + 0x114, true), EMU_FAULT_UNSUPPORTED_INSN, label);
  }
});

test('8. Deobf Eval tests x0..x7 dynamic branches, opaque predicates, and fail-closed uninitialized/step-capped BR', () => {
  alloc.reset();
  const codeVa = 0x100008000n;
  const dv = alloc.view();
  const opResPtr = alloc.alloc(48, 8);

  // (a) Opaque ALWAYS-TAKEN: ((x0*(x0+1)) & 1) == 0 -> CBZ always taken
  const { ptr: pAlways, len: lAlways } = writeCodeWords([
    encAddImm64(1, 0, 1),
    encMul64(2, 0, 1),
    encMovz64(3, 1, 0),
    encAndReg64(2, 2, 3),
    encCbz64(2, 2),
    NOP,
    RET,
  ]);
  assert.equal(
    EXPORTS.hex_deobf_eval_opaque_branch(pAlways, lAlways, codeVa, codeVa, codeVa + 0x10n, 32, opResPtr),
    HEX_OK
  );
  assert.equal(dv.getUint32(opResPtr + 0x00, true), OPAQUE_ALWAYS_TAKEN);
  assert.equal(dv.getBigUint64(opResPtr + 0x28, true), codeVa + 0x18n);

  // (b) Opaque NEVER-TAKEN: (x0 | 1) != 0 -> CBZ never taken
  const { ptr: pNever, len: lNever } = writeCodeWords([
    encMovz64(1, 1, 0),
    encOrrReg64(2, 0, 1),
    encCbz64(2, 2),
    NOP,
    RET,
  ]);
  assert.equal(
    EXPORTS.hex_deobf_eval_opaque_branch(pNever, lNever, codeVa, codeVa, codeVa + 0x08n, 32, opResPtr),
    HEX_OK
  );
  assert.equal(dv.getUint32(opResPtr + 0x00, true), OPAQUE_NEVER_TAKEN);
  assert.equal(dv.getBigUint64(opResPtr + 0x28, true), codeVa + 0x0cn);

  // (c) Dynamic branch depending on x5 (regression: x4..x7 must be seeded!) -> UNKNOWN
  const { ptr: pDynX5, len: lDynX5 } = writeCodeWords([
    encSubsImm64(31, 5, 5), // CMP x5, #5
    encBCond(0, 2),         // B.EQ +8
    NOP,
    RET,
  ]);
  assert.equal(
    EXPORTS.hex_deobf_eval_opaque_branch(pDynX5, lDynX5, codeVa, codeVa, codeVa + 0x04n, 32, opResPtr),
    HEX_OK
  );
  assert.equal(dv.getUint32(opResPtr + 0x00, true), OPAQUE_UNKNOWN);
  assert.equal(dv.getBigUint64(opResPtr + 0x28, true), 0n);

  // (d) Valid indirect branch resolution: ADRP + ADD + BR x8
  const { ptr: pInd, len: lInd } = writeCodeWords([
    encAdrp(8, 2),
    encAddImm64(8, 8, 0x140),
    encBr(8),
  ]);
  const indResPtr = alloc.alloc(32, 8);
  assert.equal(
    EXPORTS.hex_deobf_resolve_indirect_target(pInd, lInd, codeVa, codeVa, 0n, 32, indResPtr),
    HEX_OK
  );
  assert.equal(dv.getUint32(indResPtr + 0x00, true), 1);
  assert.equal(dv.getBigUint64(indResPtr + 0x18, true), 0x10000a140n);

  // (e) Step-limit enforced before BR (2 instructions before BR, step_limit=2 -> STEP_LIMIT)
  assert.equal(
    EXPORTS.hex_deobf_resolve_indirect_target(pInd, lInd, codeVa, codeVa, 0n, 2, indResPtr),
    HEX_OK
  );
  assert.equal(dv.getUint32(indResPtr + 0x00, true), 0);
  assert.equal(dv.getUint32(indResPtr + 0x04, true), EMU_FAULT_STEP_LIMIT);

  // (f) Uninitialized BR x9 (never written) -> fail-closed resolved=0
  const { ptr: pUninitBr, len: lUninitBr } = writeCodeWords([NOP, encBr(9)]);
  assert.equal(
    EXPORTS.hex_deobf_resolve_indirect_target(pUninitBr, lUninitBr, codeVa, codeVa, 0x1234n, 16, indResPtr),
    HEX_OK
  );
  assert.equal(dv.getUint32(indResPtr + 0x00, true), 0);
  assert.equal(dv.getBigUint64(indResPtr + 0x18, true), 0n);
});
