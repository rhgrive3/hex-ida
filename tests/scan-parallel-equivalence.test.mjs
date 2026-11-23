import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  planProgramChunks,
  planShapeChunks,
  routeCrossChunkForwardTargets,
  mergeChunkProgramScans,
  mergeChunkShapeScans,
  computeWaveConcurrency,
  PROGRAM_INDEX_BUDGET_BYTES,
  MAX_SHAPE_EVENTS,
} from '../js/scan-planner.js';
import { ScanWorkerPool } from '../js/scan-pool.js';
import { mergeProgramScans } from '../js/program.js';
import { executableByteCoverage } from '../js/analysis/discovery/executable-coverage.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const JS_DIR = path.join(ROOT, 'js');

/* ── ARM64 Instruction Encoders ─────────────────────────────── */

const NOP = 0xd503201f;
const RET = 0xd65f03c0;
const BRK_0 = 0xd4200000;
const SVC_0 = 0xd4000001;
const UDF_0 = 0x00000000;
const BICS_WZR_W0_W0 = 0x6a20001f;   // __crossBinaryExactKind -> LOGIC
const EXTR_W0_W0_W0_0 = 0x13800000;  // __crossBinaryExactKind -> SHIFT
const SCVTF_FIX_S0_W0 = 0x1e000000;  // __crossBinaryExactKind -> FCONV
const SVE_ADD_Z0 = 0x04000000;       // __crossBinaryExactKind -> ARITH
const LDADD_X1_X0_X2 = 0xf8200041;   // LSE atomic RMW at [x2]
const CAS_X0_X1_X2 = 0xc8a07c41;     // CAS atomic RMW at [x2]

function encAdrp(rd, pc, targetPage) {
  const immPages = (BigInt(targetPage) - (BigInt(pc) & ~0xfffn)) >> 12n;
  const immlo = Number(immPages & 3n);
  const immhi = Number((immPages >> 2n) & 0x7ffffn);
  return (0x90000000 | (immlo << 29) | (immhi << 5) | (rd & 31)) >>> 0;
}

function encAdr(rd, pc, target) {
  const delta = BigInt(target) - BigInt(pc);
  const immlo = Number(delta & 3n);
  const immhi = Number((delta >> 2n) & 0x7ffffn);
  return (0x10000000 | (immlo << 29) | (immhi << 5) | (rd & 31)) >>> 0;
}

function encAddImm64(rd, rn, imm12, shift12 = 0) {
  return (0x91000000 | ((shift12 ? 1 : 0) << 22) | ((imm12 & 0xfff) << 10) | ((rn & 31) << 5) | (rd & 31)) >>> 0;
}

function encSubImm32(rd, rn, imm12) {
  return (0x51000000 | ((imm12 & 0xfff) << 10) | ((rn & 31) << 5) | (rd & 31)) >>> 0;
}

function encAddImm32(rd, rn, imm12) {
  return (0x11000000 | ((imm12 & 0xfff) << 10) | ((rn & 31) << 5) | (rd & 31)) >>> 0;
}

function encSubReg32(rd, rn, rm) {
  return (0x4b000000 | ((rm & 31) << 16) | ((rn & 31) << 5) | (rd & 31)) >>> 0;
}

function encLdrUoff64(rt, rn, byteOff) {
  return (0xf9400000 | (((byteOff >>> 3) & 0xfff) << 10) | ((rn & 31) << 5) | (rt & 31)) >>> 0;
}

function encLdrUoff32(rt, rn, byteOff) {
  return (0xb9400000 | (((byteOff >>> 2) & 0xfff) << 10) | ((rn & 31) << 5) | (rt & 31)) >>> 0;
}

function encStrUoff32(rt, rn, byteOff) {
  return (0xb9000000 | (((byteOff >>> 2) & 0xfff) << 10) | ((rn & 31) << 5) | (rt & 31)) >>> 0;
}

function encLdp64(rt, rt2, rn, byteOff) {
  const imm7 = ((byteOff >> 3) & 0x7f);
  return (0xa9400000 | (imm7 << 15) | ((rt2 & 31) << 10) | ((rn & 31) << 5) | (rt & 31)) >>> 0;
}

function encBl(pc, target) {
  const imm26 = Number(((BigInt(target) - BigInt(pc)) >> 2n) & 0x3ffffffn);
  return (0x94000000 | imm26) >>> 0;
}

function encB(pc, target) {
  const imm26 = Number(((BigInt(target) - BigInt(pc)) >> 2n) & 0x3ffffffn);
  return (0x14000000 | imm26) >>> 0;
}

function encBcond(pc, target, cond = 1) {
  const imm19 = Number(((BigInt(target) - BigInt(pc)) >> 2n) & 0x7ffffn);
  return (0x54000000 | (imm19 << 5) | (cond & 0xf)) >>> 0;
}

function encCbz64(rt, pc, target) {
  const imm19 = Number(((BigInt(target) - BigInt(pc)) >> 2n) & 0x7ffffn);
  return (0xb4000000 | (imm19 << 5) | (rt & 31)) >>> 0;
}

function encTbz(rt, bit, pc, target) {
  const imm14 = Number(((BigInt(target) - BigInt(pc)) >> 2n) & 0x3fffn);
  return (0x36000000 | (((bit >> 5) & 1) << 31) | ((bit & 31) << 19) | (imm14 << 5) | (rt & 31)) >>> 0;
}

function encLdrLit64(rt, pc, target) {
  const imm19 = Number(((BigInt(target) - BigInt(pc)) >> 2n) & 0x7ffffn);
  return (0x58000000 | (imm19 << 5) | (rt & 31)) >>> 0;
}

function encMovReg64(rd, rm) {
  return (0xaa0003e0 | ((rm & 31) << 16) | (rd & 31)) >>> 0;
}

function encBicClamp32(rd, rn) {
  // bic Wd, Wn, Wn, asr #31
  return (0x0aa07c00 | ((rn & 31) << 16) | ((rn & 31) << 5) | (rd & 31)) >>> 0;
}

/* ── File & VM Classic Worker Harnesses ─────────────────────── */

function makeFileFromBytes(name, bytes) {
  const raw = bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes);
  return {
    name,
    size: raw.length,
    slice(start, end) {
      const a = Math.max(0, Number(start || 0));
      const b = Math.min(raw.length, end == null ? raw.length : Number(end));
      const part = raw.subarray(a, b);
      return {
        arrayBuffer: async () => part.buffer.slice(part.byteOffset, part.byteOffset + part.byteLength),
      };
    },
  };
}

function wordsToBytes(words, endian = 'little') {
  const out = new Uint8Array(words.length * 4);
  const dv = new DataView(out.buffer);
  const le = endian !== 'big';
  for (let i = 0; i < words.length; i++) {
    dv.setUint32(i * 4, words[i] >>> 0, le);
  }
  return out;
}

/**
 * Isolated VM-loaded classic legacy worker (`js/worker.js` or standalone `js/worker-legacy.js`).
 */
function createClassicLegacyWorker({ standalone = false } = {}) {
  const pending = new Map();
  let seq = 1;
  const epoch = 1;
  const entryFile = path.join(JS_DIR, standalone ? 'worker-legacy.js' : 'worker.js');

  const sandbox = {
    console,
    setTimeout,
    clearTimeout,
    performance,
    TextDecoder,
    TextEncoder,
    URL,
    AbortController,
    AbortSignal,
    BigInt,
    BigUint64Array,
    BigInt64Array,
    Uint8Array,
    Int8Array,
    Uint16Array,
    Int16Array,
    Uint32Array,
    Int32Array,
    Float32Array,
    Float64Array,
    DataView,
    ArrayBuffer,
    Map,
    Set,
    WeakSet,
    WeakMap,
    Promise,
    Error,
    TypeError,
    RangeError,
    location: { href: pathToFileURL(entryFile).href },
  };
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;

  const ctx = vm.createContext(sandbox);

  function loadClassic(filePath) {
    if (/capstone\.js$/.test(filePath)) {
      vm.runInContext('globalThis.MCapstone = null;', ctx);
      return;
    }
    const src = fs.readFileSync(filePath, 'utf8');
    vm.runInContext(src, ctx, { filename: filePath });
  }

  sandbox.importScripts = (...paths) => {
    for (const rel of paths) {
      loadClassic(path.resolve(JS_DIR, rel));
    }
  };

  sandbox.postMessage = (msg) => {
    if (!msg || msg.id == null) return;
    const entry = pending.get(msg.id);
    if (!entry) return;
    pending.delete(msg.id);
    if (msg.t === 'ok') entry.resolve(msg.result);
    else entry.reject(new Error(msg.error || 'worker request failed'));
  };

  loadClassic(entryFile);

  function call(t, payload = {}) {
    const id = seq++;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      sandbox.onmessage({ data: { t, id, epoch, ...payload } });
    });
  }

  return {
    ctx,
    sandbox,
    call,
    evalInContext: (code) => vm.runInContext(code, ctx),
  };
}

/**
 * Isolated VM-loaded classic `js/scan-worker.js` implementing the Web Worker
 * interface (`postMessage`, `onmessage`, `onerror`, `terminate`) so it can be
 * driven directly by `ScanWorkerPool`!
 */
function createVmScanWorker() {
  const entryFile = path.join(JS_DIR, 'scan-worker.js');
  let terminated = false;
  const workerHandle = {
    onmessage: null,
    onerror: null,
    onmessageerror: null,
    postMessage(msg) {
      if (terminated) return;
      queueMicrotask(() => {
        if (terminated) return;
        try {
          sandbox.onmessage?.({ data: msg });
        } catch (err) {
          workerHandle.onerror?.({ message: err?.message || String(err), error: err });
        }
      });
    },
    terminate() {
      terminated = true;
    },
  };

  const sandbox = {
    console,
    setTimeout,
    clearTimeout,
    performance,
    TextDecoder,
    TextEncoder,
    URL,
    BigInt,
    BigUint64Array,
    BigInt64Array,
    Uint8Array,
    Int8Array,
    Uint16Array,
    Int16Array,
    Uint32Array,
    Int32Array,
    Float32Array,
    Float64Array,
    DataView,
    ArrayBuffer,
    Map,
    Set,
    WeakSet,
    WeakMap,
    Promise,
    Error,
    TypeError,
    RangeError,
    location: { href: pathToFileURL(entryFile).href },
    postMessage(msg) {
      if (terminated) return;
      queueMicrotask(() => {
        if (terminated) return;
        workerHandle.onmessage?.({ data: msg });
      });
    },
  };
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;

  const ctx = vm.createContext(sandbox);
  sandbox.importScripts = (...paths) => {
    for (const rel of paths) {
      const full = path.resolve(JS_DIR, rel);
      const src = fs.readFileSync(full, 'utf8');
      vm.runInContext(src, ctx, { filename: full });
    }
  };
  const src = fs.readFileSync(entryFile, 'utf8');
  vm.runInContext(src, ctx, { filename: entryFile });

  workerHandle.ctx = ctx;
  workerHandle.HexScanCore = sandbox.HexScanCore;
  return workerHandle;
}

/**
 * Helper to execute the full parallel `scanProgram` pipeline (plan -> Stage 1 ->
 * routeCrossChunkForwardTargets -> Stage 2 -> mergeChunkProgramScans) using real
 * VM-loaded `js/scan-worker.js` instances inside `ScanWorkerPool`.
 */
async function runParallelScanProgram({
  file,
  region,
  functionStarts,
  stringRanges = [],
  maxWorkers = 4,
  parallelThresholdBytes = 64,
  explicitChunks = null,
  callLimit,
  refLimit,
  kindLimit,
  chunkBudgetBytes = PROGRAM_INDEX_BUDGET_BYTES,
}) {
  const chunks = explicitChunks || planProgramChunks({
    region,
    functionStarts,
    maxWorkers,
    isMobile: false,
    parallelThresholdBytes,
  });
  assert.ok(chunks.length >= 2, `Expected >=2 chunks, got ${chunks.length}`);

  const pool = new ScanWorkerPool({
    maxWorkers,
    idleTimeoutMs: 50,
    workerFactory: createVmScanWorker,
  });

  try {
    const stage1Results = await Promise.all(chunks.map((chunk) => pool.runTask({
      t: 'scanStage1',
      epoch: 1,
      requestId: 1,
      payload: {
        file,
        region,
        chunkIndex: chunk.chunkIndex,
        chunkStart: chunk.chunkStart,
        chunkEnd: chunk.chunkEnd,
        functionStarts: chunk.functionStarts,
      },
    })));

    const incomingByChunk = routeCrossChunkForwardTargets(chunks, stage1Results);

    const words = Math.floor(Number(region.size) / 4);
    const globalCallCap = callLimit == null ? 8_000_000 : callLimit;
    const globalRefCap = refLimit == null ? 8_000_000 : refLimit;
    const globalKindCap = kindLimit == null ? 16 * 1024 * 1024 : kindLimit;

    const kinds = new Uint8Array(Math.min(words, globalKindCap));
    const stage2Results = [];
    let callsSoFar = 0;
    let refsSoFar = 0;

    // Ascending-order dispatch matching Backend wave semantics.
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      const s1 = stage1Results[i];
      const res = await pool.runTask({
        t: 'scanProgramChunk',
        epoch: 1,
        requestId: 2,
        payload: {
          file,
          region,
          chunkIndex: chunk.chunkIndex,
          chunkStart: chunk.chunkStart,
          chunkEnd: chunk.chunkEnd,
          functionStarts: chunk.functionStarts,
          incomingForwardTargets: incomingByChunk[i],
          loopKillAddrs: s1.loopKillAddrs,
          loopKillMasks: s1.loopKillMasks,
          stringRanges,
          callLimit: Math.max(0, globalCallCap - callsSoFar),
          refLimit: Math.max(0, globalRefCap - refsSoFar),
          globalKindCap,
          chunkBudgetBytes,
        },
      });
      if (res.kinds && res.kinds.length > 0) {
        const take = Math.min(res.kinds.length, Math.max(0, kinds.length - chunk.wordBase));
        if (take > 0) kinds.set(res.kinds.subarray(0, take), chunk.wordBase);
        res.kinds = null;
      }
      stage2Results.push(res);
      callsSoFar += res.callCount;
      refsSoFar += res.refCount;
    }

    const merged = mergeChunkProgramScans({
      region,
      chunks,
      chunkResults: stage2Results,
      kinds,
      callLimit,
      refLimit,
      kindLimit,
      memoryBudgetBytes: PROGRAM_INDEX_BUDGET_BYTES,
    });

    return { chunks, stage1Results, incomingByChunk, stage2Results, merged };
  } finally {
    pool.dispose();
  }
}

/**
 * Helper to execute the full parallel `valueShapes` pipeline using real
 * VM-loaded `js/scan-worker.js` instances inside `ScanWorkerPool`.
 */
async function runParallelValueShapes({
  file,
  region,
  maxWorkers = 4,
  parallelThresholdBytes = 64,
  maxEvents = MAX_SHAPE_EVENTS,
}) {
  const chunks = await planShapeChunks({
    file,
    region,
    maxWorkers,
    isMobile: false,
    parallelThresholdBytes,
  });
  assert.ok(chunks.length >= 2, `Expected >=2 shape chunks, got ${chunks.length}`);

  const pool = new ScanWorkerPool({
    maxWorkers,
    idleTimeoutMs: 50,
    workerFactory: createVmScanWorker,
  });

  try {
    const chunkResults = [];
    let eventsSoFar = 0;
    for (const chunk of chunks) {
      if (eventsSoFar >= maxEvents) break;
      const res = await pool.runTask({
        t: 'scanShapesChunk',
        epoch: 1,
        requestId: 10,
        payload: {
          file,
          region,
          chunkIndex: chunk.chunkIndex,
          chunkStart: chunk.chunkStart,
          chunkEnd: chunk.chunkEnd,
          shapeLimit: Math.max(0, maxEvents - eventsSoFar),
        },
      });
      chunkResults.push(res);
      eventsSoFar += res.count;
    }
    const merged = mergeChunkShapeScans({ region, chunkResults, maxEvents });
    return { chunks, chunkResults, merged };
  } finally {
    pool.dispose();
  }
}

function assertProgramScansBitExact(actual, expected, label) {
  assert.equal(actual.words, expected.words, `${label}: words`);
  assert.equal(actual.callCount, expected.callCount, `${label}: callCount`);
  assert.equal(actual.refCount, expected.refCount, `${label}: refCount`);
  assert.equal(actual.kindsCovered, expected.kindsCovered, `${label}: kindsCovered`);
  assert.equal(actual.callsCapped, expected.callsCapped, `${label}: callsCapped`);
  assert.equal(actual.refsCapped, expected.refsCapped, `${label}: refsCapped`);
  assert.equal(actual.complete, expected.complete, `${label}: complete`);
  assert.equal(actual.truncated, expected.truncated, `${label}: truncated`);
  assert.equal(actual.truncationReason, expected.truncationReason, `${label}: truncationReason`);
  // Normalize cross-realm VM arrays via Array.from before deepStrictEqual.
  assert.deepEqual(Array.from(actual.completeness.reasons), Array.from(expected.completeness.reasons), `${label}: completeness.reasons`);
  assert.equal(actual.completeness.complete, expected.completeness.complete, `${label}: completeness.complete`);

  assert.deepEqual(Array.from(actual.callFrom.subarray(0, actual.callCount)), Array.from(expected.callFrom.subarray(0, expected.callCount)), `${label}: callFrom`);
  assert.deepEqual(Array.from(actual.callTo.subarray(0, actual.callCount)), Array.from(expected.callTo.subarray(0, expected.callCount)), `${label}: callTo`);
  assert.deepEqual(Array.from(actual.refFrom.subarray(0, actual.refCount)), Array.from(expected.refFrom.subarray(0, expected.refCount)), `${label}: refFrom`);
  assert.deepEqual(Array.from(actual.refTo.subarray(0, actual.refCount)), Array.from(expected.refTo.subarray(0, expected.refCount)), `${label}: refTo`);
  assert.deepEqual(Array.from(actual.refKind.subarray(0, actual.refCount)), Array.from(expected.refKind.subarray(0, expected.refCount)), `${label}: refKind`);
  assert.deepEqual(Array.from(actual.kinds), Array.from(expected.kinds), `${label}: kinds`);
}

function assertValueShapesBitExact(actual, expected, label) {
  assert.equal(actual.count, expected.count, `${label}: count`);
  assert.equal(actual.capped, expected.capped, `${label}: capped`);
  for (const field of ['addr', 'disp', 'size', 'flags', 'amtKind', 'amtDisp', 'span', 'amtSize', 'amtSpan']) {
    assert.deepEqual(
      Array.from(actual[field].subarray(0, actual.count)),
      Array.from(expected[field].subarray(0, expected.count)),
      `${label}: ${field}`,
    );
  }
}

/* ── Synthetic ARM64 Fixture Builder for §3.1.1 ─────────────── */

function buildComprehensiveArm64Fixture() {
  const TOTAL_WORDS = 12_000;
  const VM_BASE = 0x100000000n;
  const CSTRING_VM = 0x100020000n;
  const CSTRING_SIZE = 0x1000n;
  const DATA_VM = 0x100030000n;

  const words = new Uint32Array(TOTAL_WORDS).fill(NOP);
  const pcOf = (idx) => VM_BASE + BigInt(idx * 4);
  const put = (idx, w) => { words[idx] = w >>> 0; };

  // Notice: NO functionStart at 0 so Chunk 0 begins with `currentFunctionStart == null`!
  const fnChunk0Body = 200; // Function inside Chunk 0 containing >4,096-insn ADRP pair
  const fnChunk1Start = 4500;
  const fnChunk2Start = 7000;
  const fnChunk3Start = 9500;

  // Unlisted forward targets inside [7000..9500) targeted by cross-chunk jumps from Chunk 0:
  const chunk2TargetBl = 7020;
  const chunk2TargetB = 7040;
  const chunk2TargetBcond = 7060;

  // --- Chunk 0 [0 .. 200): currentFunctionStart == null ---
  // 1) Chunk 0 backward conditional loop (B.NE) with clobbered base where currentFunctionStart == null:
  put(4, encAdrp(0, pcOf(4), DATA_VM));
  put(5, NOP);
  put(6, encAddImm64(1, 0, 0x20));                  // loop1: add x1, x0, #0x20 (x0 killed by loop!)
  put(7, encMovReg64(0, 2));                        // mov x0, x2 (clobbers x0)
  put(8, encBcond(pcOf(8), pcOf(6), 1));            // b.ne loop1

  // 2) Chunk 0 backward CBZ loop with clobbered base:
  put(12, encAdrp(3, pcOf(12), DATA_VM));
  put(13, NOP);
  put(14, encAddImm64(4, 3, 0x30));                 // loop2: add x4, x3, #0x30 (x3 killed!)
  put(15, encMovReg64(3, 5));
  put(16, encCbz64(6, pcOf(16), pcOf(14)));         // cbz x6, loop2

  // 3) #2117 unconditional backward B loop kill (reset AFTER edgeTargets.get(pc)):
  put(20, encAdrp(7, pcOf(20), DATA_VM));
  put(21, NOP);
  put(22, encAddImm64(8, 7, 0x40));                 // loop3: add x8, x7, #0x40 (x7 killed by B!)
  put(23, encMovReg64(7, 9));
  put(24, encB(pcOf(24), pcOf(22)));                // b loop3

  // 4) Backward loop with UNCHANGED base (provenance must survive):
  put(28, encAdrp(10, pcOf(28), DATA_VM));
  put(29, NOP);
  put(30, encAddImm64(11, 10, 0x50));               // loop4: add x11, x10, #0x50 (x10 unchanged -> KEEP ref)
  put(31, encBcond(pcOf(31), pcOf(30), 1));         // b.ne loop4

  // 5) Backward loop with SAME-VALUE rematerialization (provenance must survive):
  put(36, encAdrp(12, pcOf(36), DATA_VM));
  put(37, encAddImm64(12, 12, 0x60));
  put(38, encAddImm64(13, 12, 0x10));               // loop5: add x13, x12, #0x10 (-> DATA_VM + 0x70)
  put(39, encAdrp(12, pcOf(39), DATA_VM));
  put(40, encAddImm64(12, 12, 0x60));
  put(41, encBcond(pcOf(41), pcOf(38), 1));         // b.ne loop5

  // 6) Cross-chunk forward BL, B, and B.cond from Chunk 0 into Chunk 2 (skipping Chunk 1!):
  put(50, encBl(pcOf(50), pcOf(chunk2TargetBl)));
  put(51, encBcond(pcOf(51), pcOf(chunk2TargetBcond), 1));
  put(52, encB(pcOf(52), pcOf(chunk2TargetB)));

  // 7) All 5 __crossBinaryExactKind encodings + LDR literal + TBZ + SVC + BRK + RET:
  put(60, UDF_0);                                   // TRAP
  put(61, BICS_WZR_W0_W0);                          // LOGIC
  put(62, EXTR_W0_W0_W0_0);                         // SHIFT
  put(63, SCVTF_FIX_S0_W0);                         // FCONV
  put(64, SVE_ADD_Z0);                              // ARITH
  put(65, encLdrLit64(14, pcOf(65), pcOf(67)));     // LITERAL -> canonical LOAD (+ ref to pcOf(67))
  put(66, encTbz(14, 3, pcOf(66), pcOf(70)));       // CONDBR
  put(67, SVC_0);                                   // SYS
  put(68, BRK_0);                                   // TRAP
  put(69, RET);                                     // RET

  // --- [200 .. 4500): > 4,096-instruction ADRP -> ADD / LDR pair ---
  put(fnChunk0Body, encAdrp(20, pcOf(fnChunk0Body), DATA_VM));
  // 4,200 NOPs between word 200 and word 4401!
  put(4401, encAddImm64(21, 20, 0x80));             // >4,096 insns after ADRP -> DATA_VM + 0x80
  put(4402, encLdrUoff64(22, 20, 0x100));           // >4,096 insns after ADRP -> DATA_VM + 0x100
  put(4403, RET);

  // --- [4500 .. 7000): Supplemental memoryAccess string-ref filter & local loop ---
  put(fnChunk1Start, encAdrp(8, pcOf(fnChunk1Start), CSTRING_VM));
  put(fnChunk1Start + 1, encAddImm64(8, 8, 0x10));              // canonical ADD into __cstring -> KEEP
  put(fnChunk1Start + 2, encLdrUoff64(9, 8, 0x20));             // canonical LDR into __cstring -> KEEP
  put(fnChunk1Start + 3, encLdp64(0, 1, 8, 0x10));              // supplemental LDP into __cstring -> FILTERED!
  put(fnChunk1Start + 4, encAdrp(10, pcOf(fnChunk1Start + 4), DATA_VM));
  put(fnChunk1Start + 5, encAddImm64(10, 10, 0x20));
  put(fnChunk1Start + 6, encLdp64(2, 3, 10, 0x10));             // supplemental LDP into DATA_VM -> KEEP!
  put(fnChunk1Start + 7, encAdrp(2, pcOf(fnChunk1Start + 7), CSTRING_VM));
  put(fnChunk1Start + 8, encAddImm64(2, 2, 0x40));
  put(fnChunk1Start + 9, LDADD_X1_X0_X2);                       // supplemental LDADD into __cstring -> FILTERED!
  put(fnChunk1Start + 20, encAdrp(11, pcOf(fnChunk1Start + 20), DATA_VM));
  put(fnChunk1Start + 21, NOP);
  put(fnChunk1Start + 22, encAddImm64(12, 11, 0x90));           // loop in Chunk 1 (x11 killed)
  put(fnChunk1Start + 23, encMovReg64(11, 13));
  put(fnChunk1Start + 24, encBcond(pcOf(fnChunk1Start + 24), pcOf(fnChunk1Start + 22), 1));
  put(fnChunk1Start + 25, RET);

  // --- [7000 .. 9500): Incoming cross-chunk forward targets from Chunk 0 ---
  put(fnChunk2Start, encAdrp(19, pcOf(fnChunk2Start), DATA_VM));
  put(fnChunk2Start + 1, encAddImm64(0, 19, 0x10));             // before target -> KEEP ref
  put(chunk2TargetBl, encAddImm64(1, 19, 0x20));                // BL target -> x19 killed!
  put(chunk2TargetBl + 2, encAdrp(19, pcOf(chunk2TargetBl + 2), DATA_VM));
  put(chunk2TargetB, encAddImm64(2, 19, 0x30));                 // B target -> x19 killed!
  put(chunk2TargetB + 2, encAdrp(19, pcOf(chunk2TargetB + 2), DATA_VM));
  put(chunk2TargetBcond, encAddImm64(3, 19, 0x40));             // B.cond target -> x19 killed!
  put(chunk2TargetBcond + 1, RET);

  // --- [9500 .. 12000): Calls, refs, and mixed kinds ---
  put(fnChunk3Start, encAdrp(4, pcOf(fnChunk3Start), DATA_VM));
  put(fnChunk3Start + 1, encAddImm64(4, 4, 0x200));
  put(fnChunk3Start + 2, encBl(pcOf(fnChunk3Start + 2), pcOf(fnChunk1Start)));
  put(fnChunk3Start + 3, encBl(pcOf(fnChunk3Start + 3), pcOf(fnChunk2Start)));
  put(fnChunk3Start + 4, CAS_X0_X1_X2);
  put(fnChunk3Start + 5, RET);

  const bytes = wordsToBytes(words);
  const file = makeFileFromBytes('comprehensive-arm64.bin', bytes);
  const region = {
    id: 'text_0',
    name: '__TEXT,__text',
    section: '__text',
    segment: '__TEXT',
    fileOffset: 0n,
    vmAddr: VM_BASE,
    size: BigInt(bytes.length),
    exec: true,
    zerofill: false,
  };
  const cstringRegion = {
    id: 'cstring_0',
    name: '__TEXT,__cstring',
    section: '__cstring',
    segment: '__TEXT',
    fileOffset: 0n,
    vmAddr: CSTRING_VM,
    size: CSTRING_SIZE,
    exec: false,
    zerofill: false,
  };

  // Include both aligned functionStarts AND unaligned entries inside chunks!
  const functionStarts = [
    pcOf(fnChunk0Body),
    pcOf(100) + 2n,               // unaligned inside Chunk 0 (before fnChunk0Body)
    pcOf(fnChunk1Start),
    pcOf(fnChunk1Start + 50) + 2n, // unaligned inside Chunk 1
    pcOf(fnChunk2Start),
    pcOf(fnChunk2Start + 100) + 1n, // unaligned inside Chunk 2
    pcOf(fnChunk3Start),
    pcOf(fnChunk3Start + 50) + 3n, // unaligned inside Chunk 3
  ];

  // Explicit 4-chunk partition matching the 4 function boundaries for Chunk j -> Chunk j+2 testing!
  const explicit4Chunks = [
    [0, fnChunk1Start * 4],
    [fnChunk1Start * 4, fnChunk2Start * 4],
    [fnChunk2Start * 4, fnChunk3Start * 4],
    [fnChunk3Start * 4, TOTAL_WORDS * 4],
  ].map(([chunkStart, chunkEnd], chunkIndex) => {
    const startVm = VM_BASE + BigInt(chunkStart);
    const endVm = VM_BASE + BigInt(chunkEnd);
    return {
      chunkIndex,
      chunkStart,
      chunkEnd,
      startVm,
      endVm,
      wordBase: Math.floor(chunkStart / 4),
      words: Math.floor((chunkEnd - chunkStart) / 4),
      functionStarts: BigUint64Array.from(functionStarts.filter((a) => a >= startVm && a < endVm)),
    };
  });

  return {
    bytes,
    file,
    region,
    cstringRegion,
    functionStarts,
    explicit4Chunks,
    indices: {
      fnChunk0Body,
      fnChunk1Start,
      fnChunk2Start,
      fnChunk3Start,
      chunk2TargetBl,
      chunk2TargetB,
      chunk2TargetBcond,
      pcOf,
    },
    DATA_VM,
    CSTRING_VM,
  };
}

/**
 * Configures a VM classic worker with the given file, regions, and slice metadata.
 */
async function setupWorkerWithRegions(worker, { file, regions, functionStarts = [] }) {
  await worker.call('open', { file });
  await worker.call('setRegions', { regions });
  const sliceObj = {
    name: 'arm64',
    offset: 0n,
    size: BigInt(file.size),
    regions,
    functionStarts,
  };
  worker.sandbox.__testSlice = sliceObj;
  worker.evalInContext('slices = [globalThis.__testSlice]; delete globalThis.__testSlice;');
}

/* ── 1. Multi-chunk scanProgram bit-exactness vs single-worker baseline ── */

test('1.1 multi-chunk scanProgram bit-exactness vs single-worker baseline (planProgramChunks + 4-chunk j->j+2 routing + all §3.1 fixtures)', async () => {
  const fx = buildComprehensiveArm64Fixture();
  const worker = createClassicLegacyWorker({ standalone: false });
  await setupWorkerWithRegions(worker, {
    file: fx.file,
    regions: [fx.region, fx.cstringRegion],
    functionStarts: fx.functionStarts,
  });

  const baseline = await worker.call('scanProgram', { regionId: fx.region.id });
  const meta = await worker.call('getScanMeta', { regionId: fx.region.id });

  // A) Verify planProgramChunks splits ONLY on 4-byte aligned candidates while
  //    preserving ALL [chunkStartVm, chunkEndVm) entries (including unaligned ones)!
  const planned = await runParallelScanProgram({
    file: fx.file,
    region: meta.region,
    functionStarts: meta.functionStarts,
    stringRanges: meta.stringRanges,
    maxWorkers: 4,
    parallelThresholdBytes: 1024,
  });
  for (const chunk of planned.chunks) {
    assert.equal(chunk.chunkStart % 4, 0, 'chunkStart must be 4-byte aligned');
    assert.equal(chunk.chunkEnd % 4, 0, 'chunkEnd must be 4-byte aligned');
  }
  const preservedUnaligned = planned.chunks
    .flatMap((c) => Array.from(c.functionStarts))
    .filter((a) => ((a - fx.region.vmAddr) & 3n) !== 0n);
  assert.equal(preservedUnaligned.length, 4, 'all 4 unaligned functionStarts must be preserved in chunk payloads');
  assertProgramScansBitExact(planned.merged, baseline, 'planned multi-chunk scanProgram');

  // B) Verify 4-chunk execution where Chunk 0 jumps directly into Chunk 2 (skipping Chunk 1!)
  //    via BL, B, AND B.cond (routeCrossChunkForwardTargets j -> j+2):
  const { incomingByChunk, merged } = await runParallelScanProgram({
    file: fx.file,
    region: meta.region,
    functionStarts: meta.functionStarts,
    stringRanges: meta.stringRanges,
    explicitChunks: fx.explicit4Chunks,
    maxWorkers: 4,
  });

  const incomingChunk1 = Array.from(incomingByChunk[1]);
  const incomingChunk2 = Array.from(incomingByChunk[2]);
  assert.equal(incomingChunk1.length, 0, 'Chunk 1 must not receive Chunk 0 -> Chunk 2 forward targets');
  assert.deepEqual(incomingChunk2, [
    fx.indices.pcOf(fx.indices.chunk2TargetBl),
    fx.indices.pcOf(fx.indices.chunk2TargetB),
    fx.indices.pcOf(fx.indices.chunk2TargetBcond),
  ], 'Chunk 2 must receive all 3 cross-chunk forward targets (BL, B, B.cond) from Chunk 0');

  // Verify >4,096-instruction ADRP -> ADD/LDR pair was resolved in BOTH baseline and parallel!
  const refPairs = Array.from({ length: merged.refCount }, (_, i) => [merged.refFrom[i], merged.refTo[i], merged.refKind[i]]);
  assert.ok(
    refPairs.some(([from, to, kind]) => from === fx.indices.pcOf(4401) && to === fx.DATA_VM + 0x80n && kind === 0),
    'ADRP->ADD >4,096 insns apart must be resolved',
  );
  assert.ok(
    refPairs.some(([from, to, kind]) => from === fx.indices.pcOf(4402) && to === fx.DATA_VM + 0x100n && kind === 1),
    'ADRP->LDR >4,096 insns apart must be resolved',
  );

  // Verify Chunk 0 backward loops (B.NE, CBZ, #2117 unconditional B) killed clobbered bases,
  // while unchanged & rematerialized loops survived:
  assert.ok(!refPairs.some(([from]) => from === fx.indices.pcOf(6)), 'Chunk 0 B.NE clobber with currentFunctionStart==null must kill x0');
  assert.ok(!refPairs.some(([from]) => from === fx.indices.pcOf(14)), 'Chunk 0 CBZ clobber must kill x3');
  assert.ok(!refPairs.some(([from]) => from === fx.indices.pcOf(22)), '#2117 unconditional backward B clobber must kill x7');
  assert.ok(refPairs.some(([from, to]) => from === fx.indices.pcOf(30) && to === fx.DATA_VM + 0x50n), 'unchanged loop base must survive');
  assert.ok(refPairs.some(([from, to]) => from === fx.indices.pcOf(38) && to === fx.DATA_VM + 0x70n), 'same-value rematerialized loop base must survive');

  // Verify cross-chunk forward targets invalidated x19 in Chunk 2:
  assert.ok(refPairs.some(([from]) => from === fx.indices.pcOf(fx.indices.fnChunk2Start + 1)), 'pre-target x19 ref must exist');
  assert.ok(!refPairs.some(([from]) => from === fx.indices.pcOf(fx.indices.chunk2TargetBl)), 'BL forward target from Chunk 0 must kill x19');
  assert.ok(!refPairs.some(([from]) => from === fx.indices.pcOf(fx.indices.chunk2TargetB)), 'B forward target from Chunk 0 must kill x19');
  assert.ok(!refPairs.some(([from]) => from === fx.indices.pcOf(fx.indices.chunk2TargetBcond)), 'B.cond forward target from Chunk 0 must kill x19');

  // Verify supplemental string-ref filter: LDP & LDADD to __cstring dropped, LDP to DATA_VM kept, canonical ADD/LDR to __cstring kept:
  assert.ok(refPairs.some(([from]) => from === fx.indices.pcOf(fx.indices.fnChunk1Start + 1)), 'canonical ADD to __cstring must be kept');
  assert.ok(refPairs.some(([from]) => from === fx.indices.pcOf(fx.indices.fnChunk1Start + 2)), 'canonical LDR to __cstring must be kept');
  assert.ok(!refPairs.some(([from]) => from === fx.indices.pcOf(fx.indices.fnChunk1Start + 3)), 'supplemental LDP to __cstring must be filtered');
  assert.ok(refPairs.some(([from, to]) => from === fx.indices.pcOf(fx.indices.fnChunk1Start + 6) && to === fx.DATA_VM + 0x30n), 'supplemental LDP to non-string DATA_VM must be kept');
  assert.ok(!refPairs.some(([from]) => from === fx.indices.pcOf(fx.indices.fnChunk1Start + 9)), 'supplemental LDADD to __cstring must be filtered');

  // Verify all 5 __crossBinaryExactKind encodings + LDR literal -> LOAD:
  const K = worker.sandbox.Words.KIND;
  assert.equal(merged.kinds[60], K.TRAP, 'UDF #0 -> TRAP');
  assert.equal(merged.kinds[61], K.LOGIC, 'BICS WZR -> LOGIC');
  assert.equal(merged.kinds[62], K.SHIFT, 'EXTR/ROR -> SHIFT');
  assert.equal(merged.kinds[63], K.FCONV, 'fixed-point SCVTF -> FCONV');
  assert.equal(merged.kinds[64], K.ARITH, 'SVE predicated ADD -> ARITH');
  assert.equal(merged.kinds[65], K.LOAD, 'LDR literal -> canonical LOAD');

  // Full bit-exact comparison against single-worker baseline!
  assertProgramScansBitExact(merged, baseline, '4-chunk j->j+2 scanProgram');
});

test('1.2 straddling-chunk kindLimit dual indexing parity (chunkWordBase + localIndex vs localIndex)', async () => {
  const fx = buildComprehensiveArm64Fixture();
  const worker = createClassicLegacyWorker({ standalone: false });
  await setupWorkerWithRegions(worker, {
    file: fx.file,
    regions: [fx.region, fx.cstringRegion],
    functionStarts: fx.functionStarts,
  });

  // Chunk 1 spans wordBase=4500..7000; choose kindLimit=5000 right in the middle of Chunk 1!
  const kindLimit = 5000;
  const baseline = await worker.call('scanProgram', { regionId: fx.region.id, kindLimit });
  const meta = await worker.call('getScanMeta', { regionId: fx.region.id });
  const { merged } = await runParallelScanProgram({
    file: fx.file,
    region: meta.region,
    functionStarts: meta.functionStarts,
    stringRanges: meta.stringRanges,
    explicitChunks: fx.explicit4Chunks,
    maxWorkers: 4,
    kindLimit,
  });

  assert.equal(merged.kinds.length, kindLimit);
  assert.equal(merged.kindsCovered, kindLimit);
  assert.equal(merged.complete, false);
  assert.equal(merged.truncationReason, 'kind-stat-budget');
  assertProgramScansBitExact(merged, baseline, 'straddling kindLimit');
});

test('1.3 supplemental memoryAccess uint64 wraparound (BigInt.asUintN(64, full)) string-ref filter parity', async () => {
  // Place code near the top of 64-bit address space so ADR produces 0xfffffffffffffff0n,
  // and LDP [x8, #0x20] computes full = 0x10000000000000010n -> BigInt.asUintN(64, full) = 0x10n,
  // which lands inside __cstring at [0x0n, 0x100n)!
  const VM_BASE = 0xfffffffffffff000n;
  const words = new Uint32Array(256).fill(NOP);
  const pcOf = (i) => VM_BASE + BigInt(i * 4);
  words[0] = encAdr(8, pcOf(0), 0xfffffffffffffff0n);
  words[1] = encLdp64(0, 1, 8, 0x20);   // wraps to 0x10n (inside __cstring -> FILTERED!)
  words[2] = encLdp64(2, 3, 8, 0x120);  // wraps to 0x110n (outside __cstring -> KEPT!)
  words[3] = RET;
  words[128] = encAdr(8, pcOf(128), 0xfffffffffffffff0n);
  words[129] = encLdp64(0, 1, 8, 0x20);  // wraps to 0x10n -> FILTERED
  words[130] = encLdp64(2, 3, 8, 0x120); // wraps to 0x110n -> KEPT
  words[131] = RET;

  const bytes = wordsToBytes(words);
  const file = makeFileFromBytes('wrap64.bin', bytes);
  const region = {
    id: 'text_wrap',
    section: '__text',
    segment: '__TEXT',
    fileOffset: 0n,
    vmAddr: VM_BASE,
    size: BigInt(bytes.length),
    exec: true,
    zerofill: false,
  };
  const cstringRegion = {
    id: 'cstring_low',
    section: '__cstring',
    segment: '__TEXT',
    fileOffset: 0n,
    vmAddr: 0n,
    size: 0x100n,
    exec: false,
    zerofill: false,
  };

  const worker = createClassicLegacyWorker({ standalone: false });
  await setupWorkerWithRegions(worker, {
    file,
    regions: [region, cstringRegion],
    functionStarts: [pcOf(0), pcOf(128)],
  });

  const baseline = await worker.call('scanProgram', { regionId: region.id });
  const meta = await worker.call('getScanMeta', { regionId: region.id });
  const { merged } = await runParallelScanProgram({
    file,
    region: meta.region,
    functionStarts: meta.functionStarts,
    stringRanges: meta.stringRanges,
    maxWorkers: 2,
    parallelThresholdBytes: 64,
  });

  const refFroms = Array.from(merged.refFrom);
  assert.ok(!refFroms.includes(pcOf(1)), 'wrapped LDP targeting [0x0n, 0x100n) __cstring must be filtered');
  assert.ok(refFroms.includes(pcOf(2)), 'wrapped LDP targeting 0x110n outside __cstring must be kept');
  assert.ok(!refFroms.includes(pcOf(129)), 'chunk 1 wrapped LDP targeting __cstring must be filtered');
  assert.ok(refFroms.includes(pcOf(130)), 'chunk 1 wrapped LDP outside __cstring must be kept');
  assertProgramScansBitExact(merged, baseline, 'uint64 wraparound string-ref filter');
});

test('1.4 standalone worker-legacy.js keeps 0B canonical-kind inlining gated when worker-kind-fix.js is not loaded', async () => {
  const words = new Uint32Array([
    UDF_0,
    BICS_WZR_W0_W0,
    EXTR_W0_W0_W0_0,
    SCVTF_FIX_S0_W0,
    SVE_ADD_Z0,
    encLdrLit64(0, 0x1000n + 20n, 0x1000n + 28n),
    RET,
    NOP,
  ]);
  const bytes = wordsToBytes(words);
  const file = makeFileFromBytes('kind-gate.bin', bytes);
  const region = {
    id: 'text_kind',
    section: '__text',
    segment: '__TEXT',
    fileOffset: 0n,
    vmAddr: 0x1000n,
    size: BigInt(bytes.length),
    exec: true,
    zerofill: false,
  };

  const standaloneWorker = createClassicLegacyWorker({ standalone: true });
  await setupWorkerWithRegions(standaloneWorker, { file, regions: [region] });
  const standaloneScan = await standaloneWorker.call('scanProgram', { regionId: region.id });

  const fullWorker = createClassicLegacyWorker({ standalone: false });
  await setupWorkerWithRegions(fullWorker, { file, regions: [region] });
  const fullScan = await fullWorker.call('scanProgram', { regionId: region.id });

  const K = standaloneWorker.sandbox.Words.KIND;
  assert.equal(standaloneScan.kinds[5], K.LITERAL, 'standalone worker-legacy.js must preserve KIND.LITERAL');
  assert.equal(fullScan.kinds[5], K.LOAD, 'full worker.js must canonicalize LITERAL -> LOAD');
  assert.equal(fullScan.kinds[0], K.TRAP, 'full worker.js must canonicalize UDF #0 -> TRAP');
  assert.equal(fullScan.kinds[1], K.LOGIC, 'full worker.js must canonicalize BICS WZR -> LOGIC');
  assert.equal(fullScan.kinds[2], K.SHIFT, 'full worker.js must canonicalize EXTR -> SHIFT');
  assert.equal(fullScan.kinds[3], K.FCONV, 'full worker.js must canonicalize fixed-point SCVTF -> FCONV');
  assert.equal(fullScan.kinds[4], K.ARITH, 'full worker.js must canonicalize SVE ADD -> ARITH');
  assert.notEqual(standaloneScan.kinds[0], K.TRAP, 'standalone worker-legacy.js must NOT apply __crossBinaryExactKind');
});

test('1.5 dataInCode ranges skipped in scanProgram (with unaligned span reason) and preserved in valueShapes', async () => {
  const VM_BASE = 0x10000n;
  const words = new Uint32Array(64).fill(NOP);
  const pcOf = (i) => VM_BASE + BigInt(i * 4);
  words[0] = encBl(pcOf(0), pcOf(20));
  words[8] = encBl(pcOf(8), pcOf(20));
  words[9] = encLdrUoff32(8, 19, 0x20);
  words[10] = encSubImm32(8, 8, 1);
  words[11] = encStrUoff32(8, 19, 0x20);
  words[12] = RET;
  words[20] = encBl(pcOf(20), pcOf(30));
  words[21] = encLdrUoff32(9, 19, 0x40);
  words[22] = encAddImm32(9, 9, 5);
  words[23] = encStrUoff32(9, 19, 0x40);
  words[24] = RET;

  const bytes = wordsToBytes(words);
  const file = makeFileFromBytes('dic.bin', bytes);
  const region = {
    id: 'text_dic',
    section: '__text',
    segment: '__TEXT',
    fileOffset: 0n,
    vmAddr: VM_BASE,
    size: BigInt(bytes.length),
    exec: true,
    zerofill: false,
    dataInCode: [
      { address: pcOf(8), length: 20 },
      { address: pcOf(13) + 2n, length: 2 },
    ],
  };

  const worker = createClassicLegacyWorker({ standalone: false });
  await setupWorkerWithRegions(worker, { file, regions: [region], functionStarts: [pcOf(0), pcOf(20)] });

  const meta = await worker.call('getScanMeta', { regionId: region.id });
  assert.equal(meta.hasDataInCode, true, 'getScanMeta must flag hasDataInCode: true');

  const scan = await worker.call('scanProgram', { regionId: region.id });
  const callFroms = Array.from(scan.callFrom);
  assert.ok(callFroms.includes(pcOf(0)), 'code before dataInCode must be scanned');
  assert.ok(!callFroms.includes(pcOf(8)), 'BL inside dataInCode must be skipped');
  assert.ok(callFroms.includes(pcOf(20)), 'code after dataInCode must be scanned');
  assert.ok(
    scan.completeness.reasons.includes('aarch64-code-span-not-word-aligned'),
    'sub-4-byte code span must report aarch64-code-span-not-word-aligned',
  );

  const baselineShapes = await worker.call('valueShapes', { regionId: region.id });
  const { merged: parallelShapes } = await runParallelValueShapes({
    file,
    region: meta.region,
    maxWorkers: 2,
    parallelThresholdBytes: 64,
  });
  assert.deepEqual(
    Array.from(baselineShapes.addr),
    [pcOf(11), pcOf(23)],
    'valueShapes must preserve events inside dataInCode',
  );
  assertValueShapesBitExact(parallelShapes, baselineShapes, 'valueShapes with dataInCode');
});

/* ── 2. valueShapes bit-exactness vs single-worker baseline ─── */

test('2.1 valueShapes bit-exactness: BL;RET forgetAll pAmtKind clear, callee-saved x19 across BL, clamp & atomic RMW', async () => {
  const VM_BASE = 0x200000n;
  const words = new Uint32Array(512).fill(NOP);
  const pcOf = (i) => VM_BASE + BigInt(i * 4);

  words[10] = encLdrUoff32(19, 20, 0x10);
  words[11] = encBl(pcOf(11), pcOf(300));
  words[12] = encSubReg32(19, 19, 0);
  words[13] = encBicClamp32(19, 19);
  words[14] = encStrUoff32(19, 20, 0x10);
  words[254] = encBl(pcOf(254), pcOf(300));
  words[255] = RET;

  words[256] = encLdrUoff32(8, 19, 0x20);
  words[257] = encSubReg32(8, 8, 0);
  words[258] = encStrUoff32(8, 19, 0x20);
  words[260] = encLdrUoff32(8, 21, 0x30);
  words[261] = encLdrUoff32(9, 22, 0x08);
  words[262] = encSubReg32(8, 8, 9);
  words[263] = encStrUoff32(8, 21, 0x30);
  words[264] = LDADD_X1_X0_X2;
  words[265] = RET;

  const bytes = wordsToBytes(words);
  const file = makeFileFromBytes('shapes-bl-ret.bin', bytes);
  const region = {
    id: 'text_shapes',
    section: '__text',
    segment: '__TEXT',
    fileOffset: 0n,
    vmAddr: VM_BASE,
    size: BigInt(bytes.length),
    exec: true,
    zerofill: false,
  };

  const worker = createClassicLegacyWorker({ standalone: false });
  await setupWorkerWithRegions(worker, { file, regions: [region] });
  const baseline = await worker.call('valueShapes', { regionId: region.id });
  const { chunks, merged } = await runParallelValueShapes({
    file,
    region,
    maxWorkers: 2,
    parallelThresholdBytes: 64,
  });

  assert.equal(chunks[1].chunkStart, 256 * 4, 'chunk 1 must snap immediately after BL; RET');
  assert.equal(merged.count, 4, 'should record all 4 shape events');
  assert.equal(merged.amtKind[0], 3, 'event 0 after BL (no RET) must have AMT_CALL (3)');
  assert.equal(merged.amtKind[1], 0, 'event 1 after BL; RET must have AMT_NONE (0), no pAmtKind bleed');
  assertValueShapesBitExact(merged, baseline, 'valueShapes BL;RET + callee-saved');
});

test('2.2 valueShapes with non-zero region.fileOffset (fat Mach-O slice) reads at fileOffset + winStart..winEnd', async () => {
  const FILE_OFFSET = 0x4000;
  const SLICE_WORDS = 512;
  const SLICE_BYTES = SLICE_WORDS * 4;
  const VM_BASE = 0x100004000n;

  const whole = new Uint8Array(FILE_OFFSET + SLICE_BYTES);
  const dvPrefix = new DataView(whole.buffer, 0, FILE_OFFSET);
  for (let off = 0; off < FILE_OFFSET; off += 4) dvPrefix.setUint32(off, RET, true);

  const sliceWords = new Uint32Array(SLICE_WORDS).fill(NOP);
  sliceWords[10] = encLdrUoff32(8, 19, 0x10);
  sliceWords[11] = encAddImm32(8, 8, 4);
  sliceWords[12] = encStrUoff32(8, 19, 0x10);
  sliceWords[200] = RET;
  sliceWords[300] = encLdrUoff32(9, 20, 0x24);
  sliceWords[301] = encSubImm32(9, 9, 2);
  sliceWords[302] = encStrUoff32(9, 20, 0x24);
  sliceWords[303] = RET;
  whole.set(wordsToBytes(sliceWords), FILE_OFFSET);

  const file = makeFileFromBytes('fat-slice-shapes.bin', whole);
  const region = {
    id: 'fat_text',
    section: '__text',
    segment: '__TEXT',
    fileOffset: BigInt(FILE_OFFSET),
    vmAddr: VM_BASE,
    size: BigInt(SLICE_BYTES),
    exec: true,
    zerofill: false,
  };

  const worker = createClassicLegacyWorker({ standalone: false });
  await setupWorkerWithRegions(worker, { file, regions: [region] });
  const baseline = await worker.call('valueShapes', { regionId: region.id });
  const { chunks, merged } = await runParallelValueShapes({
    file,
    region,
    maxWorkers: 2,
    parallelThresholdBytes: 64,
  });

  assert.equal(chunks[1].chunkStart, 201 * 4, 'planShapeChunks must snap to word 201 using region.fileOffset');
  assert.equal(merged.count, 2);
  assertValueShapesBitExact(merged, baseline, 'valueShapes non-zero fileOffset');
});

test('2.3 valueShapes chunk boundary with no RET/B/BR in 64 KiB window merges/dedups cleanly', async () => {
  const SIZE_BYTES = 256 * 1024;
  const WORDS = SIZE_BYTES / 4;
  const allNops = new Uint32Array(WORDS).fill(NOP);
  const region = {
    id: 'no_term',
    section: '__text',
    segment: '__TEXT',
    fileOffset: 0n,
    vmAddr: 0x300000n,
    size: BigInt(SIZE_BYTES),
    exec: true,
    zerofill: false,
  };

  const emptyChunks = await planShapeChunks({
    file: makeFileFromBytes('no-term.bin', wordsToBytes(allNops)),
    region,
    maxWorkers: 4,
    isMobile: false,
    parallelThresholdBytes: 64,
  });
  assert.deepEqual(emptyChunks, [], 'no RET/B/BR in any 64 KiB window must return []');

  const VIRTUAL_SIZE = 36 * 1024 * 1024;
  const virtualFile = {
    name: 'virtual-36m.bin',
    size: VIRTUAL_SIZE,
    slice(start, end) {
      const a = Number(start);
      const b = Number(end);
      const len = Math.max(0, b - a);
      const buf = new Uint8Array(len);
      const dv = new DataView(buf.buffer);
      for (let off = 0; off + 4 <= len; off += 4) dv.setUint32(off, NOP, true);
      const retOff = 24 * 1024 * 1024 - 8;
      if (retOff >= a && retOff + 4 <= b) {
        dv.setUint32(retOff - a, RET, true);
      }
      return { arrayBuffer: async () => buf.buffer };
    },
  };
  const virtualRegion = { ...region, size: BigInt(VIRTUAL_SIZE) };
  const partialChunks = await planShapeChunks({
    file: virtualFile,
    region: virtualRegion,
    maxWorkers: 4,
    isMobile: false,
    parallelThresholdBytes: 16 * 1024 * 1024,
  });

  assert.equal(partialChunks.length, 2, 'missing terminator at split 1 must merge cleanly into 2 valid chunks');
  assert.equal(partialChunks[0].chunkStart, 0);
  assert.equal(partialChunks[0].chunkEnd, 24 * 1024 * 1024 - 4);
  assert.equal(partialChunks[1].chunkStart, partialChunks[0].chunkEnd);
  assert.equal(partialChunks[1].chunkEnd, VIRTUAL_SIZE);
  for (const c of partialChunks) {
    assert.ok(c.chunkEnd > c.chunkStart, 'no zero-length chunks');
  }
});

test('2.4 MAX_SHAPE_EVENTS capping semantics (totalEvents >= maxEvents || anyChunkCapped)', async () => {
  const region = { id: 'cap_shapes', vmAddr: 0x1000n, size: 1024n, fileOffset: 0n };
  const makeChunk = (chunkIndex, count, capped = false) => ({
    chunkIndex,
    count,
    capped,
    addr: new BigUint64Array(count).map((_, i) => 0x1000n + BigInt(chunkIndex * 100 + i * 4)),
    disp: new Int32Array(count).fill(0x20),
    size: new Uint8Array(count).fill(4),
    flags: new Uint8Array(count).fill(1),
    amtKind: new Uint8Array(count).fill(2),
    amtDisp: new Int32Array(count).fill(0),
    span: new Int32Array(count).fill(0x20),
    amtSize: new Uint8Array(count).fill(0),
    amtSpan: new Int32Array(count).fill(0),
  });

  const below = mergeChunkShapeScans({ region, chunkResults: [makeChunk(0, 4), makeChunk(1, 5)], maxEvents: 10 });
  assert.equal(below.count, 9);
  assert.equal(below.capped, false, 'totalEvents < maxEvents with no chunk capped must not be capped');

  const exact = mergeChunkShapeScans({ region, chunkResults: [makeChunk(0, 5), makeChunk(1, 5)], maxEvents: 10 });
  assert.equal(exact.count, 10);
  assert.equal(exact.capped, true, 'totalEvents === maxEvents must set capped: true (>= semantics)');

  const over = mergeChunkShapeScans({ region, chunkResults: [makeChunk(0, 6), makeChunk(1, 6)], maxEvents: 10 });
  assert.equal(over.count, 10);
  assert.equal(over.capped, true, 'totalEvents > maxEvents must clamp count and set capped: true');

  const chunkFlagged = mergeChunkShapeScans({ region, chunkResults: [makeChunk(0, 3, true), makeChunk(1, 2, false)], maxEvents: 10 });
  assert.equal(chunkFlagged.count, 5);
  assert.equal(chunkFlagged.capped, true, 'anyChunkCapped must propagate capped: true');
});

/* ── 3. Budget, cap semantics, and zero-copy mergeProgramScans ── */

test('3.1 budgetCapped triggers fail-fast without conflating with callsLimitCapped/refsLimitCapped', async () => {
  const vmWorker = createVmScanWorker();
  const { HexScanCore } = vmWorker;
  const VM_BASE = 0x400000n;
  const WORDS = 512;
  const words = new Uint32Array(WORDS);
  for (let i = 0; i < WORDS; i++) {
    words[i] = encBl(VM_BASE + BigInt(i * 4), VM_BASE + BigInt(((i + 1) % WORDS) * 4));
  }
  const bytes = wordsToBytes(words);
  const file = makeFileFromBytes('budget-cap.bin', bytes);
  const region = { id: 'text_budget', vmAddr: VM_BASE, size: BigInt(bytes.length), fileOffset: 0n };

  const budgetRes = await HexScanCore.scanProgramChunk({
    file,
    region,
    chunkIndex: 0,
    chunkStart: 0,
    chunkEnd: bytes.length,
    functionStarts: [],
    globalKindCap: WORDS,
    callLimit: 10_000,
    refLimit: 10_000,
    chunkBudgetBytes: 512 + 600,
  });
  assert.equal(budgetRes.budgetCapped, true, 'tight chunkBudgetBytes must set budgetCapped: true');
  assert.equal(budgetRes.callsLimitCapped, false, 'budget exhaustion must NOT conflate with callsLimitCapped');
  assert.equal(budgetRes.refsLimitCapped, false, 'budget exhaustion must NOT conflate with refsLimitCapped');

  const zeroLimitRes = await HexScanCore.scanProgramChunk({
    file,
    region,
    chunkIndex: 0,
    chunkStart: 0,
    chunkEnd: bytes.length,
    functionStarts: [],
    globalKindCap: WORDS,
    callLimit: 0,
    refLimit: 10_000,
    chunkBudgetBytes: PROGRAM_INDEX_BUDGET_BYTES,
  });
  assert.equal(zeroLimitRes.callCount, 0);
  assert.equal(zeroLimitRes.callsLimitCapped, true, 'callLimit === 0 with calls present must set callsLimitCapped: true');
  assert.equal(zeroLimitRes.budgetCapped, false, 'callLimit === 0 must NOT set budgetCapped');

  assert.equal(computeWaveConcurrency({ remainingBudget: 100 * 1024 * 1024, maxWaveWorkers: 4, isMobile: false }), 4);
  assert.equal(computeWaveConcurrency({ remainingBudget: 60 * 1024 * 1024, maxWaveWorkers: 4, isMobile: false }), 2);
  assert.equal(computeWaveConcurrency({ remainingBudget: 30 * 1024 * 1024, maxWaveWorkers: 4, isMobile: false }), 1);
  assert.equal(computeWaveConcurrency({ remainingBudget: 50 * 1024 * 1024, maxWaveWorkers: 2, isMobile: true }), 2);
  assert.equal(computeWaveConcurrency({ remainingBudget: 30 * 1024 * 1024, maxWaveWorkers: 2, isMobile: true }), 1);
  assert.equal(computeWaveConcurrency({ remainingBudget: 100 * 1024 * 1024, maxWaveWorkers: 4, hidden: true }), 1);

  vmWorker.terminate();
});

test('3.2 strict > check for callsCapped and refsCapped at exact limit vs limit + 1', async () => {
  const VM_BASE = 0x500000n;
  const words = new Uint32Array(256).fill(NOP);
  const pcOf = (i) => VM_BASE + BigInt(i * 4);
  words[0] = encBl(pcOf(0), pcOf(128));
  words[1] = encBl(pcOf(1), pcOf(128));
  words[2] = encBl(pcOf(2), pcOf(128));
  words[3] = encAdr(0, pcOf(3), pcOf(200));
  words[4] = encAdr(1, pcOf(4), pcOf(204));
  words[5] = RET;

  words[128] = encBl(pcOf(128), pcOf(0));
  words[129] = encBl(pcOf(129), pcOf(0));
  words[130] = encBl(pcOf(130), pcOf(0));
  words[131] = encAdr(2, pcOf(131), pcOf(208));
  words[132] = encAdr(3, pcOf(132), pcOf(212));
  words[133] = RET;

  const bytes = wordsToBytes(words);
  const file = makeFileFromBytes('exact-caps.bin', bytes);
  const region = { id: 'text_caps', section: '__text', segment: '__TEXT', fileOffset: 0n, vmAddr: VM_BASE, size: BigInt(bytes.length), exec: true, zerofill: false };
  const functionStarts = [pcOf(0), pcOf(128)];

  const worker = createClassicLegacyWorker({ standalone: false });
  await setupWorkerWithRegions(worker, { file, regions: [region], functionStarts });

  const baseExact = await worker.call('scanProgram', { regionId: region.id, callLimit: 6, refLimit: 4 });
  const parExact = (await runParallelScanProgram({
    file, region, functionStarts, maxWorkers: 2, parallelThresholdBytes: 64, callLimit: 6, refLimit: 4,
  })).merged;
  assert.equal(parExact.callCount, 6);
  assert.equal(parExact.refCount, 4);
  assert.equal(parExact.callsCapped, false, 'totalCalls === callLimit must NOT be callsCapped');
  assert.equal(parExact.refsCapped, false, 'totalRefs === refLimit must NOT be refsCapped');
  assert.equal(parExact.complete, true);
  assertProgramScansBitExact(parExact, baseExact, 'exact limit (not capped)');

  const baseOver = await worker.call('scanProgram', { regionId: region.id, callLimit: 5, refLimit: 3 });
  const parOver = (await runParallelScanProgram({
    file, region, functionStarts, maxWorkers: 2, parallelThresholdBytes: 64, callLimit: 5, refLimit: 3,
  })).merged;
  assert.equal(parOver.callCount, 5);
  assert.equal(parOver.refCount, 3);
  assert.equal(parOver.callsCapped, true, 'totalCalls === callLimit + 1 MUST set callsCapped');
  assert.equal(parOver.refsCapped, true, 'totalRefs === refLimit + 1 MUST set refsCapped');
  assert.equal(parOver.complete, false);
  assertProgramScansBitExact(parOver, baseOver, 'limit + 1 (capped)');
});

test('3.3 zero-copy mergeProgramScans fast path + cross-realm vm TypedArray & plain JS array parity', () => {
  const callFrom = new BigUint64Array([0x1000n, 0x1004n]);
  const callTo = new BigUint64Array([0x2000n, 0x2004n]);
  const refFrom = new BigUint64Array([0x1008n, 0x100cn, 0x9999n]);
  const refTo = new BigUint64Array([0x3000n, 0x3004n, 0x9999n]);
  const refKind = new Uint8Array([0, 1, 9]);
  const kinds = new Uint8Array([19, 19, 2, 5]);
  const sameRealmScan = {
    regionId: 'r0',
    vmAddr: 0x1000n,
    words: 4,
    callFrom,
    callTo,
    callCount: 2,
    refFrom,
    refTo,
    refKind,
    refCount: 2,
    kinds,
    kindsCovered: 4,
    complete: true,
  };

  const mergedFast = mergeProgramScans([sameRealmScan]);
  assert.strictEqual(mergedFast.callFrom, callFrom, 'exact-length callFrom must be zero-copy identical reference');
  assert.strictEqual(mergedFast.callTo, callTo, 'exact-length callTo must be zero-copy identical reference');
  assert.strictEqual(mergedFast.refFrom.buffer, refFrom.buffer, 'trimmed refFrom must be zero-copy subarray');
  assert.equal(mergedFast.refFrom.length, 2);
  assert.strictEqual(mergedFast.refTo.buffer, refTo.buffer, 'trimmed refTo must be zero-copy subarray');
  assert.strictEqual(mergedFast.refKind.buffer, refKind.buffer, 'trimmed refKind must be zero-copy subarray');
  assert.strictEqual(mergedFast.kindRegions[0].kinds, kinds, 'exact-length kinds must be zero-copy identical reference');

  const crossRealm = vm.runInNewContext(`({
    regionId: 'r0',
    vmAddr: 0x1000n,
    words: 4,
    callFrom: new BigUint64Array([0x1000n, 0x1004n]),
    callTo: new BigUint64Array([0x2000n, 0x2004n]),
    callCount: 2,
    refFrom: new BigUint64Array([0x1008n, 0x100cn, 0x9999n]),
    refTo: new BigUint64Array([0x3000n, 0x3004n, 0x9999n]),
    refKind: new Uint8Array([0, 1, 9]),
    refCount: 2,
    kinds: new Uint8Array([19, 19, 2, 5]),
    kindsCovered: 4,
    complete: true,
  })`);
  assert.equal(crossRealm.callFrom instanceof BigUint64Array, false, 'precondition: vm TypedArray is cross-realm');

  const mergedCross = mergeProgramScans([crossRealm]);
  assert.ok(mergedCross.callFrom instanceof BigUint64Array, 'cross-realm merge must produce main-realm BigUint64Array');
  assert.ok(mergedCross.refKind instanceof Uint8Array, 'cross-realm merge must produce main-realm Uint8Array');
  assert.ok(mergedCross.kindRegions[0].kinds instanceof Uint8Array, 'cross-realm kinds must produce main-realm Uint8Array');
  assert.deepEqual(Array.from(mergedCross.callFrom), Array.from(mergedFast.callFrom));
  assert.deepEqual(Array.from(mergedCross.callTo), Array.from(mergedFast.callTo));
  assert.deepEqual(Array.from(mergedCross.refFrom), Array.from(mergedFast.refFrom));
  assert.deepEqual(Array.from(mergedCross.refTo), Array.from(mergedFast.refTo));
  assert.deepEqual(Array.from(mergedCross.refKind), Array.from(mergedFast.refKind));
  assert.deepEqual(Array.from(mergedCross.kindRegions[0].kinds), Array.from(mergedFast.kindRegions[0].kinds));

  const plainScan = {
    regionId: 'r0',
    vmAddr: 0x1000n,
    words: 4,
    callFrom: [0x1000n, 0x1004n],
    callTo: [0x2000n, 0x2004n],
    callCount: 2,
    refFrom: [0x1008n, 0x100cn],
    refTo: [0x3000n, 0x3004n],
    refKind: [0, 1],
    refCount: 2,
    kinds: [19, 19, 2, 5],
    kindsCovered: 4,
    complete: true,
  };
  const mergedPlain = mergeProgramScans([plainScan]);
  assert.deepEqual(Array.from(mergedPlain.callFrom), Array.from(mergedFast.callFrom));
  assert.deepEqual(Array.from(mergedPlain.refTo), Array.from(mergedFast.refTo));
  assert.deepEqual(Array.from(mergedPlain.kindRegions[0].kinds), Array.from(mergedFast.kindRegions[0].kinds));
});

/* ── 4. classifyExecutableCoverage equivalence ──────────────── */

test('4.1a classifyExecutableCoverage matches contiguous readBytes oracle across unaligned seam, !hit hole, fat regionIds & EOF short read', async () => {
  const fileBytes = new Uint8Array(0x4c);
  const slice1Contiguous = wordsToBytes([NOP, 0, RET, NOP, RET, 0, NOP, RET, NOP], 'little');
  fileBytes.set(slice1Contiguous, 0x00);
  fileBytes.set(wordsToBytes([NOP, RET], 'little'), 0x40);
  fileBytes.set(wordsToBytes([NOP], 'little'), 0x48);

  const file = makeFileFromBytes('coverage-seam.bin', fileBytes);
  const regions = [
    { id: 'regA', vmAddr: 0x1000n, size: 0x0en, fileOffset: 0x00n, exec: true, zerofill: false },
    { id: 'regB', vmAddr: 0x100en, size: 0x16n, fileOffset: 0x0en, exec: true, zerofill: false },
    { id: 'regC', vmAddr: 0x2000n, size: 0x08n, fileOffset: 0x40n, exec: true, zerofill: false },
    { id: 'regD', vmAddr: 0x3000n, size: 0x10n, fileOffset: 0x48n, exec: true, zerofill: false },
  ];

  const contiguousReadBytes = async (addr, lenBig) => {
    const len = Number(lenBig);
    const out = new Uint8Array(len);
    let written = 0;
    let cur = BigInt(addr);
    while (written < len) {
      const r = regions.find((reg) => cur >= reg.vmAddr && cur < reg.vmAddr + reg.size);
      if (!r) return out.subarray(0, written);
      const avail = Number(r.vmAddr + r.size - cur);
      const take = Math.min(len - written, avail);
      const fOff = Number(r.fileOffset + (cur - r.vmAddr));
      if (fOff >= fileBytes.length) return out.subarray(0, written);
      const readable = Math.min(take, fileBytes.length - fOff);
      out.set(fileBytes.subarray(fOff, fOff + readable), written);
      written += readable;
      cur += BigInt(readable);
      if (readable < take) return out.subarray(0, written);
    }
    return out;
  };

  const worker = createClassicLegacyWorker({ standalone: false });
  await setupWorkerWithRegions(worker, { file, regions });

  // Unaligned head [0x1001n..0x1004n) and unaligned tail [0x1020n..0x1023n) spanning the unaligned seam at 0x100en:
  const functions = [0x1000n, 0x1023n];
  const functionEnds = [0x1001n, 0x1024n];

  const oracleCov = await executableByteCoverage({
    regions,
    functions,
    functionEnds,
    architecture: 'arm64',
    endian: 'little',
    readBytes: contiguousReadBytes,
  });

  const workerCov = await executableByteCoverage({
    regions,
    functions,
    functionEnds,
    architecture: 'arm64',
    endian: 'little',
    classifyGaps: ({ gaps, endian }) => worker.call('classifyExecutableCoverage', {
      gaps,
      regionIds: regions.map((r) => r.id),
      endian,
    }),
  });

  assert.deepEqual(workerCov, oracleCov, 'worker classifyExecutableCoverage must match contiguous oracle bit-for-bit');
  assert.ok(
    workerCov.unclassified.some((s) => s.start <= 0x100cn && s.end >= 0x1010n && s.class === 'padding'),
    'unaligned seam 4-byte stitched NOP must be classified as padding',
  );

  // Missing-region `!hit` monotonic alignment:
  const holeRes = await worker.call('classifyExecutableCoverage', {
    gaps: [{ start: 0x1800n, end: 0x2008n }],
    regionIds: ['regC'],
    endian: 'little',
  });
  assert.deepEqual(Array.from(holeRes.spans, (x) => ({ start: x.start, end: x.end, class: x.class })), [
    { start: 0x1800n, end: 0x2000n, class: 'unknown' },
    { start: 0x2000n, end: 0x2004n, class: 'padding' },
    { start: 0x2004n, end: 0x2008n, class: 'unknown' },
  ]);

  // Fat-Mach-O multi-slice regionIds isolation:
  const fatBytes = new Uint8Array(16);
  fatBytes.set(wordsToBytes([NOP, NOP], 'little'), 0);
  fatBytes.set(wordsToBytes([RET, RET], 'little'), 8);
  const fatFile = makeFileFromBytes('fat-cov.bin', fatBytes);
  const fatRegions = [
    { id: 's0_text', vmAddr: 0x5000n, size: 8n, fileOffset: 0n, exec: true, zerofill: false },
    { id: 's1_text', vmAddr: 0x5000n, size: 8n, fileOffset: 8n, exec: true, zerofill: false },
  ];
  await setupWorkerWithRegions(worker, { file: fatFile, regions: fatRegions });
  const s1Cov = await worker.call('classifyExecutableCoverage', {
    gaps: [{ start: 0x5000n, end: 0x5008n }],
    regionIds: ['s1_text'],
    endian: 'little',
  });
  assert.deepEqual(Array.from(s1Cov.spans, (x) => ({ start: x.start, end: x.end, class: x.class })), [{ start: 0x5000n, end: 0x5008n, class: 'unknown' }], 'regionIds must isolate slice 1');

  // Empty gaps: classifyGaps must NOT be called.
  let classifyCalls = 0;
  const fullCov = await executableByteCoverage({
    regions: [fatRegions[0]],
    functions: [0x5000n],
    functionEnds: [0x5008n],
    architecture: 'arm64',
    classifyGaps: () => { classifyCalls++; return { spans: [] }; },
  });
  assert.equal(classifyCalls, 0, 'classifyGaps must be skipped when gaps.length === 0');
  assert.equal(fullCov.unclassified.length, 0);
});

test('4.1b sub-4-byte gap [0x1001n, 0x1003n) parity between readBytes oracle and worker classifyExecutableCoverage', async () => {
  const raw = wordsToBytes([NOP, RET], 'little');
  const file = makeFileFromBytes('sub4-gap.bin', raw);
  const regions = [{ id: 'r_sub4', vmAddr: 0x1000n, size: 8n, fileOffset: 0n, exec: true, zerofill: false }];
  const worker = createClassicLegacyWorker({ standalone: false });
  await setupWorkerWithRegions(worker, { file, regions });

  const functions = [0x1000n, 0x1003n];
  const functionEnds = [0x1001n, 0x1008n];

  const oracleCov = await executableByteCoverage({
    regions,
    functions,
    functionEnds,
    architecture: 'arm64',
    endian: 'little',
    readBytes: async (addr, len) => raw.subarray(Number(addr - 0x1000n), Number(addr - 0x1000n) + Number(len)),
  });

  const workerCov = await executableByteCoverage({
    regions,
    functions,
    functionEnds,
    architecture: 'arm64',
    endian: 'little',
    classifyGaps: ({ gaps, endian }) => worker.call('classifyExecutableCoverage', {
      gaps,
      regionIds: ['r_sub4'],
      endian,
    }),
  });

  assert.deepEqual(workerCov.unclassified, [{ start: 0x1001n, end: 0x1003n, class: 'unknown' }]);
  assert.deepEqual(oracleCov.unclassified, workerCov.unclassified, 'sub-4-byte gap must emit one single unknown span without duplication');
});

test('4.2 classifyExecutableCoverage arm64e (little-endian) and aarch64_be (big-endian) equivalence', async () => {
  const leBytes = wordsToBytes([NOP, 0, RET, NOP], 'little');
  const beBytes = wordsToBytes([NOP, 0, RET, NOP], 'big');

  for (const { arch, endian, raw } of [
    { arch: 'arm64e', endian: 'little', raw: leBytes },
    { arch: 'aarch64_be', endian: 'big', raw: beBytes },
  ]) {
    const file = makeFileFromBytes(`cov-${arch}.bin`, raw);
    const regions = [
      { id: `${arch}_a`, vmAddr: 0x1000n, size: 6n, fileOffset: 0n, exec: true, zerofill: false },
      { id: `${arch}_b`, vmAddr: 0x1006n, size: 10n, fileOffset: 6n, exec: true, zerofill: false },
    ];
    const worker = createClassicLegacyWorker({ standalone: false });
    await setupWorkerWithRegions(worker, { file, regions });

    const oracle = await executableByteCoverage({
      regions,
      architecture: arch,
      endian,
      readBytes: async (addr, len) => raw.subarray(Number(addr - 0x1000n), Number(addr - 0x1000n) + Number(len)),
    });
    const viaWorker = await executableByteCoverage({
      regions,
      architecture: arch,
      endian,
      classifyGaps: ({ gaps, endian: e }) => worker.call('classifyExecutableCoverage', {
        gaps,
        regionIds: regions.map((r) => r.id),
        endian: e,
      }),
    });

    assert.deepEqual(viaWorker, oracle, `${arch} (${endian}) must match oracle`);
    assert.deepEqual(viaWorker.unclassified, [
      { start: 0x1000n, end: 0x1008n, class: 'padding' },
      { start: 0x1008n, end: 0x100cn, class: 'unknown' },
      { start: 0x100cn, end: 0x1010n, class: 'padding' },
    ], `${arch} (${endian}) exact span classes`);
  }
});

test('4.3 classifyExecutableCoverage AbortSignal, cancelled result, StaleRequestError, and Unknown-request fallback', async () => {
  const raw = wordsToBytes([NOP, RET], 'little');
  const regions = [{ id: 'r', vmAddr: 0x1000n, size: 8n, fileOffset: 0n, exec: true, zerofill: false }];
  let readBytesCalls = 0;
  const readBytes = async (addr, len) => {
    readBytesCalls++;
    return raw.subarray(Number(addr - 0x1000n), Number(addr - 0x1000n) + Number(len));
  };

  const ac = new AbortController();
  ac.abort();
  await assert.rejects(
    () => executableByteCoverage({
      regions,
      architecture: 'arm64',
      signal: ac.signal,
      readBytes,
      classifyGaps: () => { throw new Error('should not be called'); },
    }),
    (err) => err?.name === 'AbortError',
  );
  assert.equal(readBytesCalls, 0);

  await assert.rejects(
    () => executableByteCoverage({
      regions,
      architecture: 'arm64',
      readBytes,
      classifyGaps: async () => ({ spans: [], cancelled: true }),
    }),
    (err) => err?.name === 'AbortError',
  );
  assert.equal(readBytesCalls, 0);

  const staleErr = Object.assign(new Error('Stale analysis request.'), { name: 'StaleRequestError', stale: true });
  await assert.rejects(
    () => executableByteCoverage({
      regions,
      architecture: 'arm64',
      readBytes,
      classifyGaps: async () => { throw staleErr; },
    }),
    (err) => err === staleErr && err.stale === true,
  );
  assert.equal(readBytesCalls, 0);

  const fallbackCov = await executableByteCoverage({
    regions,
    architecture: 'arm64',
    readBytes,
    classifyGaps: async () => { throw new Error('Unknown request: classifyExecutableCoverage'); },
  });
  assert.ok(readBytesCalls > 0, 'Unknown request must fall back to readBytes');
  assert.deepEqual(fallbackCov.unclassified, [
    { start: 0x1000n, end: 0x1004n, class: 'padding' },
    { start: 0x1004n, end: 0x1008n, class: 'unknown' },
  ]);
});

test('3.4 Backend.scanProgram Stage 2 budgetCapped and >96 MiB clampedBytes fail-fast fallback to legacy worker', async () => {
  const { Backend } = await import('../js/backend.js');
  const region = { id: 'text', vmAddr: 0x100000n, fileOffset: 0n, size: 1024n, name: '__text' };
  const fnStarts = new BigUint64Array([0x100000n, 0x100200n]);
  const raw = new ArrayBuffer(1024);
  const fakeFile = {
    size: 1024,
    slice(start, end) {
      return { arrayBuffer: async () => raw.slice(Number(start), Number(end)) };
    },
  };

  class LocalMockWorker {
    constructor(onPost) {
      this.onPost = onPost;
      this.sent = [];
      this.terminated = false;
      this.onmessage = null;
      this.onerror = null;
    }
    postMessage(msg) {
      if (this.terminated) return;
      this.sent.push(msg);
      if (this.onPost) this.onPost(this, msg);
    }
    emit(data) {
      if (this.terminated || !this.onmessage) return;
      this.onmessage({ data });
    }
    terminate() { this.terminated = true; }
  }

  for (const mode of ['budgetCapped', 'clampedBytesExceed96MiB']) {
    const scanWorkers = [];
    let legacyFallbackCalls = 0;
    const b = new Backend({
      parallelScanThresholdBytes: 256,
      scanWorkerFactory: () => {
        const w = new LocalMockWorker((worker, msg) => {
          if (msg.t === 'scanStage1') {
            queueMicrotask(() => worker.emit({
              t: 'res', ok: true, id: msg.id, result: {
                chunkIndex: msg.chunkIndex,
                crossChunkForwardTargets: new BigUint64Array(0),
                loopKillAddrs: new BigUint64Array(0),
                loopKillMasks: new Uint32Array(0),
              },
            }));
          } else if (msg.t === 'scanProgramChunk') {
            if (msg.chunkIndex === 0) {
              queueMicrotask(() => worker.emit({
                t: 'res', ok: true, id: msg.id, result: {
                  chunkIndex: 0,
                  callFrom: new BigUint64Array(0),
                  callTo: new BigUint64Array(0),
                  refFrom: new BigUint64Array(0),
                  refTo: new BigUint64Array(0),
                  refKind: new Uint8Array(0),
                  kinds: new Uint8Array(Math.floor((msg.chunkEnd - msg.chunkStart) / 4)),
                  callCount: mode === 'clampedBytesExceed96MiB' ? 7_000_000 : 1,
                  refCount: 0,
                  budgetCapped: mode === 'budgetCapped',
                  callsLimitCapped: false,
                  refsLimitCapped: false,
                },
              }));
            }
          }
        });
        scanWorkers.push(w);
        return w;
      },
    });
    b.formatId = 'macho';
    b._activeMachArchitecture = 'arm64';
    b.file = fakeFile;
    b.legacyWorker = new LocalMockWorker((worker, msg) => {
      if (msg.t === 'getScanMeta') {
        worker.emit({
          t: 'ok', id: msg.id, epoch: msg.epoch,
          result: { region, functionStarts: fnStarts, stringRanges: [], hasDataInCode: false },
        });
      } else if (msg.t === 'scanProgram') {
        legacyFallbackCalls++;
        worker.emit({
          t: 'ok', id: msg.id, epoch: msg.epoch,
          result: { regionId: 'text', fromLegacyFallback: mode, callFrom: new BigUint64Array(0) },
        });
      }
    });

    const res = await b.scanProgram('text');
    assert.equal(legacyFallbackCalls, 1, `${mode} must trigger single-worker legacy fallback`);
    assert.equal(res.fromLegacyFallback, mode);
    assert.ok(scanWorkers.some((w) => w.sent.some((m) => m.t === 'cancel')), `${mode} must cancel remaining in-flight wave job`);
    assert.equal(b.pending.size, 0);
    b.dispose();
  }
});

test('5.1 guessFunctions bit-exactness: __addressBitmap.forEach parity, cached vs uncached metadata/dataPointers/unwind, and cancelled cache hygiene', async () => {
  const worker = createClassicLegacyWorker({ standalone: false });

  // Part A: __addressBitmap.forEach parity against dense scan (27 words, not divisible by 8)
  const region = { id: 'text', vmAddr: 0x100004000n, fileOffset: 0n, size: 108n, exec: true, name: '__text' };
  const bm = worker.sandbox.__addressBitmap(region);
  const expectedAddrs = [
    0x100004000n,
    0x100004004n,
    0x10000401cn,
    0x100004020n,
    0x100004044n,
    0x100004068n,
  ];
  for (const a of expectedAddrs) bm.add(a);

  const viaForEach = [];
  bm.forEach((a) => viaForEach.push(a));
  const viaDense = [];
  for (let off = 0n; off < region.size; off += 4n) {
    const a = region.vmAddr + off;
    if (bm.has(a)) viaDense.push(a);
  }
  assert.deepEqual(viaForEach, expectedAddrs);
  assert.deepEqual(viaForEach, viaDense, '__addressBitmap.forEach must match dense scan bit-for-bit');

  // Part B: guessFunctions cached (requestId != null) vs uncached (requestId == null) with __const data pointers + cancelled cache hygiene
  const codeWords = new Uint32Array(128);
  codeWords[0] = 0xa9bf7bfd; // STP x29, x30, [sp, #-16]!
  codeWords[1] = 0x9400003f; // BL +63 words -> index 64 (0x100004100)
  codeWords[2] = 0xa8c17bfd; // LDP x29, x30, [sp], #16
  codeWords[3] = 0xd65f03c0; // RET
  codeWords[64] = 0xa9bf7bfd;
  codeWords[65] = 0xd503201f;
  codeWords[66] = 0xa8c17bfd;
  codeWords[67] = 0xd65f03c0;
  codeWords[96] = 0xa9bf7bfd; // Discovered via __const data pointer
  codeWords[97] = 0xd503201f;
  codeWords[98] = 0xa8c17bfd;
  codeWords[99] = 0xd65f03c0;

  const totalBytes = 544;
  const backing = new ArrayBuffer(totalBytes);
  new Uint8Array(backing, 0, 512).set(new Uint8Array(codeWords.buffer));
  const dv = new DataView(backing);
  dv.setBigUint64(512, 0x100004180n, true);
  dv.setBigUint64(520, 0x100004000n, true);
  dv.setBigUint64(528, 0xdeadbeefn, true);

  const syntheticFile = {
    size: totalBytes,
    slice(startOff, endOff) {
      return { arrayBuffer: async () => backing.slice(Number(startOff), Number(endOff)) };
    },
  };
  const textRegion = { id: 'r_text', sliceIndex: 0, vmAddr: 0x100004000n, fileOffset: 0n, size: 512n, exec: true, name: '__TEXT,__text', segment: '__TEXT', section: '__text' };
  const constRegion = { id: 'r_const', sliceIndex: 0, vmAddr: 0x100008000n, fileOffset: 512n, size: 32n, exec: false, name: '__DATA_CONST,__const', segment: '__DATA_CONST', section: '__const' };
  const slice = {
    index: 0,
    fileOffset: 0n,
    textBase: 0x100004000n,
    info: { textVM: 0x100004000n },
    regions: [textRegion, constRegion],
    sections: [{ segname: '__TEXT', sectname: '__text', addr: 0x100004000n, offset: 0n, size: 512n }, { segname: '__DATA_CONST', sectname: '__const', addr: 0x100008000n, offset: 512n, size: 32n }],
    symbols: [],
    functionStarts: [],
    dataInCode: [],
  };

  worker.sandbox.__testFile = syntheticFile;
  worker.sandbox.__testSlice = slice;
  worker.evalInContext(`
    file = globalThis.__testFile;
    fileSize = BigInt(file.size);
    slices = [globalThis.__testSlice];
    regions = new Map(globalThis.__testSlice.regions.map((r) => [r.id, r]));
    currentEpoch = 1;
    delete globalThis.__testFile;
    delete globalThis.__testSlice;
  `);

  const uncached = await worker.sandbox.guessFunctions({ regionId: 'r_text', limit: 1000, requestId: null, epoch: 1 });
  const cached1 = await worker.sandbox.guessFunctions({ regionId: 'r_text', limit: 1000, requestId: 101, epoch: 1 });
  const cached2 = await worker.sandbox.guessFunctions({ regionId: 'r_text', limit: 1000, requestId: 102, epoch: 1 });

  assert.deepEqual(cached1.starts, uncached.starts, 'cached guessFunctions starts must be bit-exact with uncached');
  assert.deepEqual(cached2.starts, uncached.starts, 'second cached guessFunctions call must remain bit-exact');
  assert.equal(cached1.truncated, uncached.truncated);
  assert.deepEqual(cached1.completeness, uncached.completeness);
  assert.ok(
    uncached.starts.includes(0x100004000n) && uncached.starts.includes(0x100004100n) && uncached.starts.includes(0x100004180n),
    'all 3 functions including __const pointer target must be discovered',
  );

  // Cancelled run hygiene: pre-cancel requestId 103 on a fresh slice and verify no partial dataPointers/unwind cache is persisted
  const freshSlice = { ...slice, regions: [textRegion, constRegion] };
  worker.sandbox.__testSlice = freshSlice;
  worker.evalInContext(`
    slices = [globalThis.__testSlice];
    cancelledRequests.add('1:103');
    delete globalThis.__testSlice;
  `);
  await worker.sandbox.guessFunctions({ regionId: 'r_text', limit: 1000, requestId: 103, epoch: 1 });
  const metaCache = worker.evalInContext('__metaReadCacheByReq');
  assert.equal(metaCache.has('1:103'), false, 'cancelled guessFunctions must clean up its request cache entry');
  assert.equal(freshSlice.__validCache?.dataPointers, undefined, 'cancelled guessFunctions must not cache partial dataPointers');
  assert.equal(freshSlice.__validCache?.unwind, undefined, 'cancelled guessFunctions must not cache partial unwind');
});
