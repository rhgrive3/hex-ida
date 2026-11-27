import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');

// Constants mirroring cpp/include/hex_region_decomp.hpp
const HEX_OK = 0;
const HEX_ERR_INVALID_ARG = 1;
const HEX_ERR_RESOURCE_LIMIT = 3;

const HEX_IR_FLAG_STACK_WEB = 0x0100;
const HEX_IR_FLAG_ASM_ISLAND = 0x0200;

const HEX_TYPED_EMIT_FLAG_JS_PARITY = 1 << 0;
const HEX_TYPED_EMIT_FLAG_TYPED_C11 = 1 << 1;
const HEX_TYPED_EMIT_FLAG_TYPED_UI = 1 << 2;

const HEX_REGION_FLAG_NODE_CAPPED = 1 << 0;
const HEX_REGION_FLAG_EDGE_CAPPED = 1 << 1;
const HEX_REGION_FLAG_HAS_EXIT_BOUNDARY = 1 << 2;
const HEX_REGION_FLAG_HAS_ENTRY_BOUNDARY = 1 << 3;
const HEX_REGION_FLAG_SESE = 1 << 4;
const HEX_REGION_FLAG_LINEAR_FALLBACK = 1 << 5;
const HEX_REGION_FLAG_HAS_BACKEDGE = 1 << 6;

const HEX_STACK_ACCESS_LOAD = 0;
const HEX_STACK_ACCESS_STORE = 1;
const HEX_STACK_ACCESS_ADDR_OF = 2;

const HEX_STACK_WEB_FLAG_ESCAPED = 1 << 0;
const HEX_STACK_WEB_FLAG_MERGED_OVERLAP = 1 << 1;
const HEX_STACK_WEB_FLAG_WIDTH_MISMATCH = 1 << 2;
const HEX_STACK_WEB_FLAG_MULTI_DEF = 1 << 3;
const HEX_STACK_WEB_FLAG_CROSS_BLOCK = 1 << 4;
const HEX_STACK_WEB_FLAG_PARTIAL_OVERLAP = 1 << 5;

const HEX_ASM_ISLAND_NONE = 0;
const HEX_ASM_ISLAND_UNKNOWN = 1;
const HEX_ASM_ISLAND_SYS = 2;
const HEX_ASM_ISLAND_SVC = 3;
const HEX_ASM_ISLAND_CRYPTO_AES = 4;
const HEX_ASM_ISLAND_CRYPTO_SHA = 5;
const HEX_ASM_ISLAND_SVE = 6;
const HEX_ASM_ISLAND_PAC = 7;

const HEX_ASM_FLAG_CLOBBERS_MEM = 1 << 0;
const HEX_ASM_FLAG_CLOBBERS_FLAGS = 1 << 1;
const HEX_ASM_FLAG_MAY_TRAP = 1 << 2;
const HEX_ASM_FLAG_SIMD_VEC = 1 << 3;
const HEX_ASM_FLAG_SIDE_EFFECT = 1 << 4;

const HEX_EMIT_TOK_TEXT = 0;
const HEX_EMIT_TOK_CAST = 1;
const HEX_EMIT_TOK_MEMBER_ARROW = 2;
const HEX_EMIT_TOK_MEMBER_DOT = 3;
const HEX_EMIT_TOK_SHIFTED_PTR = 4;
const HEX_EMIT_TOK_ASM_ISLAND = 5;
const HEX_EMIT_TOK_STACK_LOCAL = 6;

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hex-track04-'));
const wasmPath = path.join(tmpDir, 'track04.wasm');

const sources = [
  'cpp/src/decompiler/region_decomp.cpp',
  'cpp/src/decompiler/stack_web.cpp',
  'cpp/src/decompiler/asm_island.cpp',
  'cpp/src/decompiler/typed_emit_ctx.cpp',
];

const clangArgs = [
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
  '-Icpp/include',
  '-Wl,--no-entry',
  '-Wl,--initial-memory=2097152',
  '-Wl,--max-memory=8388608',
  '-o',
  wasmPath,
  ...sources,
];

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log(`PASS: ${name}`);
}

try {
  execFileSync('clang++', clangArgs, { cwd: REPO_ROOT, stdio: 'inherit' });
  const wasmBytes = fs.readFileSync(wasmPath);
  const wasmModule = new WebAssembly.Module(wasmBytes);

  const imports = WebAssembly.Module.imports(wasmModule);
  assert.equal(
    imports.length,
    0,
    `Expected 0 external WASM imports, got: ${JSON.stringify(imports)}`
  );
  console.log(`PASS: Standalone wasm32 build succeeded (${wasmBytes.length} bytes, 0 external imports)`);
  passed++;

  const instance = new WebAssembly.Instance(wasmModule, {});
  const ex = instance.exports;
  const mem = ex.memory;

  assert.equal(typeof ex.hex_region_extract, 'function');
  assert.equal(typeof ex.hex_stack_web_split, 'function');
  assert.equal(typeof ex.hex_asm_island_classify, 'function');
  assert.equal(typeof ex.hex_asm_island_register, 'function');
  assert.equal(typeof ex.hex_typed_emit_format, 'function');

  let heapCursor = 1024 * 1024;
  function alloc(bytes, align = 8) {
    heapCursor = (heapCursor + (align - 1)) & ~(align - 1);
    const ptr = heapCursor;
    heapCursor += bytes;
    assert(heapCursor <= mem.buffer.byteLength, 'Test arena overflow');
    new Uint8Array(mem.buffer, ptr, bytes).fill(0);
    return ptr;
  }

  function dv() {
    return new DataView(mem.buffer);
  }

  // ==========================================================================
  // Test Suite 1: Region-Scoped Decompilation Slicing (hex_region_extract)
  // ==========================================================================
  test('hex_region_extract: dominator-bounded SESE diamond extraction', () => {
    const nodes = [
      { va: 0x1000n, insns: 4 },
      { va: 0x1010n, insns: 4 },
      { va: 0x1020n, insns: 6 },
      { va: 0x1030n, insns: 5 },
      { va: 0x1040n, insns: 3 },
      { va: 0x1050n, insns: 2 },
    ];
    const edges = [
      [0, 1], [0, 5], [1, 2], [1, 3], [2, 4], [3, 4], [4, 5],
    ];

    const nodesPtr = alloc(nodes.length * 16);
    const edgesPtr = alloc(edges.length * 8);
    const slicePtr = alloc(24);
    const outIdsPtr = alloc(16 * 4);
    const summaryPtr = alloc(32);

    const view = dv();
    nodes.forEach((n, i) => {
      const off = nodesPtr + i * 16;
      view.setBigUint64(off + 0, n.va, true);
      view.setUint32(off + 8, n.insns, true);
      view.setUint32(off + 12, 0, true);
    });
    edges.forEach(([u, v], i) => {
      const off = edgesPtr + i * 8;
      view.setUint32(off + 0, u, true);
      view.setUint32(off + 4, v, true);
    });

    const st = ex.hex_region_extract(
      nodesPtr, nodes.length,
      edgesPtr, edges.length,
      0x1010n, 64, 64,
      slicePtr, outIdsPtr, 16, summaryPtr
    );
    assert.equal(st, HEX_OK);

    assert.equal(view.getBigUint64(slicePtr + 0, true), 0x1010n);
    assert.equal(view.getUint32(slicePtr + 8, true), 4);
    assert.equal(view.getUint32(slicePtr + 12, true), 4);
    const bflags = view.getUint32(slicePtr + 16, true);
    assert.ok((bflags & HEX_REGION_FLAG_SESE) !== 0);
    assert.ok((bflags & HEX_REGION_FLAG_HAS_ENTRY_BOUNDARY) !== 0);
    assert.ok((bflags & HEX_REGION_FLAG_HAS_EXIT_BOUNDARY) !== 0);
    assert.equal(view.getUint32(summaryPtr + 4, true), 5);
    assert.equal(view.getBigUint64(summaryPtr + 24, true), 0x1050n);
  });

  test('hex_region_extract: hard node/edge cap, backedge under edge cap, high-VA overflow guard, and out_node_ids_cap enforcement', () => {
    const N = 6;
    const nodesPtr = alloc(N * 16);
    const edges = [
      [0, 1], [1, 2], [2, 1], [2, 3], [3, 4], [4, 5],
    ];
    const edgesPtr = alloc(edges.length * 8);
    const slicePtr = alloc(24);
    const outIdsPtr = alloc(2 * 4);
    const summaryPtr = alloc(32);

    const view = dv();
    // High 64-bit VAs near UINT64_MAX to verify overflow-safe containment
    const baseVa = 0xffffffffffffff00n;
    for (let i = 0; i < N; i++) {
      view.setBigUint64(nodesPtr + i * 16, baseVa + BigInt(i * 0x10), true);
      view.setUint32(nodesPtr + i * 16 + 8, 4, true);
    }
    edges.forEach(([u, v], i) => {
      view.setUint32(edgesPtr + i * 8, u, true);
      view.setUint32(edgesPtr + i * 8 + 4, v, true);
    });

    // Edge cap = 1 (allows 1->2, caps backedge 2->1) -> BACKEDGE flag must still be set!
    // Also out_node_ids_cap = 2 with max_nodes = 10 -> caps slice_nodes to 2 (no silent truncation)
    const st = ex.hex_region_extract(
      nodesPtr, N, edgesPtr, edges.length,
      baseVa + 0x18n, 10, 1,
      slicePtr, outIdsPtr, 2, summaryPtr
    );
    assert.equal(st, HEX_OK);
    assert.equal(view.getBigUint64(slicePtr + 0, true), baseVa + 0x10n);
    assert.equal(view.getUint32(slicePtr + 8, true), 2);
    const flags = view.getUint32(slicePtr + 16, true);
    assert.ok((flags & HEX_REGION_FLAG_EDGE_CAPPED) !== 0);
    assert.ok((flags & HEX_REGION_FLAG_HAS_BACKEDGE) !== 0, 'Backedge must be detected even when edge cap is hit');
    assert.equal(view.getUint32(outIdsPtr + 0, true), 1);
    assert.equal(view.getUint32(outIdsPtr + 4, true), 2);

    // Non-null out_node_ids with cap 0 rejected
    const badCap = ex.hex_region_extract(
      nodesPtr, N, edgesPtr, edges.length,
      baseVa + 0x10n, 3, 16, slicePtr, outIdsPtr, 0, 0
    );
    assert.equal(badCap, HEX_ERR_INVALID_ARG);
  });

  // ==========================================================================
  // Test Suite 2: Stack-Slot Lifetime Splitting (hex_stack_web_split)
  // ==========================================================================
  function runStackSplit(accesses) {
    const accPtr = alloc(Math.max(1, accesses.length) * 24);
    const outWebsPtr = alloc(64 * 32);
    const outCountPtr = alloc(4);
    const outMapPtr = alloc(Math.max(1, accesses.length) * 4);
    const view = dv();

    accesses.forEach((a, i) => {
      const off = accPtr + i * 24;
      view.setUint32(off + 0, a.inst_idx, true);
      view.setInt32(off + 4, a.stack_offset, true);
      view.setUint16(off + 8, a.kind, true);
      view.setUint16(off + 10, a.width_bytes ?? 4, true);
      view.setUint32(off + 12, a.type_id ?? 0, true);
      view.setUint32(off + 16, a.block_id ?? 0, true);
      view.setUint32(off + 20, a.flags ?? 0, true);
    });

    const st = ex.hex_stack_web_split(
      accPtr, accesses.length, outWebsPtr, 64, outCountPtr, outMapPtr
    );
    assert.equal(st, HEX_OK);
    const count = view.getUint32(outCountPtr, true);
    const webs = [];
    for (let i = 0; i < count; i++) {
      const off = outWebsPtr + i * 32;
      webs.push({
        stack_offset: view.getInt32(off + 0, true),
        web_id: view.getUint32(off + 4, true),
        def_idx: view.getUint32(off + 8, true),
        first_use_idx: view.getUint32(off + 12, true),
        last_use_idx: view.getUint32(off + 16, true),
        width_bytes: view.getUint16(off + 20, true),
        flags: view.getUint16(off + 22, true),
        type_id: view.getUint32(off + 24, true),
      });
    }
    const map = [];
    for (let i = 0; i < accesses.length; i++) {
      map.push(view.getUint32(outMapPtr + i * 4, true));
    }
    return { webs, map };
  }

  test('hex_stack_web_split: single-block disjoint live ranges split into distinct typed locals', () => {
    const { webs, map } = runStackSplit([
      { inst_idx: 1, stack_offset: 0x10, kind: HEX_STACK_ACCESS_STORE, width_bytes: 4, type_id: 1, block_id: 0 },
      { inst_idx: 2, stack_offset: 0x10, kind: HEX_STACK_ACCESS_LOAD, width_bytes: 4, type_id: 1, block_id: 0 },
      { inst_idx: 4, stack_offset: 0x10, kind: HEX_STACK_ACCESS_LOAD, width_bytes: 4, type_id: 1, block_id: 0 },
      { inst_idx: 10, stack_offset: 0x10, kind: HEX_STACK_ACCESS_STORE, width_bytes: 4, type_id: 5, block_id: 0 },
      { inst_idx: 12, stack_offset: 0x10, kind: HEX_STACK_ACCESS_LOAD, width_bytes: 4, type_id: 5, block_id: 0 },
    ]);

    assert.equal(webs.length, 2);
    assert.equal(webs[0].web_id, 0);
    assert.equal(webs[0].type_id, 1);
    assert.equal(webs[1].web_id, 1);
    assert.equal(webs[1].type_id, 5);
    assert.deepEqual(map, [0, 0, 0, 1, 1]);
  });

  test('hex_stack_web_split: diamond CFG WITH local LOAD in branch fails closed into 1 web', () => {
    const { webs, map } = runStackSplit([
      // Branch 1: STORE + local LOAD
      { inst_idx: 1, stack_offset: 0x18, kind: HEX_STACK_ACCESS_STORE, width_bytes: 4, type_id: 1, block_id: 1 },
      { inst_idx: 2, stack_offset: 0x18, kind: HEX_STACK_ACCESS_LOAD, width_bytes: 4, type_id: 1, block_id: 1 },
      // Branch 2: STORE
      { inst_idx: 5, stack_offset: 0x18, kind: HEX_STACK_ACCESS_STORE, width_bytes: 4, type_id: 1, block_id: 2 },
      // Merge block 3: LOAD
      { inst_idx: 9, stack_offset: 0x18, kind: HEX_STACK_ACCESS_LOAD, width_bytes: 4, type_id: 1, block_id: 3 },
    ]);

    assert.equal(webs.length, 1);
    assert.ok((webs[0].flags & HEX_STACK_WEB_FLAG_MERGED_OVERLAP) !== 0);
    assert.ok((webs[0].flags & HEX_STACK_WEB_FLAG_CROSS_BLOCK) !== 0);
    assert.ok((webs[0].flags & HEX_STACK_WEB_FLAG_MULTI_DEF) !== 0);
    assert.deepEqual(map, [0, 0, 0, 0]);
  });

  test('hex_stack_web_split: multi-block loop fails closed into 1 web', () => {
    const { webs, map } = runStackSplit([
      // Preheader block 0: init store
      { inst_idx: 1, stack_offset: 0x20, kind: HEX_STACK_ACCESS_STORE, width_bytes: 8, type_id: 4, block_id: 0 },
      // Loop body block 1: load + store
      { inst_idx: 5, stack_offset: 0x20, kind: HEX_STACK_ACCESS_LOAD, width_bytes: 8, type_id: 4, block_id: 1 },
      { inst_idx: 6, stack_offset: 0x20, kind: HEX_STACK_ACCESS_STORE, width_bytes: 8, type_id: 4, block_id: 1 },
    ]);

    assert.equal(webs.length, 1);
    assert.ok((webs[0].flags & HEX_STACK_WEB_FLAG_CROSS_BLOCK) !== 0);
    assert.deepEqual(map, [0, 0, 0]);
  });

  test('hex_stack_web_split: partial byte-range overlap across adjacent offsets merges and propagates ADDR_OF escape', () => {
    const { webs, map } = runStackSplit([
      // 8-byte slot [0x10, 0x18) with ADDR_OF escape
      { inst_idx: 1, stack_offset: 0x10, kind: HEX_STACK_ACCESS_STORE, width_bytes: 8, type_id: 4, block_id: 0 },
      { inst_idx: 2, stack_offset: 0x10, kind: HEX_STACK_ACCESS_ADDR_OF, width_bytes: 8, type_id: 4, block_id: 0 },
      // Overlapping 4-byte slot [0x14, 0x18) with two disjoint-looking accesses
      { inst_idx: 5, stack_offset: 0x14, kind: HEX_STACK_ACCESS_STORE, width_bytes: 4, type_id: 1, block_id: 0 },
      { inst_idx: 6, stack_offset: 0x14, kind: HEX_STACK_ACCESS_LOAD, width_bytes: 4, type_id: 1, block_id: 0 },
      { inst_idx: 10, stack_offset: 0x14, kind: HEX_STACK_ACCESS_STORE, width_bytes: 4, type_id: 5, block_id: 0 },
      { inst_idx: 11, stack_offset: 0x14, kind: HEX_STACK_ACCESS_LOAD, width_bytes: 4, type_id: 5, block_id: 0 },
      // Non-overlapping adjacent slot [0x18, 0x1C) stays independent & splittable
      { inst_idx: 1, stack_offset: 0x18, kind: HEX_STACK_ACCESS_STORE, width_bytes: 4, type_id: 1, block_id: 0 },
      { inst_idx: 2, stack_offset: 0x18, kind: HEX_STACK_ACCESS_LOAD, width_bytes: 4, type_id: 1, block_id: 0 },
      { inst_idx: 8, stack_offset: 0x18, kind: HEX_STACK_ACCESS_STORE, width_bytes: 4, type_id: 5, block_id: 0 },
      { inst_idx: 9, stack_offset: 0x18, kind: HEX_STACK_ACCESS_LOAD, width_bytes: 4, type_id: 5, block_id: 0 },
    ]);

    assert.equal(webs.length, 3);
    // Web 0: merged [0x10, 0x18) with PARTIAL_OVERLAP + ESCAPED propagated
    assert.equal(webs[0].stack_offset, 0x10);
    assert.equal(webs[0].width_bytes, 8);
    assert.ok((webs[0].flags & HEX_STACK_WEB_FLAG_PARTIAL_OVERLAP) !== 0);
    assert.ok((webs[0].flags & HEX_STACK_WEB_FLAG_ESCAPED) !== 0);
    // Web 1 & 2: non-overlapping 0x18 cleanly split
    assert.equal(webs[1].stack_offset, 0x18);
    assert.equal(webs[1].web_id, 0);
    assert.equal(webs[2].stack_offset, 0x18);
    assert.equal(webs[2].web_id, 1);
    assert.deepEqual(map, [0, 0, 0, 0, 0, 0, 1, 1, 2, 2]);
  });

  test('hex_stack_web_split: width mismatch fails closed into single pinned web', () => {
    const { webs } = runStackSplit([
      { inst_idx: 1, stack_offset: 0x30, kind: HEX_STACK_ACCESS_STORE, width_bytes: 4, type_id: 1, block_id: 0 },
      { inst_idx: 5, stack_offset: 0x30, kind: HEX_STACK_ACCESS_STORE, width_bytes: 8, type_id: 4, block_id: 0 },
    ]);
    assert.equal(webs.length, 1);
    assert.ok((webs[0].flags & HEX_STACK_WEB_FLAG_WIDTH_MISMATCH) !== 0);
  });

  // ==========================================================================
  // Test Suite 3: ASM Island Preservation (hex_asm_island_classify/register)
  // ==========================================================================
  test('hex_asm_island_classify: AES/SHA512/SHA3/SVE RDVL+indexed/PAC XPACI+BLRAA+RETAA/SVC+HVC/MSR NZCV vs normal ALU', () => {
    const entryPtr = alloc(32);
    const view = dv();

    const readEntry = () => ({
      insn_va: view.getBigUint64(entryPtr + 0, true),
      raw_word: view.getUint32(entryPtr + 8, true),
      kind: view.getUint32(entryPtr + 12, true),
      reg_read_mask: view.getUint32(entryPtr + 16, true) >>> 0,
      reg_write_mask: view.getUint32(entryPtr + 20, true) >>> 0,
      flags: view.getUint32(entryPtr + 24, true) >>> 0,
    });

    // AESE v0.16b, v1.16b (0x4E284820)
    assert.equal(ex.hex_asm_island_classify(0x400100n, 0x4e284820, entryPtr), HEX_ASM_ISLAND_CRYPTO_AES);

    // SHA512H (0xCE608000), SHA512SU0 (0xCEC08000), EOR3 (0xCE000000), BCAX (0xCE200000), XAR (0xCE800000)
    assert.equal(ex.hex_asm_island_classify(0x400104n, 0xce608000, entryPtr), HEX_ASM_ISLAND_CRYPTO_SHA);
    assert.equal(ex.hex_asm_island_classify(0x400108n, 0xcec08000, entryPtr), HEX_ASM_ISLAND_CRYPTO_SHA);
    assert.equal(ex.hex_asm_island_classify(0x40010cn, 0xce000000, entryPtr), HEX_ASM_ISLAND_CRYPTO_SHA);
    assert.equal(ex.hex_asm_island_classify(0x400110n, 0xce200000, entryPtr), HEX_ASM_ISLAND_CRYPTO_SHA);
    assert.equal(ex.hex_asm_island_classify(0x400114n, 0xce800000, entryPtr), HEX_ASM_ISLAND_CRYPTO_SHA);
    // Invalid SHA 2-reg opcode=3 (0x5E283800) must NOT match SHA
    assert.equal(ex.hex_asm_island_classify(0x400118n, 0x5e283800, entryPtr), HEX_ASM_ISLAND_NONE);

    // SVE RDVL x4, #1 (0x04BF5024) -> writes x4
    assert.equal(ex.hex_asm_island_classify(0x40011cn, 0x04bf5024, entryPtr), HEX_ASM_ISLAND_SVE);
    let e = readEntry();
    assert.equal(e.reg_read_mask, 0);
    assert.equal(e.reg_write_mask, 1 << 4);

    // SVE CNTB x5 (0x0420E3E5) -> writes x5
    assert.equal(ex.hex_asm_island_classify(0x400120n, 0x0420e3e5, entryPtr), HEX_ASM_ISLAND_SVE);
    e = readEntry();
    assert.equal(e.reg_write_mask, 1 << 5);

    // SVE indexed load LD1W {z0.s}, p0/z, [x1, x2, lsl #2] (0xA5424020) -> reads x1 | x2, clobbers mem
    assert.equal(ex.hex_asm_island_classify(0x400124n, 0xa5424020, entryPtr), HEX_ASM_ISLAND_SVE);
    e = readEntry();
    assert.equal(e.reg_read_mask, (1 << 1) | (1 << 2));
    assert.ok((e.flags & HEX_ASM_FLAG_CLOBBERS_MEM) !== 0);

    // PAC XPACI x3 (0xDAC143E3) -> reads ONLY x3 (NOT SP!), writes x3
    assert.equal(ex.hex_asm_island_classify(0x400128n, 0xdac143e3, entryPtr), HEX_ASM_ISLAND_PAC);
    e = readEntry();
    assert.equal(e.reg_read_mask, 1 << 3);
    assert.equal(e.reg_write_mask, 1 << 3);

    // PAC PACIA1716 (0xD503211F) -> reads x17|x16, writes x17
    assert.equal(ex.hex_asm_island_classify(0x40012cn, 0xd503211f, entryPtr), HEX_ASM_ISLAND_PAC);
    e = readEntry();
    assert.equal(e.reg_read_mask, (1 << 17) | (1 << 16));
    assert.equal(e.reg_write_mask, 1 << 17);

    // PAC BLRAA x2, x3 (0xD73F0843) -> reads x2|x3, writes x30
    assert.equal(ex.hex_asm_island_classify(0x400130n, 0xd73f0843, entryPtr), HEX_ASM_ISLAND_PAC);
    e = readEntry();
    assert.equal(e.reg_read_mask, (1 << 2) | (1 << 3));
    assert.equal(e.reg_write_mask, (1 << 30) >>> 0);

    // PAC RETAA (0xD65F0BFF) -> reads x30|SP
    assert.equal(ex.hex_asm_island_classify(0x400134n, 0xd65f0bff, entryPtr), HEX_ASM_ISLAND_PAC);
    e = readEntry();
    assert.equal(e.reg_read_mask, ((1 << 30) | (1 << 31)) >>> 0);

    // SVC #0x80 (0xD4001001) -> CLOBBERS_FLAGS + CLOBBERS_MEM + MAY_TRAP, writes x0..x1
    assert.equal(ex.hex_asm_island_classify(0x400138n, 0xd4001001, entryPtr), HEX_ASM_ISLAND_SVC);
    e = readEntry();
    assert.equal(e.reg_write_mask, 0x3);
    assert.ok((e.flags & HEX_ASM_FLAG_CLOBBERS_FLAGS) !== 0);
    assert.ok((e.flags & HEX_ASM_FLAG_MAY_TRAP) !== 0);

    // HVC #0 (0xD4000002) & SMC #0 (0xD4000003) -> writes x0..x3 (0xF), CLOBBERS_FLAGS
    assert.equal(ex.hex_asm_island_classify(0x40013cn, 0xd4000002, entryPtr), HEX_ASM_ISLAND_SVC);
    e = readEntry();
    assert.equal(e.reg_write_mask, 0xf);
    assert.ok((e.flags & HEX_ASM_FLAG_CLOBBERS_FLAGS) !== 0);
    assert.equal(ex.hex_asm_island_classify(0x400140n, 0xd4000003, entryPtr), HEX_ASM_ISLAND_SVC);
    e = readEntry();
    assert.equal(e.reg_write_mask, 0xf);

    // MSR NZCV, x2 (0xD51B4202) -> reads x2, sets CLOBBERS_FLAGS
    assert.equal(ex.hex_asm_island_classify(0x400144n, 0xd51b4202, entryPtr), HEX_ASM_ISLAND_SYS);
    e = readEntry();
    assert.equal(e.reg_read_mask, 1 << 2);
    assert.ok((e.flags & HEX_ASM_FLAG_CLOBBERS_FLAGS) !== 0);

    // Normal ALU & NOP -> NONE
    assert.equal(ex.hex_asm_island_classify(0x400148n, 0x8b020020, entryPtr), HEX_ASM_ISLAND_NONE);
    assert.equal(ex.hex_asm_island_classify(0x40014cn, 0xd503201f, entryPtr), HEX_ASM_ISLAND_NONE);
  });

  test('hex_asm_island_register: uses upper-byte HEX_IR_FLAG_ASM_ISLAND (0x0200) without colliding with lower 8-bit flags', () => {
    const tablePtr = alloc(2 * 32);
    const countPtr = alloc(4);
    const outIdxPtr = alloc(4);
    const flagsPtr = alloc(2);
    const view = dv();

    // Seed with lower-byte flag 0x40 (CEMIT_IR_FLAG_SIGNED) + HEX_IR_FLAG_STACK_WEB (0x0100)
    view.setUint16(flagsPtr, 0x0040 | HEX_IR_FLAG_STACK_WEB, true);
    let st = ex.hex_asm_island_register(tablePtr, 2, countPtr, 0x5004n, 0xd53bd040, outIdxPtr, flagsPtr);
    assert.equal(st, HEX_OK);
    assert.equal(view.getUint32(countPtr, true), 1);
    assert.equal(view.getUint16(flagsPtr, true), 0x0040 | HEX_IR_FLAG_STACK_WEB | HEX_IR_FLAG_ASM_ISLAND);
  });

  // ==========================================================================
  // Test Suite 4: Deterministic Typed Emit Context (hex_typed_emit_format)
  // ==========================================================================
  test('hex_typed_emit_format: JS_PARITY priority, __asm__ string escaping, empty arrow/dot rejection, and overflow protection', () => {
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();

    let poolStr = '';
    function intern(s) {
      const off = Buffer.byteLength(poolStr, 'utf8');
      poolStr += s;
      return { off, len: Buffer.byteLength(s, 'utf8') };
    }

    const sInt32 = intern('int32_t');
    const sX0 = intern('x0');
    const sCtx = intern('ctx');
    const sState = intern('state');
    const sObj = intern('obj');
    const sSubObj = intern('SubObj');
    const sAsmSpecial = intern('mrs x0, "sys"\\1\n;');
    const sSep = intern(' | ');

    const ops = [
      { kind: HEX_EMIT_TOK_CAST, type_id: 1, name: sInt32, field: sX0, imm: 0n, aux: 0, flags: 0, va: 0x401000n },
      { kind: HEX_EMIT_TOK_TEXT, type_id: 0, name: sSep, field: { off: 0, len: 0 }, imm: 0n, aux: 0, flags: 0, va: 0x401000n },
      { kind: HEX_EMIT_TOK_MEMBER_ARROW, type_id: 2, name: sCtx, field: sState, imm: 0n, aux: 0, flags: 0, va: 0x401004n },
      { kind: HEX_EMIT_TOK_TEXT, type_id: 0, name: sSep, field: { off: 0, len: 0 }, imm: 0n, aux: 0, flags: 0, va: 0x401004n },
      { kind: HEX_EMIT_TOK_SHIFTED_PTR, type_id: 7, name: sObj, field: sSubObj, imm: 0x18n, aux: 0, flags: 0, va: 0x401008n },
      { kind: HEX_EMIT_TOK_TEXT, type_id: 0, name: sSep, field: { off: 0, len: 0 }, imm: 0n, aux: 0, flags: 0, va: 0x401008n },
      // JS_PARITY + TYPED_C11 both set -> JS_PARITY MUST win (emits __asm__ volatile with escaping, NOT __hex_asm_island)
      {
        kind: HEX_EMIT_TOK_ASM_ISLAND,
        type_id: 0,
        name: sAsmSpecial,
        field: { off: 0, len: 0 },
        imm: 0xd53bd040n,
        aux: HEX_ASM_ISLAND_SYS,
        flags: HEX_TYPED_EMIT_FLAG_JS_PARITY | HEX_TYPED_EMIT_FLAG_TYPED_C11,
        va: 0x40100cn,
      },
      { kind: HEX_EMIT_TOK_TEXT, type_id: 0, name: sSep, field: { off: 0, len: 0 }, imm: 0n, aux: 0, flags: 0, va: 0x40100cn },
      // Pure TYPED_C11 (no JS_PARITY, no TYPED_UI) -> emits __hex_asm_island
      {
        kind: HEX_EMIT_TOK_ASM_ISLAND,
        type_id: 0,
        name: sAsmSpecial,
        field: { off: 0, len: 0 },
        imm: 0xd53bd040n,
        aux: HEX_ASM_ISLAND_SYS,
        flags: HEX_TYPED_EMIT_FLAG_TYPED_C11,
        va: 0x401010n,
      },
    ];

    const poolBytes = encoder.encode(poolStr);
    const poolPtr = alloc(poolBytes.length + 1);
    new Uint8Array(mem.buffer, poolPtr, poolBytes.length).set(poolBytes);

    const opsPtr = alloc(ops.length * 48);
    const view = dv();
    ops.forEach((op, i) => {
      const off = opsPtr + i * 48;
      view.setUint32(off + 0, op.kind, true);
      view.setUint32(off + 4, op.type_id, true);
      view.setUint32(off + 8, op.name.off, true);
      view.setUint32(off + 12, op.name.len, true);
      view.setUint32(off + 16, op.field.off, true);
      view.setUint32(off + 20, op.field.len, true);
      view.setBigInt64(off + 24, op.imm, true);
      view.setUint32(off + 32, op.aux, true);
      view.setUint32(off + 36, op.flags, true);
      view.setBigUint64(off + 40, op.va, true);
    });

    const outBufPtr = alloc(1024);
    const outLenPtr = alloc(4);
    const outToksPtr = alloc(ops.length * 24);
    const outTokCountPtr = alloc(4);

    const st = ex.hex_typed_emit_format(
      opsPtr, ops.length,
      poolPtr, poolBytes.length,
      outBufPtr, 1024, outLenPtr,
      outToksPtr, ops.length, outTokCountPtr
    );
    assert.equal(st, HEX_OK);

    const written = view.getUint32(outLenPtr, true);
    const fullText = decoder.decode(new Uint8Array(mem.buffer, outBufPtr, written));
    const expected =
      '(int32_t)x0 | ctx->state | ((SubObj*)((uint8_t*)obj + 0x18)) | ' +
      '__asm__ volatile("mrs x0, \\"sys\\"\\\\1\\n;" /* 0xd53bd040 */); | ' +
      '__hex_asm_island(0x401010ULL, 0xd53bd040U, 0, 0);';
    assert.equal(fullText, expected);

    // Reject empty field_len on MEMBER_ARROW / MEMBER_DOT
    const badOpPtr = alloc(48);
    view.setUint32(badOpPtr + 0, HEX_EMIT_TOK_MEMBER_ARROW, true);
    view.setUint32(badOpPtr + 8, sCtx.off, true);
    view.setUint32(badOpPtr + 12, sCtx.len, true);
    view.setUint32(badOpPtr + 16, 0, true);
    view.setUint32(badOpPtr + 20, 0, true);
    assert.equal(
      ex.hex_typed_emit_format(badOpPtr, 1, poolPtr, poolBytes.length, outBufPtr, 1024, outLenPtr, 0, 0, 0),
      HEX_ERR_INVALID_ARG
    );

    view.setUint32(badOpPtr + 0, HEX_EMIT_TOK_MEMBER_DOT, true);
    view.setUint32(badOpPtr + 12, 0, true);
    view.setUint32(badOpPtr + 16, sState.off, true);
    view.setUint32(badOpPtr + 20, sState.len, true);
    assert.equal(
      ex.hex_typed_emit_format(badOpPtr, 1, poolPtr, poolBytes.length, outBufPtr, 1024, outLenPtr, 0, 0, 0),
      HEX_ERR_INVALID_ARG
    );

    // Overflow protection with canary bytes
    const smallCap = 20;
    const canaryBufPtr = alloc(smallCap + 8);
    const u8 = new Uint8Array(mem.buffer, canaryBufPtr, smallCap + 8);
    u8.fill(0xaa);
    const stOverflow = ex.hex_typed_emit_format(
      opsPtr, ops.length,
      poolPtr, poolBytes.length,
      canaryBufPtr, smallCap, outLenPtr,
      outToksPtr, ops.length, outTokCountPtr
    );
    assert.equal(stOverflow, HEX_ERR_RESOURCE_LIMIT);
    const partialLen = view.getUint32(outLenPtr, true);
    assert.equal(u8[partialLen], 0);
    for (let k = smallCap; k < smallCap + 8; k++) {
      assert.equal(u8[k], 0xaa);
    }
  });

  console.log(`\nALL ${passed} TRACK 4 TESTS PASSED.`);
} finally {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}
