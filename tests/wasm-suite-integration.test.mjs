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

test('runWasmStructuralAnalysis aggregates multiple dataSections (__DATA_CONST.__const + __TEXT.__const) with section, va, bySection on WASM', () => {
  // Section 1: __DATA_CONST.__const -> strided_id table (stride=16, 6 entries) + Vtable
  const dataConstBytes = new Uint8Array(256);
  const dv1 = new DataView(dataConstBytes.buffer);
  for (let i = 0; i < 6; i++) {
    dv1.setUint32(i * 16, 100 + i, true);
    dv1.setUint32(i * 16 + 4, 0xdeadbeef, true);
  }
  // Vtable header at offset 128 (offset_to_top=0, rtti=0x30000), entries at 144, 152, 160
  dv1.setBigInt64(128, 0n, true);
  dv1.setBigUint64(136, 0x30000n, true);
  dv1.setBigUint64(144, 0x10040n, true);
  dv1.setBigUint64(152, 0x10080n, true);
  dv1.setBigUint64(160, 0x100c0n, true);

  // Section 2: __TEXT.__const -> f32 table at offset 0 + f64 table at offset 32
  const textConstBytes = new Uint8Array(128);
  const dv2 = new DataView(textConstBytes.buffer);
  dv2.setFloat32(0, 1.5, true);
  dv2.setFloat32(4, 2.25, true);
  dv2.setFloat32(8, 3.75, true);
  dv2.setFloat32(12, 4.125, true);
  dv2.setFloat64(32, 1.5, true);
  dv2.setFloat64(40, 2.5, true);
  dv2.setFloat64(48, 3.5, true);
  dv2.setFloat64(56, 4.5, true);

  const res = runWasmStructuralAnalysis({
    dataSections: [
      { name: '__DATA_CONST.__const', bytes: dataConstBytes, va: 0x200000n },
      { name: '__TEXT.__const', bytes: textConstBytes, va: 0x180000n },
    ],
    imageBase: 0x100000n,
    textLo: 0x10000n,
    textHi: 0x20000n,
    ptrSize: 8,
  });

  assert.ok(res.constTables);
  assert.equal(res.constTables.engine, 'wasm');
  assert.equal(res.constTables.bySection.length, 2);
  assert.deepEqual(
    res.constTables.bySection.map((s) => s.section),
    ['__DATA_CONST.__const', '__TEXT.__const'],
  );
  assert.ok(res.constTables.bySection.every((s) => s.engine === 'wasm' && s.count >= 1));

  const stridedHit = res.constTables.tables.find((t) => t.kind === 3 && t.section === '__DATA_CONST.__const');
  assert.ok(stridedHit, 'strided_id table must be tagged with __DATA_CONST.__const');
  assert.equal(stridedHit.va, 0x200000n + BigInt(stridedHit.startOff));

  const f32Hit = res.constTables.tables.find((t) => t.kind === 1 && t.section === '__TEXT.__const');
  const f64Hit = res.constTables.tables.find((t) => t.kind === 2 && t.section === '__TEXT.__const');
  assert.ok(f32Hit, 'f32 table must be tagged with __TEXT.__const');
  assert.equal(f32Hit.va, 0x180000n + BigInt(f32Hit.startOff));
  assert.ok(f64Hit, 'f64 table must be tagged with __TEXT.__const');
  assert.equal(f64Hit.va, 0x180000n + BigInt(f64Hit.startOff));

  assert.ok(res.vtables);
  const expectedVtEngine = typeof getHexEngineExports()?.hex_scan_vtables_ext === 'function' ? 'wasm' : 'js';
  assert.equal(res.vtables.engine, expectedVtEngine);
  assert.equal(res.vtables.bySection.length, 2);
  assert.equal(res.vtables.vtables.length, 1);
  assert.equal(res.vtables.vtables[0].section, '__DATA_CONST.__const');
  assert.equal(res.vtables.vtables[0].va, 0x200000n + BigInt(res.vtables.vtables[0].vtableOff));
});

test('runWasmStructuralAnalysis combines dataBytes + textConstBytes and avoids double-scanning identical references', () => {
  const dataBytes = new Uint8Array(64);
  const dv1 = new DataView(dataBytes.buffer);
  dv1.setFloat32(0, 1.5, true);
  dv1.setFloat32(4, 2.25, true);
  dv1.setFloat32(8, 3.75, true);
  dv1.setFloat32(12, 4.125, true);

  const textConstBytes = new Uint8Array(64);
  const dv2 = new DataView(textConstBytes.buffer);
  dv2.setFloat64(0, 1.5, true);
  dv2.setFloat64(8, 2.5, true);
  dv2.setFloat64(16, 3.5, true);
  dv2.setFloat64(24, 4.5, true);

  const combined = runWasmStructuralAnalysis({
    dataBytes,
    dataVa: 0x300000n,
    textConstBytes,
    textConstVa: 0x190000n,
  });
  assert.equal(combined.constTables.engine, 'wasm');
  assert.equal(combined.constTables.bySection.length, 2);
  assert.deepEqual(
    combined.constTables.bySection.map((s) => s.section),
    ['data', '__TEXT.__const'],
  );
  assert.ok(combined.constTables.tables.some((t) => t.section === 'data' && t.va === 0x300000n));
  assert.ok(combined.constTables.tables.some((t) => t.section === '__TEXT.__const' && t.va === 0x190000n));

  // Identical Uint8Array reference must not be double-scanned
  const deduped = runWasmStructuralAnalysis({
    dataBytes,
    dataVa: 0x300000n,
    textConstBytes: dataBytes,
    textConstVa: 0x300000n,
  });
  assert.equal(deduped.constTables.engine, 'wasm');
  assert.equal(deduped.constTables.bySection.length, 1);
  assert.equal(deduped.constTables.bySection[0].section, 'data');
  assert.equal(deduped.constTables.tables.length, deduped.constTables.bySection[0].count);
});

test('autoAnalyze extracts __TEXT.__const and __DATA_CONST.__const from o.image into report.wasmAnalysis', async () => {
  const imageBytes = new Uint8Array(256);
  const dv = new DataView(imageBytes.buffer);
  // __TEXT.__const at fileOffset 0, size 64: f32 table
  dv.setFloat32(0, 1.5, true);
  dv.setFloat32(4, 2.25, true);
  dv.setFloat32(8, 3.75, true);
  dv.setFloat32(12, 4.125, true);
  // __DATA_CONST.__const at fileOffset 64, size 64: f64 table
  dv.setFloat64(64, 1.5, true);
  dv.setFloat64(72, 2.5, true);
  dv.setFloat64(80, 3.5, true);
  dv.setFloat64(88, 4.5, true);

  const mockImage = {
    imageBase: 0x100000000n,
    bytes: imageBytes,
    sections: [
      { segment: '__TEXT', name: '__const', fileOffset: 0, fileSize: 64, address: 0x100010000n },
      { segment: '__DATA_CONST', name: '__const', fileOffset: 64, fileSize: 64, address: 0x100020000n },
      { segment: '__TEXT', name: '__text', fileOffset: 128, fileSize: 64, address: 0x100004000n },
    ],
  };

  const report = await autoAnalyze({
    strings: [],
    image: mockImage,
    deepLimit: 0,
  });

  assert.ok(report.wasmAnalysis, 'report.wasmAnalysis must be populated from o.image sections');
  assert.ok(report.wasmAnalysis.constTables);
  assert.equal(report.wasmAnalysis.constTables.engine, 'wasm');
  const sectionNames = report.wasmAnalysis.constTables.bySection.map((s) => s.section);
  assert.ok(sectionNames.includes('__TEXT.__const'), 'bySection must include __TEXT.__const');
  assert.ok(sectionNames.includes('__DATA_CONST.__const'), 'bySection must include __DATA_CONST.__const');
  assert.equal(sectionNames.length, 2);
});

test('runWasmStructuralAnalysis populates x86Rmw on x86_64 while keeping rmw unsupportedArch', () => {
  // sub dword ptr [rdi + 0x10], eax (29 47 10); ret (c3)
  const x86Code = new Uint8Array([0x29, 0x47, 0x10, 0xc3]);
  const res = runWasmStructuralAnalysis({
    codeBytes: x86Code,
    arch: 'x86_64',
    textVa: 0x401000n,
  });
  assert.equal(res.rmw.unsupportedArch, true);
  assert.ok(res.x86Rmw);
  assert.equal(res.x86Rmw.engine, 'wasm');
  assert.equal(res.x86Rmw.hits.length, 1);
  assert.equal(res.x86Rmw.hits[0].disp, 0x10);
  assert.equal(res.x86Rmw.hits[0].opKind, 1);
});

test('autoAnalyze extracts ObjC/Swift metadata via WASM without altering constTables.bySection and links xrefs', async () => {
  const imageBytes = new Uint8Array(256);
  const dv = new DataView(imageBytes.buffer);
  // __TEXT.__const at off 0, size 32: f32 table
  dv.setFloat32(0, 1.5, true);
  dv.setFloat32(4, 2.25, true);
  dv.setFloat32(8, 3.75, true);
  dv.setFloat32(12, 4.125, true);
  // __DATA_CONST.__const at off 32, size 48: vtable (offset_to_top=0, rtti=0x100050000, 3 fn ptrs)
  dv.setBigInt64(32, 0n, true);
  dv.setBigUint64(40, 0x100050000n, true);
  dv.setBigUint64(48, 0x100004000n, true);
  dv.setBigUint64(56, 0x100004040n, true);
  dv.setBigUint64(64, 0x100004080n, true);
  // __DATA_CONST.__objc_classlist at off 80, size 16: 2 chained offset pointers
  dv.setBigUint64(80, 0x0000000000060000n, true);
  dv.setBigUint64(88, 0x0000000000060100n, true);
  // __TEXT.__swift5_types at off 96, size 8: 2 rel32 entries
  dv.setInt32(96, 0x100, true);
  dv.setInt32(100, 0x200, true);
  // __TEXT.__swift5_fieldmd at off 104, size 28: 1 FieldDescriptor with 1 field (recordSize=12)
  dv.setInt32(104, 0x40, true); // mangled_type_name
  dv.setInt32(108, 0, true);    // superclass
  dv.setUint16(112, 0, true);   // kind = struct
  dv.setUint16(114, 12, true);  // record_size
  dv.setUint32(116, 1, true);   // num_fields

  const mockImage = {
    imageBase: 0x100000000n,
    bytes: imageBytes,
    sections: [
      { segment: '__TEXT', name: '__const', fileOffset: 0, fileSize: 32, address: 0x100010000n },
      { segment: '__DATA_CONST', name: '__const', fileOffset: 32, fileSize: 48, address: 0x100020000n },
      { segment: '__DATA_CONST', name: '__objc_classlist', fileOffset: 80, fileSize: 16, address: 0x100030000n },
      { segment: '__TEXT', name: '__swift5_types', fileOffset: 96, fileSize: 8, address: 0x100040000n },
      { segment: '__TEXT', name: '__swift5_fieldmd', fileOffset: 104, fileSize: 28, address: 0x100041000n },
    ],
  };

  // ARM64 code at 0x100004000: ADRP X8, +0xC000 (0x100010000); ADD X8, X8, #0; RET
  // adrp x8, #12 pages (immlo=0, immhi=3): 0x90000068
  // add x8, x8, #0 (64-bit): 0x91000108
  // ret: 0xd65f03c0
  const codeBytes = packInsns([0x90000068, 0x91000108, 0xd65f03c0]);
  const syms = new SymbolIndex();
  syms.addFunctions([0x100004000n]);

  const report = await autoAnalyze({
    strings: [],
    image: mockImage,
    symbols: syms,
    codeBytes,
    region: { vmAddr: 0x100004000n, size: 0x1000n },
    deepLimit: 0,
  });

  assert.ok(report.wasmAnalysis);
  // constTables.bySection must still contain only the 2 __const sections
  assert.deepEqual(
    report.wasmAnalysis.constTables.bySection.map((s) => s.section),
    ['__TEXT.__const', '__DATA_CONST.__const'],
  );
  // objcSwift must be populated on WASM
  assert.ok(report.wasmAnalysis.objcSwift);
  assert.equal(report.wasmAnalysis.objcSwift.engine, 'wasm');
  assert.equal(report.wasmAnalysis.objcSwift.counts.objcClassList, 2);
  assert.equal(report.wasmAnalysis.objcSwift.counts.swift5Types, 2);
  assert.equal(report.wasmAnalysis.objcSwift.counts.swift5FieldMd, 1);
  // xrefLinks must link both Vtable and ConstTable to 0x100004000
  assert.ok(report.wasmAnalysis.xrefLinks);
  const fnEntry = report.wasmAnalysis.xrefLinks.byFunction['0x100004000'];
  assert.ok(fnEntry, 'function 0x100004000 must be linked in xrefLinks');
  assert.ok(fnEntry.tags.includes('vtable_member'));
  assert.ok(fnEntry.tags.includes('const_f32_ref'));
});
