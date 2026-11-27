import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Real WASM engine & telemetry
import { getHexEngineExports } from '../js/core/hex-engine-wasm.js';
import {
  getWasmCallCount,
  getFallbackCount,
  resetAllTelemetry,
} from '../js/core/wasm-telemetry.js';

// Core arch-agnostic Track 8 modules
import {
  BUILTIN_HEXSIG_LIBS,
  BUILTIN_HEXSIG_ENTRIES,
  HEXSIG_LIB_KIND,
  buildBuiltinHexSigDb,
} from '../js/analysis/signature/hexsig-db-data.js';
import {
  HEXSIG_ARCH_ARM64,
  HEXSIG_ARCH_X86_64,
  extractHexSig,
  encodeFingerprint64,
  decodeFingerprint64,
} from '../js/analysis/signature/hex-sig-extractor.js';
import {
  createHexSigIndex,
  HEXSIG_VERDICT,
} from '../js/analysis/signature/hex-sig-index.js';
import {
  encodeHsig1Pack,
  decodeHsig1Pack,
  encodeMatchResult32,
  decodeMatchResult32,
  HSIG1_HEADER_SIZE,
  HSIG1_ENTRY_SIZE,
  HSIG1_MATCH_RESULT_SIZE,
  HSIG1_MAX_SLOT4_BYTES,
} from '../js/analysis/signature/hex-sig-pack.js';
import {
  toVaKey,
  serializeFuncFingerprints,
  deserializeFuncFingerprints,
  portDeltaAnnotations,
} from '../js/analysis/signature/delta-porting.js';
import { computeIntraSsaSlice } from '../js/semantics/ssa/value-slice.js';
import { runCrossFuncSlice } from '../js/analysis/slicing/cross-func-slice.js';
import { createSliceService } from '../js/analysis/slicing/slice-service.js';
import {
  CXX_THUNK_KIND,
  resolvePrimaryObjectOffset,
  createCxxThunkEvidenceStore,
} from '../js/analysis/cxx/thunk-evidence.js';
import {
  STL_CONTAINER_KIND,
  createStlPatternRecognizer,
} from '../js/analysis/cxx/stl-pattern-recognizer.js';
import {
  CFF_STATUS,
  CFF_GUARD_REASON,
  unflattenCffIr,
  runCffUnflattenWasm,
} from '../js/analysis/deobf/cff-unflatten.js';
import {
  HEX_OPT_FLAG_MBA,
  HEX_OPT_FLAG_MBA_STRICT_PROOF,
  simplifyMbaDag,
  verifyMbaEquiv,
  evalMbaDag,
} from '../js/analysis/deobf/mba-simplifier.js';
import {
  DEOBF_RECORD_KIND,
  DEOBF_SOURCE_PRIORITY,
  createDeobfOverlayStore,
} from '../js/analysis/deobf/deobf-overlay-store.js';

// Architecture DI adapters (injected ONLY at composition/test root — NEVER imported by core!)
import { arm64HexSigNormalizer } from '../js/targets/architecture/arm64/hexsig-norm.js';
import { x8664HexSigNormalizer } from '../js/targets/architecture/x86_64/hexsig-norm.js';
import { arm64ThunkPatternAdapter } from '../js/targets/architecture/arm64/thunk-patterns.js';
import { x8664ThunkPatternAdapter } from '../js/targets/architecture/x86_64/thunk-patterns.js';
import { arm64IntraSliceAdapter } from '../js/targets/architecture/arm64/intra-slice-arm64.js';
import {
  evalArm64Deobf,
  DEOBF_EVAL_KIND,
  OPAQUE_PREDICATE_RESULT,
} from '../js/targets/architecture/arm64/deobf-eval-arm64.js';
import {
  HEX_EMU_DEFAULT_SP,
  HEX_EMU_PROT,
  HEX_EMU_STUB_KIND,
  HEX_EMU_STOP_REASON,
  HEX_EMU_SPAN_KIND,
  runMiniArm64Emu,
  runMiniArm64EmuWasm,
} from '../js/targets/architecture/arm64/mini-arm64-emu.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

function u32WordsToBytes(words) {
  const out = new Uint8Array(words.length * 4);
  const dv = new DataView(out.buffer);
  for (let i = 0; i < words.length; i++) {
    dv.setUint32(i * 4, words[i] >>> 0, true);
  }
  return out;
}

function hexBytes(hex) {
  return Uint8Array.from(hex.trim().split(/\s+/).map((h) => parseInt(h, 16)));
}

let passed = 0;
let failed = 0;

function runTest(name, fn) {
  try {
    fn();
    passed++;
    console.log(`PASS: ${name}`);
  } catch (err) {
    failed++;
    console.error(`FAIL: ${name}`);
    console.error(err);
  }
}

// =============================================================================
// 1. HEX-SIG: HSIG1 Pack Round-Trip + Real WASM hex_hexsig_mount & Normalizer Parity
// =============================================================================
runTest('HEX-SIG: Built-in OSS DB, OpenSSL crypto kind, & 32B/96B HSIG1 round-trip', () => {
  assert.ok(BUILTIN_HEXSIG_LIBS.length >= 8);
  assert.ok(BUILTIN_HEXSIG_ENTRIES.length >= 12);
  const openssl = BUILTIN_HEXSIG_LIBS.find((l) => l.vendorName === 'OpenSSL');
  assert.equal(openssl.kindId, HEXSIG_LIB_KIND.CRYPTO);

  const db = buildBuiltinHexSigDb();
  const blob = encodeHsig1Pack({ entries: db.entries });
  assert.ok(blob.length >= HSIG1_HEADER_SIZE + db.entries.length * HSIG1_ENTRY_SIZE);
  assert.ok(blob.length <= HSIG1_MAX_SLOT4_BYTES);

  const parsed = decodeHsig1Pack(blob);
  assert.equal(parsed.version, 1);
  assert.equal(parsed.archMask, HEXSIG_ARCH_ARM64 | HEXSIG_ARCH_X86_64);
  assert.equal(parsed.entryCount, db.entries.length);
  assert.equal(parsed.entriesOff, 32);
  assert.equal(parsed.entries[0].symbolName, 'memcpy');
  assert.equal(parsed.entries[0].arch, HEXSIG_ARCH_ARM64);
  assert.equal(parsed.entries[2].symbolName, 'memset');
  assert.equal(parsed.entries[2].arch, HEXSIG_ARCH_X86_64);

  // Corrupting a byte must fail FNV-32 checksum
  const corrupted = new Uint8Array(blob);
  corrupted[corrupted.length - 1] ^= 0x01;
  assert.throws(() => decodeHsig1Pack(corrupted), /checksum mismatch/i);

  // 32B HexSigMatchResult round-trip
  const rec = {
    queryHash64: 0x1122334455667788n,
    entryIndex: 3,
    nameOff: 12,
    nameLen: 6,
    libId: 0,
    confidence: 950,
    runnerUpConf: 400,
    matchedBits: 224,
    tailCrc16Actual: 0x1234,
    status: 2,
    tailCrcMatched: 1,
    candidateCount: 1,
  };
  const rBytes = encodeMatchResult32(rec);
  assert.equal(rBytes.length, HSIG1_MATCH_RESULT_SIZE);
  assert.deepEqual(decodeMatchResult32(rBytes), rec);

  // 64B Fingerprint round-trip
  const fp = db.entries[0].fingerprint;
  assert.equal(decodeFingerprint64(encodeFingerprint64(fp)).l1Simhash64, fp.l1Simhash64);
});

runTest('HEX-SIG: Real WASM hex_hexsig_mount + hex_hexsig_normalize_* + hex_hexsig_match_fn 1:1 parity', () => {
  // ARM64 code with ADRP x8, #page + ADD x8, x8, #imm12 + LDR x0, [x8, #imm12] + BL + RET
  const arm64A = u32WordsToBytes([
    0xa9bf7bfd, // stp x29, x30, [sp, #-16]!
    0x910003fd, // mov x29, sp
    0x90000088, // adrp x8, #0x10000
    0x91044108, // add x8, x8, #0x110 (imm12 masked because x8 came from ADRP!)
    0xf9400900, // ldr x0, [x8, #16]
    0x94000020, // bl +0x80 (imm26 masked!)
    0xa8c17bfd, // ldp x29, x30, [sp], #16
    0xd65f03c0, // ret
  ]);
  const arm64B = u32WordsToBytes([
    0xa9bf7bfd, // stp x29, x30, [sp, #-16]!
    0x910003fd, // mov x29, sp
    0xd0000248, // adrp x8, #different_page
    0x91099108, // add x8, x8, #0x264 (different page offset -> masked!)
    0xf9400900, // ldr x0, [x8, #16]
    0x94000999, // bl +different_target (masked!)
    0xa8c17bfd, // ldp x29, x30, [sp], #16
    0xd65f03c0, // ret
  ]);

  const sigArmA = extractHexSig(arm64A, arm64HexSigNormalizer);
  const sigArmB = extractHexSig(arm64B, arm64HexSigNormalizer);
  assert.equal(sigArmA.patternHash64, sigArmB.patternHash64);

  // x86-64 code with ENDBR64 + prologue + RIP-rel LEA + CALL rel32 + RET
  const x64A = hexBytes('f3 0f 1e fa 55 48 89 e5 48 8d 3d 11 22 33 44 e8 aa bb cc dd 5d c3');
  const x64B = hexBytes('f3 0f 1e fa 55 48 89 e5 48 8d 3d 55 66 77 88 e8 12 34 56 78 5d c3');
  const sigX64A = extractHexSig(x64A, x8664HexSigNormalizer);
  const sigX64B = extractHexSig(x64B, x8664HexSigNormalizer);
  assert.equal(sigX64A.patternHash64, sigX64B.patternHash64);

  // Build HSIG1 pack from JS-extracted ARM64 + x86-64 signatures
  const entries = [
    {
      symbolName: 'test_arm64_fn',
      libId: 0,
      arch: HEXSIG_ARCH_ARM64,
      pattern: sigArmA.pattern,
      mask: sigArmA.mask,
      prologueLen: sigArmA.length,
      patternHash64: sigArmA.patternHash64,
      baseConfidence: 900,
    },
    {
      symbolName: 'test_x64_fn',
      libId: 0,
      arch: HEXSIG_ARCH_X86_64,
      pattern: sigX64A.pattern,
      mask: sigX64A.mask,
      prologueLen: sigX64A.length,
      patternHash64: sigX64A.patternHash64,
      baseConfidence: 900,
    },
  ];
  const pack = encodeHsig1Pack({ entries });

  // Verify against REAL WASM module (always load with _engine:'wasm' to test binary parity even if HEX_ENGINE=js)
  const ex = getHexEngineExports({ _engine: 'wasm' });
  assert.ok(ex && typeof ex.hex_hexsig_mount === 'function', 'Real WASM hex_hexsig_mount must be available');

  // 1. Verify bit-for-bit normalizer parity with C++ hex_hexsig_normalize_arm64 & hex_hexsig_normalize_x64
  ex.hex_engine_scratch_reset();
  const cArmPtr = ex.hex_engine_scratch_alloc(arm64A.length, 8);
  const outNormPtr = ex.hex_engine_scratch_alloc(32, 8);
  const outMaskPtr = ex.hex_engine_scratch_alloc(32, 8);
  const outHashPtr = ex.hex_engine_scratch_alloc(8, 8);
  new Uint8Array(ex.memory.buffer).set(arm64A, cArmPtr);
  assert.equal(ex.hex_hexsig_normalize_arm64(cArmPtr, arm64A.length, outNormPtr, outMaskPtr, outHashPtr), 0);
  const wasmArmNorm = new Uint8Array(ex.memory.buffer, outNormPtr, 32).slice();
  const wasmArmMask = new Uint8Array(ex.memory.buffer, outMaskPtr, 32).slice();
  const wasmArmHash = new DataView(ex.memory.buffer).getBigUint64(outHashPtr, true);
  assert.deepEqual(sigArmA.pattern, wasmArmNorm, 'ARM64 normalized pattern must match C++ byte-for-byte');
  assert.deepEqual(sigArmA.mask, wasmArmMask, 'ARM64 mask must match C++ byte-for-byte');
  assert.equal(sigArmA.patternHash64, wasmArmHash, 'ARM64 FNV-1a64 hash must match C++ bit-for-bit');

  ex.hex_engine_scratch_reset();
  const cX64Ptr = ex.hex_engine_scratch_alloc(x64A.length, 8);
  const outX64NormPtr = ex.hex_engine_scratch_alloc(32, 8);
  const outX64MaskPtr = ex.hex_engine_scratch_alloc(32, 8);
  const outX64HashPtr = ex.hex_engine_scratch_alloc(8, 8);
  new Uint8Array(ex.memory.buffer).set(x64A, cX64Ptr);
  assert.equal(ex.hex_hexsig_normalize_x64(cX64Ptr, x64A.length, outX64NormPtr, outX64MaskPtr, outX64HashPtr), 0);
  const wasmX64Norm = new Uint8Array(ex.memory.buffer, outX64NormPtr, 32).slice();
  const wasmX64Mask = new Uint8Array(ex.memory.buffer, outX64MaskPtr, 32).slice();
  const wasmX64Hash = new DataView(ex.memory.buffer).getBigUint64(outX64HashPtr, true);
  assert.deepEqual(sigX64A.pattern, wasmX64Norm, 'x86-64 normalized pattern must match C++ byte-for-byte');
  assert.deepEqual(sigX64A.mask, wasmX64Mask, 'x86-64 mask must match C++ byte-for-byte');
  assert.equal(sigX64A.patternHash64, wasmX64Hash, 'x86-64 FNV-1a64 hash must match C++ bit-for-bit');

  // 2. Mount encodeHsig1Pack() directly into real WASM hex_hexsig_mount and match both ARM64 & x86-64!
  ex.hex_engine_scratch_reset();
  const packPtr = ex.hex_engine_scratch_alloc(pack.length, 8);
  const qArmPtr = ex.hex_engine_scratch_alloc(arm64B.length, 8);
  const qX64Ptr = ex.hex_engine_scratch_alloc(x64B.length, 8);
  const resPtr = ex.hex_engine_scratch_alloc(HSIG1_MATCH_RESULT_SIZE, 8);
  const mem = new Uint8Array(ex.memory.buffer);
  mem.set(pack, packPtr);
  mem.set(arm64B, qArmPtr);
  mem.set(x64B, qX64Ptr);

  assert.equal(ex.hex_hexsig_mount(packPtr, pack.length), 0, 'Real WASM hex_hexsig_mount must return HEX_OK (0)');
  assert.equal(ex.hex_hexsig_match_fn(qArmPtr, arm64B.length, HEXSIG_ARCH_ARM64, resPtr), 0);
  const wasmArmRes = decodeMatchResult32(new Uint8Array(ex.memory.buffer, resPtr, HSIG1_MATCH_RESULT_SIZE));
  assert.equal(wasmArmRes.entryIndex, 0);
  assert.ok(wasmArmRes.status > 0);
  assert.ok(wasmArmRes.confidence >= 800);

  assert.equal(ex.hex_hexsig_match_fn(qX64Ptr, x64B.length, HEXSIG_ARCH_X86_64, resPtr), 0);
  const wasmX64Res = decodeMatchResult32(new Uint8Array(ex.memory.buffer, resPtr, HSIG1_MATCH_RESULT_SIZE));
  assert.equal(wasmX64Res.entryIndex, 1);
  assert.ok(wasmX64Res.status > 0);

  // 3. Verify HexSigIndex WASM vs JS parity + telemetry hooks
  resetAllTelemetry();
  const idx = createHexSigIndex(entries, BUILTIN_HEXSIG_LIBS);
  const wasmIdxHit = idx.match(sigArmB, { preferWasm: true, _engine: 'wasm' });
  const jsIdxHit = idx.match(sigArmB, { preferWasm: true, _engine: 'js' });
  assert.equal(wasmIdxHit.engine, 'wasm');
  assert.equal(jsIdxHit.engine, 'js');
  assert.equal(wasmIdxHit.symbolName, 'test_arm64_fn');
  assert.equal(jsIdxHit.symbolName, 'test_arm64_fn');
  assert.ok(getWasmCallCount('hexsig') >= 1);
  assert.ok(getFallbackCount('HEXSIG_JS_FALLBACK') >= 1);
});

// =============================================================================
// 2. Sparse Delta Porting: Canonical toVaKey, Callgraph +70, N:1 Conflict, data:<va>
// =============================================================================
runTest('Delta Porting: sparse index, canonical toVaKey, N:1 conflict isolation, & data:<va>', () => {
  assert.equal(toVaKey('0X1A00'), '0x1a00');
  assert.equal(toVaKey('4096'), '0x1000');
  assert.equal(toVaKey(0x1000n), '0x1000');

  const fpAnchor = {
    l1Simhash64: 0x1111222233334444n,
    l2WlHash64: 0x5555666677778888n,
    l3ConstHash64: 0x9999aaaabbbbccccn,
    l3StrHash64: 0xddddeeeeffff0001n,
    l1Minhash: new Uint32Array([1, 2, 3, 4]),
    l1OpProfile32: 0x40404040,
    l2BbCount: 6,
    l2EdgeCount: 8,
    l3CryptoMask: 0,
    l3LibHintMask: 0,
  };
  const fpDup = {
    l1Simhash64: 0xaabbccddeeff1122n,
    l2WlHash64: 0x3344556677889900n,
    l3ConstHash64: 0x1234567890abcdefn,
    l3StrHash64: 0n,
    l1Minhash: new Uint32Array([77, 88, 99, 100]),
    l1OpProfile32: 0x20202020,
    l2BbCount: 5,
    l2EdgeCount: 6,
    l3CryptoMask: 0,
    l3LibHintMask: 0,
  };

  const ser = serializeFuncFingerprints([{ va: '4096', fingerprint: fpAnchor }]);
  assert.equal(deserializeFuncFingerprints(ser)[0].va, '0x1000');

  // Two identical old functions competing for one new function -> MUST trigger ambiguous_n_to_1!
  const oldFuncs = [
    { va: 0x1000n, fingerprint: fpAnchor, strings: ['init_world'], callees: [], callers: [] },
    { va: 0x2000n, fingerprint: fpDup, strings: ['dup_fn'], callees: [], callers: [] },
    { va: 0x2100n, fingerprint: fpDup, strings: ['dup_fn'], callees: [], callers: [] },
  ];
  const newFuncs = [
    { va: 0x4000n, fingerprint: fpAnchor, strings: ['init_world'], callees: [], callers: [] },
    { va: 0x5000n, fingerprint: fpDup, strings: ['dup_fn'], callees: [], callers: [] },
  ];

  const oldDelta = {
    names: { '0X1000': 'GameWorld::Init' },
    types: { 'fn:4096:ret': 'int32_t', 'data:0X8000': 'struct WorldConfig*' },
  };
  const res = portDeltaAnnotations(oldDelta, oldFuncs, newFuncs, {
    dataVaMap: { '0x8000': '0x9000' },
  });

  assert.equal(res.ported.names['0x4000'], 'GameWorld::Init');
  assert.equal(res.ported.types['fn:0x4000:ret'], 'int32_t');
  assert.equal(res.ported.types['data:0x9000'], 'struct WorldConfig*');
  assert.ok(res.pendingConflicts.some((c) => c.reason === 'ambiguous_n_to_1' && c.newVa === '0x5000'));
});

// =============================================================================
// 3. Value Slicing: Budget Enforcement, Edge Budget Stop, & ARM64 Backward Kill
// =============================================================================
runTest('Value Slicing: Intra-SSA, Cross-Func inner branchFactor/edge_budget, & ARM64 dstPort kill', () => {
  const ssa = {
    nodes: [
      { id: 'n0', op: 'load_field', dst: 'v1', srcs: ['arg0'], insnVa: 0x2000n },
      { id: 'n1', op: 'add', dst: 'v2', srcs: ['v1', 'arg1'], insnVa: 0x2004n },
      { id: 'n2', op: 'ret', dst: 'ret', srcs: ['v2'], insnVa: 0x2008n },
    ],
  };
  const back = computeIntraSsaSlice(ssa, 'ret', { direction: 'backward' });
  assert.equal(back.nodes.length, 3);

  // Test edge_budget stopReason
  const prog = {
    functions: {
      '0x1000': {
        va: 0x1000n,
        ssa,
        callers: [
          { callerVa: 0x100n, argMap: { arg0: 'a0', arg1: 'a1' } },
          { callerVa: 0x200n, argMap: { arg0: 'b0', arg1: 'b1' } },
        ],
      },
    },
  };
  const limited = runCrossFuncSlice(prog, { funcVa: '0X1000', port: 'ret' }, {
    direction: 'backward',
    budget: { maxEdges: 1, maxBranchFactor: 1 },
  });
  assert.equal(limited.stopReason, 'edge_budget');
  assert.equal(limited.edges.length, 1);

  // Test ARM64 backward dstPort kill:
  //   add x0, x1, #4   (DEAD! x0 is overwritten by next instruction)
  //   movz x0, #0x42   (kills x0!)
  //   add x0, x0, #1
  const killCode = u32WordsToBytes([
    0x91001020, // add x0, x1, #4 (dead!)
    0x52800840, // movz w0, #0x42 (kills x0!)
    0x91000400, // add x0, x0, #1
  ]);
  const intra = arm64IntraSliceAdapter.sliceIntra(killCode, 0x3000n, 'x0', 'backward', 64);
  assert.equal(intra.edges.length, 2, 'Dead prior def of x0 must be killed');
  assert.equal(intra.boundaryPorts.includes('x1'), false, 'x1 from killed def must not leak into boundaryPorts');

  const svc = createSliceService({ intraAdapters: { arm64: arm64IntraSliceAdapter } });
  const binding = { epoch: 1, sliceIndex: 0, symbolsGen: 1, recoveredTypesRevision: 1 };
  svc.executeSlice({ program: prog, seed: { funcVa: 0x1000n, port: 'ret' }, arch: 'arm64', binding });
  assert.equal(svc.isSessionFresh(binding), true);
  svc.forgetSemantics();
  assert.equal(svc.getSession(), null);
});

// =============================================================================
// 4. C++ Thunks & STL Pattern Recognizer
// =============================================================================
runTest('C++ Thunks & STL: ARM64/x86-64 DI, double-shift prevention, closed-world gate, & STL LRU', () => {
  const armNonVirt = u32WordsToBytes([0xd1004000, 0x14000010]); // sub x0, x0, #16; b +0x40
  const x64NonVirt = hexBytes('f3 0f 1e fa 48 83 ef 10 eb 20');  // endbr64; sub rdi, 0x10; jmp +0x20
  const store = createCxxThunkEvidenceStore();
  const hits = [
    ...store.ingestCandidates([{ va: '0X5000', codeBytes: armNonVirt }], arm64ThunkPatternAdapter),
    ...store.ingestCandidates([{ va: 0x7000n, codeBytes: x64NonVirt }], x8664ThunkPatternAdapter),
  ];
  assert.equal(hits.length, 2);
  assert.equal(hits[0].kind, CXX_THUNK_KIND.NON_VIRTUAL);
  assert.equal(hits[0].fixedDelta, -16);
  assert.equal(store.getThunk('20480').targetVa, '0x5044'); // 20480 == 0x5000

  assert.equal(resolvePrimaryObjectOffset({ localOffset: 0x28, offsetToTop: -16, observationOrigin: 'non_virtual_thunk_target' }).primaryOffset, 0x28);
  assert.equal(resolvePrimaryObjectOffset({ localOffset: 0x08, offsetToTop: -16, observationOrigin: 'secondary_base_direct_method' }).primaryOffset, 0x18);

  const rec = createStlPatternRecognizer(16);
  const vec = rec.recognize('fn_vec', {
    structSize: 24,
    fields: [{ offset: 0, size: 8 }, { offset: 8, size: 8 }, { offset: 16, size: 8 }],
    accessPatterns: ['end_eq_cap_grow'],
  });
  assert.equal(vec.primary.kind, STL_CONTAINER_KIND.VECTOR);
});

// =============================================================================
// 5. OLLVM CFF Unflattening: Dominance Guard 6, initState Fail-Closed, 64-bit State, & WASM Hook
// =============================================================================
runTest('CFF Unflatten: recovers 64-bit CFF, enforces Dominance Guard 6 & missing initState, & WASM hook', () => {
  const S1 = 0x1111222233334444n;
  const S2 = 0x2222333344445555n;
  const S3 = 0x3333444455556666n;
  const S4 = 0x4444555566667777n;

  const flattened = {
    entryBlock: 'entry',
    stateVar: 'st',
    stateVarOrigin: 'const',
    blocks: [
      { id: 'entry', insts: [{ op: 'const', dst: 'st', value: S1 }], succs: ['disp'] },
      {
        id: 'disp',
        stateVar: 'st',
        insts: [],
        succs: ['b1', 'b2', 'b3', 'b4'],
        dispatchCases: {
          [S1.toString()]: 'b1',
          [S2.toString()]: 'b2',
          [S3.toString()]: 'b3',
          [S4.toString()]: 'b4',
        },
      },
      { id: 'b1', insts: [{ op: 'const', dst: 'st', value: S2 }], succs: ['merge'] },
      { id: 'b2', insts: [{ op: 'csel', dst: 'st', condInstId: 99, trueVal: S3, falseVal: S4 }], succs: ['merge'] },
      { id: 'b3', insts: [{ op: 'ret' }], succs: [] },
      { id: 'b4', insts: [{ op: 'ret' }], succs: [] },
      { id: 'merge', insts: [], succs: ['disp'] },
    ],
  };

  const res = unflattenCffIr(flattened, { stateWidthBits: 64 });
  assert.equal(res.statusCode, CFF_STATUS.RECOVERED);
  assert.equal(res.stats.realBlocks, 4);

  // Guard 6 (Dominance failure): add bypass edge from entry -> b3 so dispatcher does NOT dominate b3!
  const nonDom = structuredClone(flattened);
  nonDom.blocks[0].succs.push('b3');
  const resNonDom = unflattenCffIr(nonDom);
  assert.equal(resNonDom.statusCode, CFF_STATUS.ABORT_GUARD);
  assert.equal(resNonDom.guardFailReason, CFF_GUARD_REASON.DRAFT_CFG_INTEGRITY_ERROR);

  // Missing constant initState in entry -> Fail-Closed!
  const noInit = structuredClone(flattened);
  noInit.blocks[0].insts = [];
  const resNoInit = unflattenCffIr(noInit);
  assert.equal(resNoInit.statusCode, CFF_STATUS.ABORT_GUARD);

  // WASM hook check (`hex_cff_unflatten`)
  resetAllTelemetry();
  const wasmCff = runCffUnflattenWasm([
    { blockId: 0, flags: 1 | 4, stateVarId: 1, matchState: 0n, nextStateTrue: 10n, nextStateFalse: 0n, hasMatchState: false },
    { blockId: 1, flags: 2, stateVarId: 1, matchState: 0n, nextStateTrue: 0n, nextStateFalse: 0n, hasMatchState: false },
    { blockId: 2, flags: 4, stateVarId: 1, matchState: 10n, nextStateTrue: 20n, nextStateFalse: 0n, hasMatchState: true },
    { blockId: 3, flags: 4 | 8, stateVarId: 1, condId: 7, matchState: 20n, nextStateTrue: 30n, nextStateFalse: 40n, hasMatchState: true },
    { blockId: 4, flags: 4, stateVarId: 1, matchState: 30n, nextStateTrue: 40n, nextStateFalse: 0n, hasMatchState: true },
    { blockId: 5, flags: 16, stateVarId: 1, matchState: 40n, nextStateTrue: 0n, nextStateFalse: 0n, hasMatchState: true },
  ], [
    { srcBlock: 0, dstBlock: 1, kind: 1 },
    { srcBlock: 1, dstBlock: 2, kind: 4 },
    { srcBlock: 1, dstBlock: 3, kind: 4 },
    { srcBlock: 1, dstBlock: 4, kind: 4 },
    { srcBlock: 1, dstBlock: 5, kind: 4 },
    { srcBlock: 2, dstBlock: 1, kind: 5 },
    { srcBlock: 3, dstBlock: 1, kind: 5 },
    { srcBlock: 4, dstBlock: 1, kind: 5 },
  ], { _engine: 'wasm' });
  assert.ok(wasmCff && wasmCff.engine === 'wasm');
  assert.equal(wasmCff.statusCode, CFF_STATUS.RECOVERED);
  assert.ok(getWasmCallCount('cff_unflatten') >= 1);
});

// =============================================================================
// 6. Linear MBA Simplifier: 64-bit Constant Layer 2 Fix, WASM vs JS 1:1 Parity
// =============================================================================
runTest('MBA Simplifier: 64-bit constant Layer 2, WASM vs JS 1:1 parity, & non-linear rejection', () => {
  const vx = (w) => ({ op: 'var', name: 'x', width: w });
  const vy = (w) => ({ op: 'var', name: 'y', width: w });
  const c = (v, w) => ({ op: 'const', value: BigInt(v), width: w });

  // Expression with large 64-bit constant (would fail if Layer 2 truncated to 3 bits!)
  const BIG_K = 0x123456789abcdef0n;
  const mbaWithBigConst = {
    op: 'add',
    width: 64,
    a: {
      op: 'add',
      width: 64,
      a: { op: 'xor', width: 64, a: vx(64), b: vy(64) },
      b: { op: 'mul', width: 64, a: c(2, 64), b: { op: 'and', width: 64, a: vx(64), b: vy(64) } },
    },
    b: c(BIG_K, 64),
  };

  resetAllTelemetry();
  const wasmRes = simplifyMbaDag(mbaWithBigConst, { _engine: 'wasm', optFlags: HEX_OPT_FLAG_MBA | HEX_OPT_FLAG_MBA_STRICT_PROOF });
  const jsRes = simplifyMbaDag(mbaWithBigConst, { _engine: 'js', optFlags: HEX_OPT_FLAG_MBA | HEX_OPT_FLAG_MBA_STRICT_PROOF });

  assert.equal(wasmRes.engine, 'wasm');
  assert.equal(jsRes.engine, 'js');
  assert.equal(wasmRes.simplified, true);
  assert.equal(jsRes.simplified, true);
  assert.equal(wasmRes.proof.proved, true);
  assert.equal(jsRes.proof.proved, true);
  assert.ok(getWasmCallCount('mba_simplifier') >= 1);
  assert.ok(getFallbackCount('MBA_JS_FALLBACK') >= 1);

  // Evaluate both simplified expressions on arbitrary 64-bit inputs -> exact parity
  const env = { x: 0xfedcba9876543210n, y: 0x0102030405060708n };
  const expected = (env.x + env.y + BIG_K) & 0xffffffffffffffffn;
  assert.equal(evalMbaDag(wasmRes.expr, env, 64), expected);
  assert.equal(evalMbaDag(jsRes.expr, env, 64), expected);

  // Non-linear false equivalence (x * y vs x & y) MUST fail at Layer 2
  const badProof = verifyMbaEquiv(
    { op: 'mul', width: 32, a: vx(32), b: vy(32) },
    { op: 'and', width: 32, a: vx(32), b: vy(32) },
    { strictProof: true },
  );
  assert.equal(badProof.proved, false);
  assert.equal(badProof.failedLayer, 2);
});

// =============================================================================
// 7. MiniArm64Emu & deobf-eval-arm64: V Flag, ASR/ROR Shifts, C++ SP, & WASM Parity
// =============================================================================
runTest('MiniArm64Emu & deobf-eval-arm64: V overflow flag, ASR/ROR shifts, C++ SP, & WASM parity', () => {
  assert.equal(HEX_EMU_DEFAULT_SP, 0x7fff0000ffc0n);

  // Test signed overflow V=1 on 32-bit ADDS: 0x7FFFFFFF + 1 = 0x80000000 (N=1, Z=0, C=0, V=1)
  // Plus ASR shifted ADD (`add w1, w1, w0, asr #4`) and ROR shifted ORR (`orr w2, wzr, w0, ror #4`)
  const flagShiftCode = u32WordsToBytes([
    0x31000400, // adds w0, w0, #1          (0x7fffffff + 1 -> 0x80000000, N=1, V=1!)
    0x0b801021, // add  w1, w1, w0, asr #4  (0 + (int32(0x80000000) >> 4) = 0xf8000000!)
    0x2ac013e2, // orr  w2, wzr, w0, ror #4 (ror32(0x80000000, 4) = 0x08000000!)
    0xd65f03c0, // ret
  ]);

  const jsRes = runMiniArm64Emu([
    { va: 0x10000n, bytes: flagShiftCode, prot: HEX_EMU_PROT.R | HEX_EMU_PROT.X },
  ], [], {
    entryVa: 0x10000n,
    initialRegs: { 0: 0x7fffffffn, 1: 0n },
  });
  assert.equal(jsRes.stopReason, HEX_EMU_STOP_REASON.RETURN_OK);
  assert.equal(jsRes.sp, 0x7fff0000ffc0n);
  assert.equal(jsRes.x0, 0x80000000n);
  assert.equal(jsRes.flags.N, 1);
  assert.equal(jsRes.flags.V, 1, 'Signed overflow V flag MUST be 1 for 0x7FFFFFFF + 1');

  // Compare with real WASM MiniArm64Emu (1:1 parity on x0, sp, NZCV!)
  resetAllTelemetry();
  const wasmRes = runMiniArm64EmuWasm(flagShiftCode, {
    _engine: 'wasm',
    entryVa: 0x10000n,
    codeVa: 0x10000n,
    initialRegs: { 0: 0x7fffffffn, 1: 0n },
  });
  assert.ok(wasmRes && wasmRes.engine === 'wasm');
  assert.equal(wasmRes.x0, jsRes.x0);
  assert.equal(wasmRes.sp, jsRes.sp);
  assert.deepEqual(wasmRes.flags, jsRes.flags);
  assert.ok(getWasmCallCount('mini_arm64_emu') >= 1);

  // Verify deobf-eval-arm64 also computes V=1 and resolves B.VS (cond=6) as ALWAYS_TRUE!
  const ovfCode = u32WordsToBytes([
    0x528fffe0, // movz w0, #0x7fff
    0x72afffe0, // movk w0, #0x7fff, lsl #16 -> 0x7fff7fff
    0x52900001, // movz w1, #0x8000
    0x2b010000, // adds w0, w0, w1 -> 0x7fff7fff + 0x8000 = 0x7fffffff? No, add 0x10000
    0x31000400, // adds w0, w0, #1 -> 0x80000000 (V=1!)
    0x54000046, // b.vs +8 (cond=6 -> V===1 -> ALWAYS_TRUE!)
    0xd503201f, // nop
    0xd65f03c0, // ret
  ]);
  const ev = evalArm64Deobf(ovfCode, { funcVa: 0x40000n });
  assert.equal(ev.finalFlags.V, 1);
  assert.equal(ev.opaquePredicates[0].result, OPAQUE_PREDICATE_RESULT.ALWAYS_TRUE);

  // Overlay store canonical VA + priority arbitration
  const store = createDeobfOverlayStore();
  store.setAnnotation({ insnVa: '0X40000', source: 'bounded_abstract_vm', text: 'vm', kind: DEOBF_RECORD_KIND.STACK_STR });
  assert.equal(store.getAnnotation(0x40000n).priority, DEOBF_SOURCE_PRIORITY.ABSTRACT_VM);
  store.setAnnotation({ insnVa: '262144', source: 'mini_arm64_emu', partialRun: false, text: 'emu', kind: DEOBF_RECORD_KIND.EMU_STR });
  assert.equal(store.getAnnotation(0x40000n).text, 'emu');
});

// =============================================================================
// 8. Static INV-005 Import-Boundary Check
// =============================================================================
runTest('INV-005: Zero arch/ABI imports in generic analysis dirs & zero ABI imports in arch dirs', () => {
  const IMPORT_RE = /(?:import\s+(?:(?:[\w*\s{},]+from\s+)?['"]([^'"]+)['"])|export\s+[\w*\s{},]+from\s+['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\))/g;

  const genericFiles = [
    'js/analysis/signature/hexsig-db-data.js',
    'js/analysis/signature/hex-sig-extractor.js',
    'js/analysis/signature/hex-sig-index.js',
    'js/analysis/signature/hex-sig-pack.js',
    'js/analysis/signature/delta-porting.js',
    'js/analysis/slicing/cross-func-slice.js',
    'js/analysis/slicing/slice-service.js',
    'js/semantics/ssa/value-slice.js',
    'js/analysis/cxx/thunk-evidence.js',
    'js/analysis/cxx/stl-pattern-recognizer.js',
    'js/analysis/deobf/cff-unflatten.js',
    'js/analysis/deobf/mba-simplifier.js',
    'js/analysis/deobf/deobf-overlay-store.js',
  ];

  const archFiles = [
    'js/targets/architecture/arm64/thunk-patterns.js',
    'js/targets/architecture/arm64/hexsig-norm.js',
    'js/targets/architecture/arm64/deobf-eval-arm64.js',
    'js/targets/architecture/arm64/intra-slice-arm64.js',
    'js/targets/architecture/arm64/mini-arm64-emu.js',
    'js/targets/architecture/x86_64/thunk-patterns.js',
    'js/targets/architecture/x86_64/hexsig-norm.js',
  ];

  function extractImports(relFile) {
    const abs = path.join(REPO_ROOT, relFile);
    const src = fs.readFileSync(abs, 'utf8');
    const out = [];
    let m;
    while ((m = IMPORT_RE.exec(src)) !== null) {
      const spec = m[1] || m[2] || m[3];
      if (!spec || !spec.startsWith('.')) continue;
      out.push(path.posix.normalize(path.posix.join(path.posix.dirname(relFile), spec)));
    }
    return out;
  }

  for (const f of genericFiles) {
    for (const t of extractImports(f)) {
      assert.equal(t.startsWith('js/targets/architecture/'), false, `INV-005 violation: ${f} -> ${t}`);
      assert.equal(t.startsWith('js/architecture/'), false, `INV-005 violation: ${f} -> ${t}`);
      assert.equal(t.startsWith('js/targets/abi/'), false, `INV-005 violation: ${f} -> ${t}`);
      assert.equal(t.startsWith('js/abi/'), false, `INV-005 violation: ${f} -> ${t}`);
      if (f === 'js/semantics/ssa/value-slice.js') {
        assert.equal(t.includes('/compat/'), false, `compat import violation: ${f} -> ${t}`);
      }
    }
  }

  for (const f of archFiles) {
    for (const t of extractImports(f)) {
      assert.equal(t.startsWith('js/targets/abi/'), false, `INV-005 arch->abi violation: ${f} -> ${t}`);
      assert.equal(t.startsWith('js/abi/'), false, `INV-005 arch->abi violation: ${f} -> ${t}`);
    }
  }
});

console.log(`\nTrack 8 summary: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
