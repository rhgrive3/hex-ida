import test from 'node:test';
import assert from 'node:assert/strict';
import {
  runWasmStructuralAnalysis,
  BEHAVIOR_CATEGORY,
  CALLGRAPH_ROLE,
} from '../js/analysis/wasm-suite.js';
import { autoAnalyze } from '../js/auto.js';
import { pinpointFunction } from '../js/pinpoint-legacy.js';
import { pinpoint } from '../js/pinpoint.js';
import { SymbolIndex } from '../js/symbols.js';
import { ProgramIndex } from '../js/program.js';
import { classifyArm64Behavior, inferArm64Abi } from '../js/analysis/wasm-suite.js';
import { getHexEngineExports } from '../js/core/hex-engine-wasm.js';
import { goalFromPreset } from '../js/goals.js';
import { foldShapes, SHAPE, AMOUNT } from '../js/shapes.js';

function packInsns(words) {
  const buf = new Uint8Array(words.length * 4);
  const dv = new DataView(buf.buffer);
  for (let i = 0; i < words.length; i++) dv.setUint32(i * 4, words[i] >>> 0, true);
  return buf;
}

// ARM64 clamped HP subtraction:
// ldr w8, [x0, #0x20]   (0xb9402008)
// subs w8, w8, w1       (0x6b010108)
// csel w8, wzr, w8, lt  (0x1a88b3e8)
// str w8, [x0, #0x20]   (0xb9002008)
// ret                   (0xd65f03c0)
const CLAMPED_HP_BYTES = packInsns([
  0xb9402008,
  0x6b010108,
  0x1a88b3e8,
  0xb9002008,
  0xd65f03c0,
]);

test('runWasmStructuralAnalysis runs RMW, JumpTable, Vtable, ConstTable, and CallGraph on unified WASM', () => {
  const dataBytes = new Uint8Array(128);
  const dv = new DataView(dataBytes.buffer);
  dv.setFloat32(0, 1.5, true);
  dv.setFloat32(4, 2.25, true);
  dv.setFloat32(8, 3.75, true);
  dv.setFloat32(12, 4.125, true);
  // Vtable header at offset 48 (offset_to_top=0, rtti=0x30000), entries at 64, 72, 80
  dv.setBigInt64(48, 0n, true);
  dv.setBigUint64(56, 0x30000n, true);
  dv.setBigUint64(64, 0x10040n, true);
  dv.setBigUint64(72, 0x10080n, true);
  dv.setBigUint64(80, 0x100c0n, true);

  const res = runWasmStructuralAnalysis({
    codeBytes: CLAMPED_HP_BYTES,
    dataBytes,
    textVa: 0x10000n,
    textLo: 0x10000n,
    textHi: 0x20000n,
    arch: 'arm64',
    ptrSize: 8,
    callgraph: {
      numNodes: 3,
      edgeSrc: new Uint32Array([0, 1]),
      edgeDst: new Uint32Array([1, 0]),
    },
  });

  assert.equal(res.rmw.engine, 'wasm');
  assert.equal(res.rmw.hits.length, 1);
  assert.equal(res.rmw.hits[0].clamped, true);
  assert.equal(res.rmw.hits[0].disp, 0x20);

  assert.equal(res.vtables.engine, 'wasm');
  assert.equal(res.vtables.vtables.length, 1);
  assert.equal(res.vtables.vtables[0].hasRtti, true);

  assert.equal(res.constTables.engine, 'wasm');
  assert.ok(res.constTables.tables.some((t) => t.kind === 1));

  assert.equal(res.jumpTables.engine, 'wasm');

  assert.equal(res.callgraph.engine, 'wasm');
  assert.equal(res.callgraph.role[0], CALLGRAPH_ROLE.RECURSIVE_SCC);
  assert.equal(res.callgraph.role[1], CALLGRAPH_ROLE.RECURSIVE_SCC);
  assert.equal(res.callgraph.role[2], CALLGRAPH_ROLE.NORMAL);
});

test('autoAnalyze populates report.wasmAnalysis from program callgraph and codeBytes', async () => {
  const fns = [{ addr: 0x1000n, name: 'sub_1000' }, { addr: 0x2000n, name: 'sub_2000' }];
  const program = {
    arch: 'arm64',
    callCount: 2,
    refCount: 0,
    statsComplete: true,
    callsCapped: false,
    refsCapped: false,
    functionRange: (a) => ({ start: a, end: a + 20n }),
    calleesOf: (a) => (a === 0x1000n ? [0x2000n] : [0x1000n]),
    callersOf: (a) => (a === 0x1000n ? [0x2000n] : [0x1000n]),
    callCountOf: () => 1,
    functionsReferencing: () => Object.assign([], { complete: true }),
  };
  const symbols = {
    functionCount: 2,
    functions: () => fns,
    nameAt: (a) => fns.find((f) => f.addr === a)?.name || null,
  };
  const report = await autoAnalyze({
    strings: [],
    program,
    symbols,
    codeBytes: CLAMPED_HP_BYTES,
    region: { vmAddr: 0x1000n, size: 20n },
    deepLimit: 0,
  });

  assert.ok(report.wasmAnalysis);
  assert.equal(report.wasmAnalysis.rmw.engine, 'wasm');
  assert.equal(report.wasmAnalysis.rmw.hits.length, 1);
  assert.equal(report.wasmAnalysis.callgraph.engine, 'wasm');
  assert.equal(report.wasmAnalysis.callgraph.summary.recursiveCount, 2);
});

test('pinpointFunction attaches WASM behavior/ABI/fingerprint and reinforces RMW from model.rawBytes', async () => {
  const goal = goalFromPreset('hp');
  const fnAddr = 0x4000n;
  const shapes = foldShapes({
    count: 2,
    disp: new Int32Array([0x20, 0x20]),
    size: new Uint8Array([4, 4]),
    flags: new Uint8Array([SHAPE.DECREASE | SHAPE.CLAMP, SHAPE.DECREASE | SHAPE.CLAMP]),
    amtKind: new Uint8Array([AMOUNT.NONE, AMOUNT.NONE]),
    amtDisp: new Int32Array([0, 0]),
    addr: new BigUint64Array([0x4004n, 0x4008n]),
    span: new Uint32Array([16, 16]),
  });
  const res = await pinpointFunction({
    goal,
    ranked: [],
    shapes,
    program: {
      arch: 'arm64',
      functionRange: (a) => (BigInt(a) >= fnAddr && BigInt(a) < fnAddr + 0x40n ? { start: fnAddr, end: fnAddr + BigInt(CLAMPED_HP_BYTES.length) } : null),
      callersOf: () => [],
      calleesOf: () => [],
    },
    analyze: async () => ({
      arch: 'arm64',
      instructions: [], // intentionally empty to prove Track 1 WASM RMW reinforcement works
      rawBytes: CLAMPED_HP_BYTES,
    }),
  });

  assert.ok(res.candidates.length >= 1);
  const top = res.candidates[0];
  assert.ok(top.evidence.some((e) => e.code === 'fn-field-rmw-clamped'));
  assert.equal(top.wasmBehavior.engine, 'wasm');
  assert.equal(top.wasmBehavior.topCategory, BEHAVIOR_CATEGORY.DRAIN);
  assert.equal(top.wasmAbi.engine, 'wasm');
  assert.equal(top.wasmAbi.hasThis, true);
  assert.equal(top.wasmFingerprint.engine, 'wasm');
  assert.equal(top.wasmFingerprint.insnCount, 5);
});

test('production SymbolIndex + ProgramIndex callgraph extraction avoids cross-function bogus edges', () => {
  const syms = new SymbolIndex();
  syms.addFunctions([0x1000n, 0x2000n, 0x3000n]);
  const region = { vmAddr: 0x1000n, size: 0x3000n };
  const prog = new ProgramIndex({
    callFrom: new BigUint64Array([0x1004n, 0x2004n]),
    callTo: new BigUint64Array([0x2000n, 0x3000n]),
    callCount: 2,
  }, syms, region);
  const res = runWasmStructuralAnalysis({ program: prog, symbols: syms });
  assert.ok(res.callgraph, 'callgraph must be populated for real SymbolIndex + ProgramIndex');
  assert.equal(res.callgraph.engine, 'wasm');
  assert.equal(res.callgraph.numNodes, 3);
  // Must have exactly 2 edges (0->1 and 1->2), NOT 0->2 leaked by unbounded calleesOf!
  assert.equal(res.callgraph.numEdges, 2);
});

test('public pinpoint() facade supports zero-string shape seed without ranked candidates', async () => {
  const goal = goalFromPreset('hp');
  const fnAddr = 0x4000n;
  const shapes = foldShapes({
    count: 2,
    disp: new Int32Array([0x20, 0x20]),
    size: new Uint8Array([4, 4]),
    flags: new Uint8Array([SHAPE.DECREASE | SHAPE.CLAMP, SHAPE.DECREASE | SHAPE.CLAMP]),
    amtKind: new Uint8Array([AMOUNT.NONE, AMOUNT.NONE]),
    amtDisp: new Int32Array([0, 0]),
    addr: new BigUint64Array([0x4004n, 0x4008n]),
    span: new Uint32Array([16, 16]),
  });
  const out = await pinpoint({
    goal,
    ranked: [],
    shapes,
    program: {
      arch: 'arm64',
      functionRange: (a) => (BigInt(a) >= fnAddr && BigInt(a) < fnAddr + 0x40n ? { start: fnAddr, end: fnAddr + BigInt(CLAMPED_HP_BYTES.length) } : null),
      callersOf: () => [],
      calleesOf: () => [],
    },
    analyze: async () => ({
      arch: 'arm64',
      instructions: [],
      rawBytes: CLAMPED_HP_BYTES,
    }),
  });
  assert.ok(out.function && out.function.candidates.length >= 1, 'public pinpoint() must invoke pinpointFunction for zero-string shapes');
  assert.ok(out.function.candidates[0].evidence.some((e) => e.code === 'fn-field-rmw-clamped'));
});

test('SDIV, CRC32X, LDP D0/D1 decoder fixes and scratch arena reset after 1.5 MiB call', () => {
  // sdiv x0, x1, x2 (0x9ac20c20) -> MULDIV / RATIO
  const sdivBytes = packInsns([0x9ac20c20, 0x9ac20c20, 0xd65f03c0]);
  const sdivW = classifyArm64Behavior(sdivBytes, { arch: 'arm64' });
  const sdivJ = classifyArm64Behavior(sdivBytes, { arch: 'arm64', engine: 'js' });
  assert.equal(sdivW.engine, 'wasm');
  assert.ok(sdivW.ratioScore >= 440, 'SDIV must contribute to ratioScore');
  assert.equal(sdivW.ratioScore, sdivJ.ratioScore);

  // crc32x w0, w0, x1 (0x9ac14c00) -> HW crypto
  const crcBytes = packInsns([0x9ac14c00, 0xd65f03c0]);
  const crcW = classifyArm64Behavior(crcBytes, { arch: 'arm64' });
  const crcJ = classifyArm64Behavior(crcBytes, { arch: 'arm64', engine: 'js' });
  assert.equal(crcW.engine, 'wasm');
  assert.ok(crcW.cryptoScore >= 500, 'CRC32X must contribute to cryptoScore');
  assert.equal(crcW.cryptoScore, crcJ.cryptoScore);

  // ldp d0, d1, [x0] (0x6d400400) + ret (0xd65f03c0) -> f64 return (retKind === 4)
  const ldpBytes = packInsns([0x6d400400, 0xd65f03c0]);
  const abiW = inferArm64Abi(ldpBytes, { arch: 'arm64' });
  const abiJ = inferArm64Abi(ldpBytes, { arch: 'arm64', engine: 'js' });
  assert.equal(abiW.engine, 'wasm');
  assert.equal(abiW.retKind, 4, 'LDP D0, D1 must infer f64 retKind=4');
  assert.equal(abiW.retKind, abiJ.retKind);

  // Scratch arena must be freed in finally after 1.5 MiB classifyArm64Behavior
  const big = new Uint8Array(1536 * 1024);
  const bigRes = classifyArm64Behavior(big, { arch: 'arm64' });
  assert.equal(bigRes.engine, 'wasm');
  const ex = getHexEngineExports();
  const ptr = ex.hex_engine_scratch_alloc(1536 * 1024);
  assert.ok(ptr !== 0, 'scratch arena must be reset after classifyArm64Behavior');
  ex.hex_engine_scratch_reset();
});

test('non-ARM64 ProgramIndex.architecture guards autoAnalyze and pinpointFunction against ARM64 false positives', async () => {
  const syms = new SymbolIndex();
  syms.addFunctions([0x1000n]);
  const region = { vmAddr: 0x1000n, size: 0x40n };
  const x86Prog = new ProgramIndex({
    architecture: 'x86_64',
    callFrom: new BigUint64Array(0),
    callTo: new BigUint64Array(0),
    callCount: 0,
  }, syms, region);

  const report = await autoAnalyze({
    strings: [],
    program: x86Prog,
    symbols: syms,
    codeBytes: CLAMPED_HP_BYTES,
    region,
    deepLimit: 0,
  });
  assert.equal(report.wasmAnalysis.rmw.unsupportedArch, true);
  assert.equal(report.wasmAnalysis.rmw.hits.length, 0);
  assert.equal(report.wasmAnalysis.jumpTables.unsupportedArch, true);

  const goal = goalFromPreset('hp');
  const shapes = foldShapes({
    count: 2,
    disp: new Int32Array([0x20, 0x20]),
    size: new Uint8Array([4, 4]),
    flags: new Uint8Array([SHAPE.DECREASE | SHAPE.CLAMP, SHAPE.DECREASE | SHAPE.CLAMP]),
    amtKind: new Uint8Array([AMOUNT.NONE, AMOUNT.NONE]),
    amtDisp: new Int32Array([0, 0]),
    addr: new BigUint64Array([0x1004n, 0x1008n]),
    span: new Uint32Array([16, 16]),
  });
  const pin = await pinpointFunction({
    goal,
    ranked: [],
    shapes,
    program: x86Prog,
    analyze: async () => ({
      architecture: 'x86_64',
      instructions: [],
      rawBytes: CLAMPED_HP_BYTES,
    }),
  });
  assert.ok(pin.candidates.length >= 1);
  const top = pin.candidates[0];
  assert.equal(top.evidence.some((e) => e.code === 'fn-field-rmw-clamped' || e.code === 'fn-field-rmw'), false);
  assert.equal(top.wasmBehavior, undefined);
  assert.equal(top.wasmAbi, undefined);
  assert.equal(top.wasmFingerprint, undefined);
});
