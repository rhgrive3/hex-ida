import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { attachV6Workbench } from '../js/ui/v6-workbench-bridge.js';
import { PRIMARY_NAV } from '../js/ui/registry.js';
import { encodeHsig1Pack } from '../js/analysis/signature/hex-sig-pack.js';
import { HEXSIG_ARCH_ARM64, fnv1a64 } from '../js/analysis/signature/hex-sig-extractor.js';
import { gzipSync } from '../js/vendor/fflate.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function buildFlattenedCffCfg() {
  // OLLVM-style flattened CFG: entry -> dispatcher -> (b2 -> b3 -> b4 -> b5[ret])
  return {
    entryBlock: 0,
    stateVar: 'state',
    blocks: [
      {
        id: 0,
        insts: [{ op: 'const', dst: 'state', value: 0x11n }],
        succs: [1],
      },
      {
        id: 1,
        stateVar: 'state',
        insts: [],
        succs: [2, 3, 4, 5],
        dispatchCases: {
          '0x11': 2,
          '0x22': 3,
          '0x33': 4,
          '0x44': 5,
        },
      },
      {
        id: 2,
        insts: [
          { op: 'add', dst: 'r0', srcs: ['r1', 'r2'] },
          { op: 'const', dst: 'state', value: 0x22n },
        ],
        succs: [1],
      },
      {
        id: 3,
        insts: [
          { op: 'csel', dst: 'state', condInstId: 7, trueVal: 0x33n, falseVal: 0x44n },
        ],
        succs: [1],
      },
      {
        id: 4,
        insts: [
          { op: 'const', dst: 'state', value: 0x44n },
        ],
        succs: [1],
      },
      {
        id: 5,
        insts: [{ op: 'ret' }],
        succs: [],
      },
    ],
  };
}

function buildLinearMbaAddDag() {
  // (x ^ y) + 2 * (x & y)  ===  x + y
  const x = { op: 'var', name: 'x', width: 64 };
  const y = { op: 'var', name: 'y', width: 64 };
  const two = { op: 'const', value: 2n, width: 64 };
  return {
    op: 'add',
    width: 64,
    a: { op: 'xor', width: 64, a: x, b: y },
    b: {
      op: 'mul',
      width: 64,
      a: two,
      b: { op: 'and', width: 64, a: x, b: y },
    },
  };
}

function buildSampleHsig1Pack() {
  const pattern = new Uint8Array(32);
  const mask = new Uint8Array(32);
  // ARM64 STP x29, x30, [sp, #-16]! ; MOV x29, sp ; RET
  const raw = [0xfd, 0x7b, 0xbf, 0xa9, 0xfd, 0x03, 0x00, 0x91, 0xc0, 0x03, 0x5f, 0xd6];
  pattern.set(raw, 0);
  mask.fill(0xff, 0, raw.length);
  return encodeHsig1Pack({
    archMask: HEXSIG_ARCH_ARM64,
    entries: [
      {
        symbolName: 'deflateInit2_',
        arch: HEXSIG_ARCH_ARM64,
        prologueLen: raw.length,
        minFuncLen: raw.length,
        libId: 1,
        baseConfidence: 900,
        pattern,
        wildcardMask: mask,
        patternHash64: fnv1a64(pattern.subarray(0, raw.length)),
      },
    ],
  });
}

test('Invariants & app.js minimal wiring hooks remain intact', () => {
  assert.equal(PRIMARY_NAV.length, 4, 'PRIMARY_NAV.length must remain 4');
  const appSrc = fs.readFileSync(path.join(ROOT, 'js/app.js'), 'utf8');
  assert.ok(appSrc.includes('this.v6Workbench = this.v6;'), 'js/app.js must expose v6Workbench alias');
  assert.ok(
    appSrc.includes('this.v6Workbench?.ingestWasmAnalysis?.('),
    'js/app.js must wire report.wasmAnalysis into v6Workbench.ingestWasmAnalysis'
  );
  assert.ok(appSrc.includes('demangleSymbolName('), 'js/app.js must expose demangleSymbolName delegation');
  assert.ok(appSrc.includes('getFunctionEnrichment('), 'js/app.js must expose getFunctionEnrichment delegation');
});

test('1. symbol-demangler wiring: C++, Rust v0/Legacy, Swift, and plain symbol passthrough', () => {
  const wb = attachV6Workbench({});

  const cpp = wb.demangleDisplayName('_ZN4Game6Player6damageEi');
  assert.ok(cpp.includes('Game::Player::damage'), `expected C++ demangled name, got "${cpp}"`);

  const rustLegacy = wb.demangleDisplayName('_ZN4core3ptr13drop_in_place17h0123456789abcdefE');
  assert.equal(rustLegacy, 'core::ptr::drop_in_place');

  const rustV0 = wb.demangleDisplayName('_RNvCs1234_4game4tick');
  assert.equal(rustV0, 'game::tick');

  const swift = wb.demangleDisplayName('$s4Game6PlayerC4tickyyF');
  assert.ok(swift.includes('Game.Player.tick'), `expected Swift demangled name, got "${swift}"`);

  assert.equal(wb.demangleDisplayName('player_update'), 'player_update');
  assert.equal(wb.demangleDisplayName('sub_100004000'), 'sub_100004000');
  assert.equal(wb.demangleDisplayName(''), '');
});

test('2. hexsig-hub-loader lazy wiring & HSIG1 raw/gzip pack mounting', () => {
  const wb = attachV6Workbench({});
  assert.equal(wb._hexsigHubLoader, null, 'HexSigHubLoader must stay lazily uninitialized on construct');

  const loader1 = wb.getHexSigHubLoader();
  const loader2 = wb.getHexSigHubLoader();
  assert.strictEqual(loader1, loader2, 'getHexSigHubLoader() must memoize default loader');
  assert.equal(typeof loader1.listPacks, 'function');
  assert.equal(typeof loader1.mountToIndex, 'function');
  assert.equal(typeof loader1.mountToWasm, 'function');

  const packBytes = buildSampleHsig1Pack();
  const mounted = wb.mountHexSigPack(packBytes, {
    packId: 'zlib_arm64_raw',
    libId: 1,
    libName: 'zlib',
    vendor: 'madler',
  });
  assert.equal(mounted.ok, true);
  assert.equal(mounted.entryCount, 1);
  assert.equal(wb.hexsigIndex.entries.length, 1);
  assert.equal(wb.hexsigIndex.getLib(1)?.libName, 'zlib');

  // Also verify gzip-compressed .hsig1.gz transparent mounting
  const gzBytes = gzipSync(packBytes);
  const mountedGz = wb.mountHexSigPack(gzBytes, {
    packId: 'zlib_arm64_gz',
    _engine: 'js',
  });
  assert.equal(mountedGz.ok, true);
  assert.equal(mountedGz.entryCount, 1);
  assert.equal(wb.hexsigIndex.entries.length, 2);

  // Fail-closed on invalid bytes
  const bad = wb.mountHexSigPack(new Uint8Array([0, 1, 2, 3]), { packId: 'corrupt' });
  assert.equal(bad.ok, false);
});

test('3. CFF + MBA deobfuscation pass records annotations into deobfOverlay', () => {
  const wb = attachV6Workbench({});
  const funcVa = 0x100004000n;
  const mbaInsnVa = 0x100004018n;

  const summary = wb.runDeobfuscationPass({
    funcVa,
    cfg: buildFlattenedCffCfg(),
    mbaNodes: [{ insnVa: mbaInsnVa, dag: buildLinearMbaAddDag() }],
    opts: { preferWasm: false },
  });

  assert.equal(summary.funcVa, '0x100004000');
  assert.equal(summary.cffRecovered, true);
  assert.equal(summary.cff.stats.realBlocks, 4);
  assert.equal(summary.mba.total, 1);
  assert.equal(summary.mba.simplifiedCount, 1);
  assert.equal(summary.mba.results[0].expr.op, 'add');
  assert.ok(summary.overlayCount >= 2);

  const fnOverlay = wb.deobfOverlay.getAnnotation(funcVa);
  assert.ok(fnOverlay, 'function-level overlay must be recorded in deobfOverlay');
  assert.ok(fnOverlay.text.includes('CFF recovered'));
  assert.ok(fnOverlay.text.includes('MBA simplified'));

  const insnOverlay = wb.deobfOverlay.getAnnotation(mbaInsnVa);
  assert.ok(insnOverlay, 'per-instruction MBA overlay must be recorded in deobfOverlay');
});

test('4. STL pattern recognizer wiring & mangled symbol expansion', () => {
  const wb = attachV6Workbench({});

  const vecRes = wb.recognizeStlPattern({
    funcVa: 0x100004000n,
    structSize: 24,
    ptrSize: 8,
    fields: [
      { offset: 0, size: 8 },
      { offset: 8, size: 8 },
      { offset: 16, size: 8 },
    ],
    accessPatterns: ['end_eq_cap_grow'],
    symbols: ['_ZNSt3__16vectorIiE9push_backEi'],
  });
  assert.equal(vecRes.recognized, true);
  assert.equal(vecRes.primary.kind, 'std::vector');
  assert.ok(wb.stlRecognizer.cacheSize >= 1);

  const spRes = wb.recognizeStlPattern({
    funcVa: 0x100005000n,
    structSize: 16,
    ptrSize: 8,
    fields: [
      { offset: 0, size: 8 },
      { offset: 8, size: 8 },
    ],
    accessPatterns: ['atomic_refcount_rmw'],
  });
  assert.equal(spRes.recognized, true);
  assert.equal(spRes.primary.kind, 'std::shared_ptr');
});

test('5. ingestWasmAnalysis -> getFunctionEnrichment end-to-end integration & detach cleanup', () => {
  const funcVa = 0x100004000n;
  const fakeApp = {
    symbols: {
      nameAt(va) {
        return va === funcVa ? '_ZN4Game6Player6damageEi' : null;
      },
    },
    notes: {
      names: new Map(),
      types: new Map(),
      structs: [],
    },
  };

  const wb = attachV6Workbench(fakeApp);

  // Mount a deferred TIL signature entry to verify tilResolver.resolveSymbol integration
  wb.tilResolver.userHeader = {
    packId: 'game-sdk-test',
    view: null,
    deferredTable: {
      lookupFunction(name) {
        if (name === '_ZN4Game6Player6damageEi' || name.includes('Game::Player::damage')) {
          return {
            name: 'Game::Player::damage',
            signature: 'void Game::Player::damage(Player* self, int amount)',
            returnType: 'void',
          };
        }
        return null;
      },
    },
  };

  // Populate deobfOverlay and STL cache for funcVa
  wb.runDeobfuscationPass({
    funcVa,
    cfg: buildFlattenedCffCfg(),
    mbaNodes: [{ insnVa: 0x100004010n, dag: buildLinearMbaAddDag() }],
    opts: { preferWasm: false },
  });
  wb.recognizeStlPattern({
    funcVa,
    structSize: 24,
    ptrSize: 8,
    fields: [
      { offset: 0, size: 8 },
      { offset: 8, size: 8 },
      { offset: 16, size: 8 },
    ],
    accessPatterns: ['end_eq_cap_grow'],
  });

  // Ingest full wasmAnalysis payload across all 8 domains
  const ingestRes = wb.ingestWasmAnalysis({
    textVa: 0x100000000n,
    rmw: {
      hits: [
        { loadOff: 0x4020, storeOff: 0x4028, baseReg: 0, disp: 0x18 },
        { funcVa: 0x100004000n, loadOff: 0x4040, storeOff: 0x4044, baseReg: 0, disp: 0x20 },
      ],
    },
    x86Rmw: {
      hits: [{ va: 0x100004050n, op: 'add' }],
    },
    vtables: {
      vtables: [{ vtableOff: 0x200, va: 0x100020200n, firstFnVa: funcVa, entryCount: 4, hasRtti: true }],
    },
    jumpTables: {
      tables: [{ funcVa, va: 0x100004080n, entries: 5 }],
    },
    constTables: {
      tables: [{ va: 0x100030000n, byteLen: 64, kind: 1, elementCount: 16 }],
    },
    objcSwift: {
      sectionsScanned: ['__DATA_CONST.__objc_classlist'],
      classes: [],
    },
    xrefLinks: {
      byFunction: {
        '0x100004000': {
          start: funcVa,
          end: 0x100004100n,
          name: '_ZN4Game6Player6damageEi',
          vtableRefs: [{ vtableVa: 0x100020200n, entryCount: 4, hasRtti: true }],
          constTableRefs: [{ tableVa: 0x100030000n, byteLen: 64, kind: 1, elementCount: 16 }],
          tags: ['vtable_member', 'const_f32_ref'],
        },
      },
      stats: { functionsInput: 1, functionsLinked: 1, vtableLinks: 1, constTableLinks: 1 },
    },
    callgraph: {
      nodes: [funcVa, 0x100005000n],
      role: new Uint8Array([2, 1]), // 2=dispatcher, 1=leaf_compute
      score: new Uint32Array([840, 120]),
      scc: new Uint32Array([0, 1]),
    },
  });

  assert.equal(ingestRes.ok, true);
  assert.equal(ingestRes.counts.rmw, 2);
  assert.equal(ingestRes.counts.x86Rmw, 1);
  assert.equal(ingestRes.counts.vtables, 1);
  assert.equal(ingestRes.counts.jumpTables, 1);
  assert.equal(ingestRes.counts.constTables, 1);
  assert.equal(ingestRes.counts.xrefFunctions, 1);
  assert.equal(ingestRes.counts.callgraphNodes, 2);
  assert.equal(ingestRes.counts.objcSwiftSections, 1);

  const enriched = wb.getFunctionEnrichment(funcVa);
  assert.equal(enriched.funcVa, '0x100004000');
  assert.equal(enriched.rawName, '_ZN4Game6Player6damageEi');
  assert.ok(enriched.displayName.includes('Game::Player::damage'));
  assert.equal(enriched.tilSignature?.signature, 'void Game::Player::damage(Player* self, int amount)');

  assert.equal(enriched.wasmHints.available, true);
  assert.equal(enriched.wasmHints.vtableRefs.length, 1);
  assert.equal(enriched.wasmHints.constTableRefs.length, 1);
  assert.deepEqual(enriched.wasmHints.tags, ['vtable_member', 'const_f32_ref']);
  assert.equal(enriched.wasmHints.callgraph?.roleName, 'dispatcher');
  assert.equal(enriched.wasmHints.callgraph?.score, 840);
  assert.equal(enriched.wasmHints.rmwHitCount, 3, 'must aggregate direct funcVa + range ARM64/x86 RMW hits');
  assert.equal(enriched.wasmHints.jumpTableCount, 1);
  assert.equal(enriched.wasmHints.hasObjcSwift, true);

  assert.equal(enriched.deobfOverlay.hasOverlay, true);
  assert.equal(enriched.deobfOverlay.summary?.cffRecovered, true);
  assert.equal(enriched.stl?.recognized, true);
  assert.equal(enriched.stl?.primary?.kind, 'std::vector');

  // Detach must clear all ingested state cleanly
  wb.detach();
  const afterDetach = wb.getFunctionEnrichment(funcVa);
  assert.equal(afterDetach.wasmHints.available, false);
  assert.equal(afterDetach.deobfOverlay.hasOverlay, false);
  assert.equal(afterDetach.stl, null);
});
