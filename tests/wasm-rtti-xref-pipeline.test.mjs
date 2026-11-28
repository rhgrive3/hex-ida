import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { linkWasmStructuralHints } from '../js/analysis/wasm-xref-linker.js';
import { runWasmStructuralAnalysis } from '../js/analysis/wasm-suite.js';
import { autoAnalyze } from '../js/auto.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const XREF_LINKER_PATH = path.resolve(__dirname, '../js/analysis/wasm-xref-linker.js');

// Build a synthetic Mach-O-like image with:
//   - __TEXT.__text   @ 0x100004000 (4 functions: Base::v0, Base::v1, Derived::v2, helper)
//   - __TEXT.__cstring @ 0x100008000 (Itanium _ZTS names)
//   - __DATA_CONST.__const @ 0x10000c000 (typeinfo + vtables with absolute pointers)
function buildSyntheticCppImage() {
  const imageBase = 0x100000000n;
  const textVa = 0x100004000n;
  const textSize = 0x1000;
  const textOff = 0x1000;

  const cstrVa = 0x100008000n;
  const cstrSize = 0x400;
  const cstrOff = 0x2000;

  const dataVa = 0x10000c000n;
  const dataSize = 0x400;
  const dataOff = 0x3000;

  const totalSize = 0x4000;
  const bytes = new Uint8Array(totalSize);
  const dv = new DataView(bytes.buffer);
  const enc = new TextEncoder();

  // ARM64 RMW sequence inside Derived::v2 (fn2 at textVa + 0x80):
  //   LDR W9, [X0, #0x18]  -> 0xB9401809
  //   ADD W9, W9, #1       -> 0x11000529
  //   STR W9, [X0, #0x18]  -> 0xB9001809
  //   RET                  -> 0xD65F03C0
  const writeU32 = (off, val) => dv.setUint32(off, val >>> 0, true);
  // fn0 @ +0x00, fn1 @ +0x40, fn2 @ +0x80, helper @ +0xc0
  writeU32(textOff + 0x00, 0xD65F03C0);
  writeU32(textOff + 0x40, 0xD65F03C0);
  writeU32(textOff + 0x80, 0xB9401809);
  writeU32(textOff + 0x84, 0x11000529);
  writeU32(textOff + 0x88, 0xB9001809);
  writeU32(textOff + 0x8c, 0xD65F03C0);
  writeU32(textOff + 0xc0, 0xD65F03C0);

  // _ZTS strings
  const ztsBase = 'N4Game6System4Coin4BaseE';
  const ztsDerived = 'N4Game6System4Coin6WalletE';
  const ztsBaseOff = 0x10;
  const ztsDerivedOff = 0x60;
  bytes.set(enc.encode(ztsBase), cstrOff + ztsBaseOff);
  bytes.set(enc.encode(ztsDerived), cstrOff + ztsDerivedOff);

  const ztsBaseVa = cstrVa + BigInt(ztsBaseOff);
  const ztsDerivedVa = cstrVa + BigInt(ztsDerivedOff);

  // typeinfo for Base @ dataVa + 0x20 (__class_type_info: vptr=bind, name=ztsBaseVa)
  const tiBaseOff = 0x20;
  const tiBaseVa = dataVa + BigInt(tiBaseOff);
  dv.setBigUint64(dataOff + tiBaseOff + 0, 0x8000000000000001n, true); // chained bind
  dv.setBigUint64(dataOff + tiBaseOff + 8, ztsBaseVa, true);

  // typeinfo for Derived @ dataVa + 0x60 (__si_class_type_info: vptr=bind, name=ztsDerivedVa, base=tiBaseVa)
  const tiDerivedOff = 0x60;
  const tiDerivedVa = dataVa + BigInt(tiDerivedOff);
  dv.setBigUint64(dataOff + tiDerivedOff + 0, 0x8000000000000002n, true);
  dv.setBigUint64(dataOff + tiDerivedOff + 8, ztsDerivedVa, true);
  dv.setBigUint64(dataOff + tiDerivedOff + 16, tiBaseVa, true);

  const fn0 = textVa + 0x00n;
  const fn1 = textVa + 0x40n;
  const fn2 = textVa + 0x80n;
  const fnHelper = textVa + 0xc0n;

  // Base vtable @ dataVa + 0x100 (offsetToTop=0, rtti=tiBaseVa, slots=[fn0, fn1, fn0])
  const vtBaseOff = 0x100;
  dv.setBigInt64(dataOff + vtBaseOff - 16, 0n, true);
  dv.setBigUint64(dataOff + vtBaseOff - 8, tiBaseVa, true);
  dv.setBigUint64(dataOff + vtBaseOff + 0, fn0, true);
  dv.setBigUint64(dataOff + vtBaseOff + 8, fn1, true);
  dv.setBigUint64(dataOff + vtBaseOff + 16, fn0, true);

  // Derived vtable @ dataVa + 0x160 (offsetToTop=0, rtti=tiDerivedVa, slots=[fn0, fn1, fn2])
  const vtDerivedOff = 0x160;
  dv.setBigInt64(dataOff + vtDerivedOff - 16, 0n, true);
  dv.setBigUint64(dataOff + vtDerivedOff - 8, tiDerivedVa, true);
  dv.setBigUint64(dataOff + vtDerivedOff + 0, fn0, true);
  dv.setBigUint64(dataOff + vtDerivedOff + 8, fn1, true);
  dv.setBigUint64(dataOff + vtDerivedOff + 16, fn2, true);

  const image = {
    imageBase,
    bytes,
    sections: [
      { segment: '__TEXT', name: '__text', address: textVa, size: textSize, fileOffset: textOff, fileSize: textSize },
      { segment: '__TEXT', name: '__cstring', address: cstrVa, size: cstrSize, fileOffset: cstrOff, fileSize: cstrSize },
      { segment: '__DATA_CONST', name: '__const', address: dataVa, size: dataSize, fileOffset: dataOff, fileSize: dataSize },
    ],
  };

  const functions = [
    { start: fn0, end: fn1, name: null },
    { start: fn1, end: fn2, name: null },
    { start: fn2, end: fnHelper, name: null },
    { start: fnHelper, end: textVa + 0x100n, name: null },
  ];

  return {
    image,
    imageBase,
    textVa,
    textLo: textVa,
    textHi: textVa + BigInt(textSize),
    codeBytes: bytes.subarray(textOff, textOff + textSize),
    dataBytes: bytes.subarray(dataOff, dataOff + dataSize),
    dataVa,
    functions,
    addrs: { fn0, fn1, fn2, fnHelper },
  };
}

test('1. wasm-xref-linker.js strictly imports ONLY from ./arm64-insn-bits.js', () => {
  const src = fs.readFileSync(XREF_LINKER_PATH, 'utf8');
  const importMatches = [...src.matchAll(/^\s*import\s+[\s\S]*?\s+from\s+['"]([^'"]+)['"]/gm)];
  assert.equal(importMatches.length, 1, 'wasm-xref-linker.js must have exactly 1 import statement');
  assert.equal(importMatches[0][1], './arm64-insn-bits.js');
  assert.equal(/\bimport\s*\(/.test(src), false, 'wasm-xref-linker.js must not use dynamic import()');
});

test('2. linkWasmStructuralHints preserves exact legacy shape when cxxRtti is omitted', () => {
  const functions = [
    { start: 0x1000n, end: 0x1040n, name: 'sub_1000' },
    { start: 0x1040n, end: 0x1080n, name: 'sub_1040' },
  ];
  const vtables = {
    vtables: [
      { vtableOff: 0x20, va: 0x20020n, firstFnVa: 0x1000n, entryCount: 3, hasRtti: true, encoding: 'absolute' },
    ],
  };

  const res = linkWasmStructuralHints({ functions, vtables });
  assert.equal('cxxMethodLinks' in res.stats, false);
  const entry = res.byFunction['0x1000'];
  assert.ok(entry);
  assert.equal('cxxClass' in entry, false);
  assert.deepEqual(entry.tags, ['vtable_member']);
  assert.equal(res.byFunction['0x1040'], undefined);
});

test('3. linkWasmStructuralHints links all cxxRtti slots with cxxClass metadata and cxx_method tag', () => {
  const functions = [
    { start: 0x1000n, end: 0x1040n, name: null },
    { start: 0x1040n, end: 0x1080n, name: null },
    { start: 0x1080n, end: 0x10c0n, name: null },
  ];
  const cxxRtti = {
    classes: [
      { className: 'Game::Wallet', rttiVa: 0x20060n, baseClassNames: ['Game::Base'] },
    ],
    byRttiVa: new Map([
      [0x20060n, { className: 'Game::Wallet', rttiVa: 0x20060n, baseClassNames: ['Game::Base'] }],
    ]),
    byFunction: new Map([
      [0x1000n, { fnVa: 0x1000n, primaryOwner: 'Game::Base', primaryRttiVa: 0x20020n, slotIndex: 0, isShared: false, sharedOwners: [] }],
      [0x1040n, { fnVa: 0x1040n, primaryOwner: 'Game::Wallet', primaryRttiVa: 0x20060n, slotIndex: 1, isShared: false, sharedOwners: [] }],
      [0x1080n, { fnVa: 0x1080n, primaryOwner: null, primaryRttiVa: null, slotIndex: 2, isShared: true, sharedOwners: ['Game::A', 'Game::B'] }],
    ]),
  };

  const res = linkWasmStructuralHints({ functions, cxxRtti });
  assert.equal(res.stats.cxxMethodLinks, 3);
  assert.equal(res.stats.functionsLinked, 3);

  const e1 = res.byFunction['0x1040'];
  assert.ok(e1);
  assert.deepEqual(e1.cxxClass, {
    primaryOwner: 'Game::Wallet',
    slotIndex: 1,
    isShared: false,
    sharedOwners: [],
    baseClassNames: ['Game::Base'],
  });
  assert.ok(e1.tags.includes('vtable_member'));
  assert.ok(e1.tags.includes('cxx_method'));

  const e2 = res.byFunction['0x1080'];
  assert.ok(e2);
  assert.equal(e2.cxxClass.primaryOwner, null);
  assert.equal(e2.cxxClass.isShared, true);
  assert.deepEqual(e2.cxxClass.sharedOwners, ['Game::A', 'Game::B']);
});

test('4. runWasmStructuralAnalysis orchestrates RTTI, unifiedMetadata, xrefLinks, callgraph edges, virtualTree, semanticNames, and classFields', () => {
  const syn = buildSyntheticCppImage();
  const { fn0, fn1, fn2, fnHelper } = syn.addrs;

  // Callgraph: fn2 (Wallet) -> fnHelper (unclassified helper)
  const callgraph = {
    numNodes: 4,
    nodes: [fn0, fn1, fn2, fnHelper],
    edgeSrc: Uint32Array.from([2]),
    edgeDst: Uint32Array.from([3]),
  };

  const stringsByFunc = new Map([
    [fn2, ['coin_balance_updated', 'wallet_add_coins']],
  ]);
  const apisByFunc = new Map([
    [fn2, ['CC_SHA256']],
  ]);

  const out = runWasmStructuralAnalysis({
    codeBytes: syn.codeBytes,
    image: syn.image,
    dataSections: [
      { name: '__DATA_CONST.__const', bytes: syn.dataBytes, va: syn.dataVa },
    ],
    imageBase: syn.imageBase,
    textVa: syn.textVa,
    textLo: syn.textLo,
    textHi: syn.textHi,
    functions: syn.functions,
    callgraph,
    stringsByFunc,
    apisByFunc,
    arch: 'arm64',
  });

  // Callgraph preserves edgeSrc / edgeDst for downstream Tier 3 & callerOwners
  assert.ok(out.callgraph);
  assert.ok(out.callgraph.edgeSrc instanceof Uint32Array);
  assert.ok(out.callgraph.edgeDst instanceof Uint32Array);
  assert.equal(out.callgraph.edgeSrc.length, 1);

  // T1: RTTI resolution
  assert.ok(out.cxxRtti, 'cxxRtti must be populated');
  assert.equal(out.cxxRtti.byFunction.get(fn0)?.primaryOwner, 'Game::System::Coin::Base');
  assert.equal(out.cxxRtti.byFunction.get(fn2)?.primaryOwner, 'Game::System::Coin::Wallet');
  assert.equal(out.cxxRtti.byFunction.get(fn2)?.slotIndex, 2);

  // T9: Unified metadata
  assert.ok(out.unifiedMetadata);
  assert.ok(out.unifiedMetadata.stats.cppClasses >= 2);

  // T2: xrefLinks full-slot binding
  assert.ok(out.xrefLinks);
  assert.equal(out.xrefLinks.byFunction[`0x${fn2.toString(16)}`]?.cxxClass?.primaryOwner, 'Game::System::Coin::Wallet');
  assert.ok(out.xrefLinks.byFunction[`0x${fn2.toString(16)}`]?.tags.includes('cxx_method'));

  // T3: Virtual folder tree (Tier 1 + Tier 3 callgraph propagation)
  assert.ok(out.virtualTree);
  assert.ok(out.virtualTree.functionToFolderId.has(fn2));
  const helperFolderId = out.virtualTree.functionToFolderId.get(fnHelper);
  assert.ok(helperFolderId, 'fnHelper should be placed in virtualTree');
  const helperNode = out.virtualTree.nodes.get(helperFolderId);
  assert.equal(helperNode?.kind, 'helpers', 'fnHelper called only by Wallet should propagate to helpers folder');

  // T4: Semantic names
  assert.ok(out.semanticNames);
  const fn2Card = out.semanticNames.byFunction.get(fn2);
  assert.ok(fn2Card);
  assert.equal(fn2Card.ownerClass, 'Game::System::Coin::Wallet');
  assert.equal(fn2Card.naming.confidence, 'high');

  // T8: Class fields from RMW hit at offset 0x18 inside fn2
  assert.ok(out.classFields);
  const walletLayout = out.classFields.layouts.get('Game::System::Coin::Wallet');
  assert.ok(walletLayout, 'Wallet field layout must be aggregated from ARM64 RMW hit');
  assert.ok(walletLayout.fields.some((f) => f.offset === 0x18));
});

test('5. runWasmStructuralAnalysis fails closed on empty or malformed inputs', () => {
  const empty = runWasmStructuralAnalysis({});
  assert.equal(empty.cxxRtti, null);
  assert.equal(empty.unifiedMetadata, null);
  assert.equal(empty.virtualTree, null);
  assert.equal(empty.semanticNames, null);
  assert.equal(empty.classFields, null);
});

test('6. autoAnalyze runs WASM/RTTI analysis before rankCandidates and feeds classOwners into goal ranking', async () => {
  const syn = buildSyntheticCppImage();
  const { fn0, fn1, fn2, fnHelper } = syn.addrs;
  const funcs = BigUint64Array.from([fn0, fn1, fn2, fnHelper]);

  const symbols = {
    funcs,
    functionCount: funcs.length,
    addrs: BigUint64Array.from([]),
    names: [],
    nameAt: () => null,
    functionList: () => syn.functions.map((f) => ({ addr: f.start, end: f.end, name: null })),
  };

  const program = {
    architecture: 'arm64',
    functionsReferencing: () => [],
    functionRange: (va) => syn.functions.find((f) => va >= f.start && va < f.end) || null,
    calleesOf: () => [],
    callersOf: () => [],
    callCountOf: () => 0,
    statsOf: () => ({ total: 4, numeric: 1, store: 1, cmp: 0, covered: true }),
  };

  const report = await autoAnalyze({
    strings: [],
    program,
    symbols,
    image: syn.image,
    codeBytes: syn.codeBytes,
    region: { vmAddr: syn.textVa, size: 0x1000n, bytes: syn.codeBytes },
    deepLimit: 0,
    pinpointBudget: 0,
  });

  assert.ok(report.wasmAnalysis, 'report.wasmAnalysis must be populated');
  assert.ok(report.wasmAnalysis.cxxRtti, 'report.wasmAnalysis.cxxRtti must be populated');

  // Currency/coin goal should rank fn2 (Game::System::Coin::Wallet) via REASON.CLASS_OWNER
  // even with zero strings and zero symbols!
  const coinGoal = report.goals.find((g) => g.goal.id === 'currency' || g.candidates.some((c) => c.addr === fn2));
  assert.ok(coinGoal, 'a goal should match restored C++ class Game::System::Coin::Wallet');
  const walletCandidate = coinGoal.candidates.find((c) => c.addr === fn2 || c.addr === fn0);
  assert.ok(walletCandidate, 'restored C++ class method must appear in ranked candidates');
  assert.ok(
    walletCandidate.reasons.some((r) => r.code === 'class-owner'),
    'ranked candidate must carry class-owner reason from pre-rank RTTI analysis',
  );
});

test('7. autoAnalyze respects cancellation before WASM/RTTI phase', async () => {
  const syn = buildSyntheticCppImage();
  let calls = 0;
  const report = await autoAnalyze({
    strings: [],
    image: syn.image,
    codeBytes: syn.codeBytes,
    region: { vmAddr: syn.textVa, size: 0x1000n, bytes: syn.codeBytes },
    isCancelled: () => ++calls >= 1,
    deepLimit: 0,
    pinpointBudget: 0,
  });

  assert.ok(report.notes.includes('cancelled'));
  assert.equal(report.wasmAnalysis, null);
});
