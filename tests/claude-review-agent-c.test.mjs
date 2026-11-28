import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { proveFunctionEnd, trimModelToProvenEnd } from '../js/analysis/function-end-proof.js';
import { buildSemanticModel } from '../js/blocks.js';
import { App } from '../js/app.js';
import { Store } from '../js/state.js';
import { createAppAnalysisQueryAdapter } from '../js/analysis/query/app-adapter.js';
import { AnalysisQueryAPI } from '../js/analysis/query/index.js';
import { analyzeFunctionCached, clearAnalysisCache } from '../js/analyze.js';
import { openBinary } from './harness.mjs';

function makeModel(rows, startAddr = 0x1000n, symMap = new Map()) {
  const raw = rows.map(([mn, ops = ''], i) => ({
    row: i,
    address: startAddr + BigInt(i) * 4n,
    mn,
    ops,
  }));
  const rowOfAddress = (addr) => {
    const d = BigInt(addr) - startAddr;
    if (d < 0n || d % 4n !== 0n) return null;
    const r = Number(d / 4n);
    return r >= 0 && r < raw.length ? r : null;
  };
  const symbolFor = (addr) => symMap.get(BigInt(addr)) ?? null;
  return buildSemanticModel(raw, {
    startRow: 0,
    endRow: raw.length - 1,
    rowOfAddress,
    symbolFor,
    name: 'test_fn',
  });
}

function makeRange(start, end) {
  return {
    ok: true,
    start,
    end,
    function: { start, end: null },
    complete: false,
    reason: 'function-end-unproven',
    provenance: 'executable-region+analysis-window',
  };
}

test('Bug #1 proveFunctionEnd: proves ret / retaa / retab, b windowEnd, br x16/x17, noreturn bl, and traps', () => {
  // 1. ret with trailing unreachable padding
  {
    const model = makeModel([
      ['mov', 'x0, #1'],
      ['ret', ''],
      ['nop', ''],
      ['.word', '0xdeadbeef'],
    ]);
    const proof = proveFunctionEnd(model, makeRange(0x1000n, 0x1010n));
    assert.deepEqual(proof, {
      proven: true,
      provenEnd: 0x1008n,
      reason: null,
      provenance: 'macho-function-starts+cfg-proven-end',
    });
  }

  // 2. retaa / retab
  for (const retMn of ['retaa', 'retab']) {
    const model = makeModel([
      ['paciasp', ''],
      ['mov', 'w0, #0'],
      [retMn, ''],
    ]);
    const proof = proveFunctionEnd(model, makeRange(0x1000n, 0x100cn));
    assert.equal(proof.proven, true, `${retMn} should prove end`);
    assert.equal(proof.provenEnd, 0x100cn);
  }

  // 3. Unconditional tail call `b windowEnd` (target === windowEnd)
  {
    const model = makeModel([
      ['mov', 'x0, x1'],
      ['b', '#0x1008'],
    ]);
    const proof = proveFunctionEnd(model, makeRange(0x1000n, 0x1008n));
    assert.equal(proof.proven, true);
    assert.equal(proof.provenEnd, 0x1008n);
  }

  // 4. PLT/GOT/ObjC tail-call stubs `br x16` and `br x17`
  for (const reg of ['x16', 'x17']) {
    const model = makeModel([
      ['adrp', `${reg}, #0x4000`],
      ['ldr', `${reg}, [${reg}, #0x10]`],
      ['br', reg],
    ]);
    const proof = proveFunctionEnd(model, makeRange(0x1000n, 0x100cn));
    assert.equal(proof.proven, true, `br ${reg} should prove end`);
    assert.equal(proof.provenEnd, 0x100cn);
  }

  // 5. Known noreturn call `bl ___stack_chk_fail` on one branch, `ret` on the other
  {
    const symsMap = new Map([[0x5000n, '___stack_chk_fail']]);
    const symbols = { nameAt: (a) => symsMap.get(BigInt(a)) ?? null };
    const model = makeModel([
      ['cbnz', 'x0, #0x1008'],
      ['ret', ''],
      ['bl', '#0x5000'],
    ], 0x1000n, symsMap);
    const proof = proveFunctionEnd(model, makeRange(0x1000n, 0x100cn), symbols);
    assert.equal(proof.proven, true);
    assert.equal(proof.provenEnd, 0x100cn);
  }

  // 6. Explicit trap `brk` / `udf`
  for (const trap of [['brk', '#0x1'], ['udf', '#0']]) {
    const model = makeModel([
      ['cbz', 'x0, #0x1008'],
      ['ret', ''],
      trap,
    ]);
    const proof = proveFunctionEnd(model, makeRange(0x1000n, 0x100cn));
    assert.equal(proof.proven, true, `${trap[0]} should prove end`);
    assert.equal(proof.provenEnd, 0x100cn);
  }
});

test('Bug #1 proveFunctionEnd: rejects generic br x8, windowEnd fallthrough, external cond branch, undecoded insn, truncated', () => {
  // 1. Generic indirect branch br x8
  {
    const model = makeModel([
      ['adrp', 'x8, #0x2000'],
      ['br', 'x8'],
    ]);
    const proof = proveFunctionEnd(model, makeRange(0x1000n, 0x1008n));
    assert.deepEqual(proof, { proven: false, reason: 'function-end-unproven' });
  }

  // 2. Fallthrough to windowEnd
  {
    const model = makeModel([
      ['mov', 'x0, #1'],
      ['add', 'x0, x0, #2'],
    ]);
    const proof = proveFunctionEnd(model, makeRange(0x1000n, 0x1008n));
    assert.deepEqual(proof, { proven: false, reason: 'function-end-unproven' });
  }

  // 3. Conditional branch outside [start, windowEnd)
  {
    const model = makeModel([
      ['cbz', 'x0, #0x1008'],
      ['ret', ''],
    ]);
    const proof = proveFunctionEnd(model, makeRange(0x1000n, 0x1008n));
    assert.deepEqual(proof, { proven: false, reason: 'function-end-unproven' });
  }

  // 4. Reachable undecoded instruction (.word)
  {
    const model = makeModel([
      ['mov', 'x0, #1'],
      ['.word', '0x12345678'],
      ['ret', ''],
    ]);
    const proof = proveFunctionEnd(model, makeRange(0x1000n, 0x100cn));
    assert.deepEqual(proof, { proven: false, reason: 'function-end-unproven' });
  }

  // 5. Truncated model
  {
    const model = { ...makeModel([['ret', '']]), truncated: true };
    const proof = proveFunctionEnd(model, makeRange(0x1000n, 0x1004n));
    assert.deepEqual(proof, { proven: false, reason: 'function-end-unproven' });
  }

  // 6. Resolved `br x16` jump table must follow targets instead of truncating at `br x16`
  {
    const model = makeModel([
      ['adr', 'x16, #0x1010'],
      ['add', 'x16, x16, x0, lsl #2'],
      ['br', 'x16'],
      ['mov', 'x0, #1'],
      ['ret', ''],
      ['mov', 'x0, #2'],
      ['ret', ''],
      ['nop', ''],
    ]);
    model.jumpTables = [{ branchRow: 2, branchAddress: 0x1008n, targets: [0x100cn, 0x1014n] }];
    const proof = proveFunctionEnd(model, makeRange(0x1000n, 0x1020n));
    assert.equal(proof.proven, true, 'resolved br x16 jump table should prove end past all targets');
    assert.equal(proof.provenEnd, 0x101cn, 'provenEnd must cover the furthest jump table target, not stop at br x16');
  }

  // 7. Unresolved `br x16` switch must return proven: false
  {
    const model = makeModel([
      ['adrp', 'x16, #0x4000'],
      ['add', 'x16, x16, #0x20'],
      ['ldrsw', 'x17, [x16, x0, lsl #2]'],
      ['add', 'x16, x16, x17'],
      ['br', 'x16'],
      ['ret', ''],
    ]);
    const proof = proveFunctionEnd(model, makeRange(0x1000n, 0x1018n));
    assert.deepEqual(proof, { proven: false, reason: 'function-end-unproven' });
  }

  // 8. ELF provenance is preserved instead of hardcoded macho-function-starts
  {
    const model = makeModel([
      ['mov', 'x0, #1'],
      ['ret', ''],
    ]);
    const elfRange = {
      ...makeRange(0x1000n, 0x1008n),
      provenance: 'elf-loader-contract+section-analysis-window',
    };
    const proof = proveFunctionEnd(model, elfRange);
    assert.equal(proof.proven, true);
    assert.equal(proof.provenance, 'elf-loader-contract+cfg-proven-end');
  }
});

test('Bug #1 trimModelToProvenEnd: non-destructively trims instructions/blocks/semantic/endRow/blockOfRow', () => {
  const model = makeModel([
    ['mov', 'x0, #42'],
    ['ret', ''],
    ['nop', ''],
    ['nop', ''],
  ]);
  const origInsnLen = model.instructions.length;
  const origEndRow = model.endRow;
  const origBasicLen = model.basicBlocks.length;
  const origSemanticLen = model.semantic.length;

  const trimmed = trimModelToProvenEnd(model, 0x1008n);

  // Original cached model is untouched
  assert.notEqual(trimmed, model);
  assert.equal(model.instructions.length, origInsnLen);
  assert.equal(model.endRow, origEndRow);
  assert.equal(model.basicBlocks.length, origBasicLen);
  assert.equal(model.semantic.length, origSemanticLen);

  // Trimmed model is consistent within provenEnd
  assert.equal(trimmed.instructions.length, 2);
  assert.equal(trimmed.endRow, 1);
  assert.ok(trimmed.basicBlocks.every((b) => b.endRow <= 1));
  assert.ok(trimmed.semantic.every((b) => b.endRow <= 1));
  assert.ok(trimmed.blockOfRow(0) != null);
  assert.ok(trimmed.blockOfRow(1) != null);
  assert.equal(trimmed.blockOfRow(2), null);
});

test('Bug #1 + Agent E contract: App.analyzeFunctionAt and app-adapter promote proven Mach-O functions without cache mutation, keep br x8 partial, and pass prototype + allowGeneralObjcWasm', async () => {
  clearAnalysisCache();
  const region = { id: 'text0', vmAddr: 0x1000n, size: 0x40n, exec: true, name: '__TEXT,__text' };

  // Two functions in the same region:
  // 0x1000..0x1010: mov x0, #7; ret; nop; nop (closed at 0x1008)
  // 0x1010..0x1018: adrp x8, #0x2000; br x8   (unproven indirect branch)
  const chunkRows = [
    { addr: 0x1000n, mn: 'mov', ops: 'x0, #7', word: 0xd28000e0 },
    { addr: 0x1004n, mn: 'ret', ops: '', word: 0xd65f03c0 },
    { addr: 0x1008n, mn: 'nop', ops: '', word: 0xd503201f },
    { addr: 0x100cn, mn: 'nop', ops: '', word: 0xd503201f },
    { addr: 0x1010n, mn: 'adrp', ops: 'x8, #0x2000', word: 0x90000008 },
    { addr: 0x1014n, mn: 'br', ops: 'x8', word: 0xd61f0100 },
  ];

  const backend = {
    gen: 1,
    binaryId: 'test-macho-agent-c',
    async fetchChunk() {
      const bytes = new Uint8Array(chunkRows.length * 4);
      const dv = new DataView(bytes.buffer);
      chunkRows.forEach((r, i) => dv.setUint32(i * 4, r.word >>> 0, true));
      return {
        mn: chunkRows.map((r) => r.mn),
        ops: chunkRows.map((r) => r.ops),
        bytes,
      };
    },
    async readAt() {
      return { found: false };
    },
  };

  let prototypeQueries = [];
  const fn1Proto = { returnType: 'int', params: [{ name: 'x', type: 'int' }], signature: 'int fn_closed(int x)' };
  const symbols = {
    functionCount: 2,
    functionAt(addr) {
      const a = BigInt(addr);
      if (a >= 0x1000n && a < 0x1010n) return { start: 0x1000n, end: null, name: '_fn_closed' };
      if (a >= 0x1010n && a < 0x1018n) return { start: 0x1010n, end: null, name: '_fn_indirect' };
      return null;
    },
    functionWindowBound(start) {
      const s = BigInt(start);
      if (s === 0x1000n) return 0x1010n;
      if (s === 0x1010n) return 0x1018n;
      return null;
    },
    nameAt(addr) {
      const a = BigInt(addr);
      if (a === 0x1000n) return '_fn_closed';
      if (a === 0x1010n) return '_fn_indirect';
      return null;
    },
    label(addr) {
      return this.nameAt(addr);
    },
    functionPrototypeAt(addr) {
      prototypeQueries.push(BigInt(addr));
      return BigInt(addr) === 0x1000n ? fn1Proto : null;
    },
  };

  const store = new Store();
  store.set({
    architecture: 'arm64',
    canDisassemble: true,
    instructionAlignment: 4,
    sliceIndex: 0,
    regions: [region],
    currentRegion: region,
    selectedRow: 0,
  });

  const fakeApp = Object.create(App.prototype);
  fakeApp.store = store;
  fakeApp.backend = backend;
  fakeApp.symbols = symbols;
  fakeApp.viewer = {
    rowAddress: () => 0x1000n,
    setBlockOverlay() {},
  };

  // Static contract validatedFunctionRange MUST remain complete: false
  const staticRange = fakeApp.validatedFunctionRange(0x1000n);
  assert.equal(staticRange.ok, true);
  assert.equal(staticRange.complete, false);
  assert.equal(staticRange.reason, 'function-end-unproven');

  // App.analyzeFunctionAt promotes closed function and trims without mutating cache
  const cachedBefore = await analyzeFunctionCached(backend, region, 0, 3, symbols, null, { texts: false });
  assert.equal(cachedBefore.model.instructions.length, 4);

  const appRes = await fakeApp.analyzeFunctionAt(0x1000n);
  assert.equal(appRes.completeness.complete, true);
  assert.equal(appRes.completeness.reason, null);
  assert.equal(appRes.completeness.provenance, 'macho-function-starts+cfg-proven-end');
  assert.equal(appRes.completeness.provenEnd, 0x1008n);
  assert.equal(appRes.endAddress, 0x1008n);
  assert.equal(appRes.model.instructions.length, 2);
  // Cached model must NOT be mutated
  assert.equal(cachedBefore.model.instructions.length, 4);

  // Indirect br x8 stays partial
  const appIndirect = await fakeApp.analyzeFunctionAt(0x1010n);
  assert.equal(appIndirect.completeness.complete, false);
  assert.equal(appIndirect.completeness.reason, 'function-end-unproven');

  // Query API (app-adapter.js) produceFunction + decompile + translationUnit
  const api = new AnalysisQueryAPI(createAppAnalysisQueryAdapter(fakeApp));
  const snap = await api.snapshot();

  const qClosed = await api.function(snap, 0x1000n);
  assert.equal(qClosed.completeness, 'complete');
  assert.equal(qClosed.value.endAddress, 0x1008n);
  assert.equal(qClosed.value.completeness.complete, true);
  assert.equal(qClosed.value.completeness.provenance, 'macho-function-starts+cfg-proven-end');
  assert.equal(qClosed.value.completeness.provenEnd, 0x1008n);
  assert.equal(qClosed.value.model.instructions.length, 2);

  const qIndirect = await api.function(snap, 0x1010n);
  assert.equal(qIndirect.completeness, 'partial');
  assert.equal(qIndirect.value.completeness.complete, false);
  assert.equal(qIndirect.value.completeness.reason, 'function-end-unproven');

  // Agent E contract: decompile & translationUnit both call symbols.functionPrototypeAt(addr)
  prototypeQueries = [];
  const qDec = await api.decompile(snap, 0x1000n);
  assert.equal(qDec.completeness, 'complete');
  assert.ok(prototypeQueries.includes(0x1000n), 'decompile must query symbols.functionPrototypeAt(addr)');

  prototypeQueries = [];
  const qTu = await api.translationUnit(snap, [0x1000n]);
  assert.equal(qTu.completeness, 'complete');
  assert.ok(prototypeQueries.includes(0x1000n), 'translationUnit must query symbols.functionPrototypeAt(addr)');

  // Verify allowGeneralObjcWasm: true is explicitly wired in both decompile and translationUnit
  const adapterSrc = fs.readFileSync('js/analysis/query/app-adapter.js', 'utf8');
  const matches = adapterSrc.match(/allowGeneralObjcWasm:\s*true/g) || [];
  assert.ok(matches.length >= 2, `expected allowGeneralObjcWasm: true in both decompile and translationUnit, found ${matches.length}`);
});

test('Bug #9 Hubs URL 4-environment check: dev root uses dist/ prefix; Node, dist/index.html, and Userscript keep relative paths', () => {
  const fakeApp = Object.create(App.prototype);
  fakeApp.backend = { gen: 1 };
  fakeApp.store = new Store();
  fakeApp.store.set({ sliceIndex: 0, regions: [], architecture: 'arm64' });
  fakeApp.symbols = null;
  fakeApp.notes = null;
  fakeApp.v6Workbench = null;

  const origDoc = globalThis.document;
  try {
    // 1. Node environment (no document)
    delete globalThis.document;
    const nodeP = fakeApp._buildV6AutoProviders(1, 0);
    assert.equal(nodeP.tilManifestUrl, 'til-hub/manifest.json');
    assert.equal(nodeP.tilBaseUrl, 'til-hub');
    assert.equal(nodeP.hexsigManifestUrl, 'hexsig-hub/manifest.json');
    assert.equal(nodeP.hexsigBaseUrl, 'hexsig-hub');

    // 2. Dev root (index.html with <script src="./js/app.js">)
    globalThis.document = {
      querySelector: (sel) => (sel === 'script[src="./js/app.js"]' ? { tagName: 'SCRIPT' } : null),
    };
    const devP = fakeApp._buildV6AutoProviders(1, 0);
    assert.equal(devP.tilManifestUrl, 'dist/til-hub/manifest.json');
    assert.equal(devP.tilBaseUrl, 'dist/til-hub');
    assert.equal(devP.hexsigManifestUrl, 'dist/hexsig-hub/manifest.json');
    assert.equal(devP.hexsigBaseUrl, 'dist/hexsig-hub');

    // 3. Production dist/index.html or Userscript (no ./js/app.js script tag)
    globalThis.document = { querySelector: () => null };
    const prodP = fakeApp._buildV6AutoProviders(1, 0);
    assert.equal(prodP.tilManifestUrl, 'til-hub/manifest.json');
    assert.equal(prodP.tilBaseUrl, 'til-hub');
    assert.equal(prodP.hexsigManifestUrl, 'hexsig-hub/manifest.json');
    assert.equal(prodP.hexsigBaseUrl, 'hexsig-hub');

    // 3b. /embed/chatgpt route uses root-relative hub URLs
    const origLoc = globalThis.location;
    try {
      globalThis.document = { querySelector: () => null };
      globalThis.location = { pathname: '/embed/chatgpt' };
      const embedP = fakeApp._buildV6AutoProviders(1, 0);
      assert.equal(embedP.tilManifestUrl, '/til-hub/manifest.json');
      assert.equal(embedP.tilBaseUrl, '/til-hub');
      assert.equal(embedP.hexsigManifestUrl, '/hexsig-hub/manifest.json');
      assert.equal(embedP.hexsigBaseUrl, '/hexsig-hub');
    } finally {
      if (origLoc === undefined) delete globalThis.location;
      else globalThis.location = origLoc;
    }

    // 4. Explicit override still wins in dev root
    globalThis.document = {
      querySelector: (sel) => (sel === 'script[src="./js/app.js"]' ? { tagName: 'SCRIPT' } : null),
    };
    fakeApp.v6Workbench = {
      _autoAnalysisConfig: {
        tilManifestUrl: 'custom/til.json',
        hexsigManifestUrl: 'custom/hexsig.json',
      },
    };
    const customP = fakeApp._buildV6AutoProviders(1, 0);
    assert.equal(customP.tilManifestUrl, 'custom/til.json');
    assert.equal(customP.hexsigManifestUrl, 'custom/hexsig.json');
  } finally {
    if (origDoc === undefined) delete globalThis.document;
    else globalThis.document = origDoc;
  }
});

test('Bug #1 real-binary TsumTsum (bainary-test): random 200 Mach-O functions achieve >= 80% CFG-proven complete rate (up from 0%)', async () => {
  const fixturePath = 'tests/.real-fixtures/bainary-test';
  assert.ok(fs.existsSync(fixturePath), `real fixture missing: ${fixturePath}`);

  const world = await openBinary(fixturePath);
  const syms = world.symbols;
  const execRegions = world.regions.filter((r) => r?.exec === true && r.size > 0n);
  const fns = syms.functionList().filter((fn) => fn.size == null);
  assert.ok(fns.length >= 200, `expected >= 200 unproven-end functions, got ${fns.length}`);

  // Deterministic PRNG (Mulberry32)
  let seed = 0x51a7c0de;
  const rand = () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  const sampled = [];
  const seen = new Set();
  while (sampled.length < 200 && seen.size < fns.length) {
    const idx = Math.floor(rand() * fns.length);
    if (seen.has(idx)) continue;
    seen.add(idx);
    const fn = syms.functionAt(fns[idx].addr);
    if (!fn || fn.end != null) continue;
    const region = execRegions.find((r) => fn.start >= r.vmAddr && fn.start < r.vmAddr + r.size);
    if (!region) continue;
    const windowEnd = syms.functionAnalysisWindow?.(fn.start)?.end ?? syms.functionWindowBound?.(fn.start) ?? null;
    if (windowEnd == null || windowEnd <= fn.start || windowEnd > region.vmAddr + region.size) continue;
    sampled.push({ fn, region, windowEnd });
  }
  assert.equal(sampled.length, 200, 'must sample exactly 200 Mach-O functions');

  let staticComplete = 0;
  let provenComplete = 0;
  let trimmedCount = 0;

  for (const { fn, region, windowEnd } of sampled) {
    if (fn.end != null) staticComplete++;
    const startRow = Number((fn.start - region.vmAddr) / 4n);
    const endRow = Math.min(Number((windowEnd - region.vmAddr + 3n) / 4n) - 1, Number(region.size / 4n) - 1);
    const res = await analyzeFunctionCached(world.backend, region, startRow, endRow, syms, null, { texts: false });
    const range = {
      ok: true,
      start: fn.start,
      end: windowEnd,
      region,
      function: fn,
      complete: false,
      reason: 'function-end-unproven',
    };
    const origLen = res.model.instructions.length;
    const proof = proveFunctionEnd(res.model, range, syms);
    if (proof.proven) {
      provenComplete++;
      assert.ok(proof.provenEnd > fn.start && proof.provenEnd <= windowEnd);
      const trimmed = trimModelToProvenEnd(res.model, proof.provenEnd);
      assert.equal(res.model.instructions.length, origLen, 'trimModelToProvenEnd must not mutate cached model');
      if (proof.provenEnd < windowEnd) trimmedCount++;
      assert.ok(trimmed.instructions.length > 0 && trimmed.instructions.length <= origLen);
    }
  }

  const rate = provenComplete / sampled.length;
  console.log(`[Agent C TsumTsum 200-fn] static_complete=${staticComplete}/200 (0.0%) -> cfg_proven_complete=${provenComplete}/200 (${(rate * 100).toFixed(1)}%), trimmed=${trimmedCount}`);
  assert.equal(staticComplete, 0);
  assert.ok(rate >= 0.8, `expected >= 80% proven complete rate on TsumTsum, got ${(rate * 100).toFixed(1)}%`);
});
