import test from 'node:test';
import assert from 'node:assert/strict';

import { App } from '../js/app.js';
import { SymbolIndex, EMPTY_INDEX } from '../js/symbols.js';
import { buildFunctionReport as buildLegacyReport } from '../js/report-legacy.js';
import { buildFunctionReport as buildFacadeReport } from '../js/report.js';
import { buildSemanticModel } from '../js/blocks.js';
import { FieldIndex } from '../js/fields.js';
import { streamGemini } from '../js/gemini.js';
import { offsetToColumn, unrolledTablesFromFixed } from '../js/schema.js';

function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function makeObjcMemory() {
  const mem = new Uint8Array(0x4000);
  const dv = new DataView(mem.buffer);
  const p64 = (at, v) => dv.setBigUint64(at, BigInt(v), true);
  const p32 = (at, v) => dv.setUint32(at, Number(v) >>> 0, true);
  const str = (at, s) => {
    for (let i = 0; i < s.length; i++) mem[at + i] = s.charCodeAt(i);
    mem[at + s.length] = 0;
  };
  const classAddr = 0x1000;
  const metaAddr = 0x1100;
  const classRo = 0x1200;
  const metaRo = 0x1300;
  const listAddr = 0x1400;
  const classNameAddr = 0x1800;
  const methodImp = 0x2100;
  p64(0x200, classAddr);
  p64(classAddr + 0, metaAddr);
  p64(classAddr + 32, classRo);
  p64(metaAddr + 0, 0);
  p64(metaAddr + 32, metaRo);
  p64(classRo + 24, classNameAddr);
  p64(classRo + 32, listAddr);
  p64(metaRo + 24, classNameAddr);
  str(classNameAddr, 'Hero');
  p32(listAddr, 24);
  p32(listAddr + 4, 1);
  const entry = listAddr + 8;
  const selAddr = 0x1900;
  const typeAddr = 0x1a00;
  str(selAddr, 'takeDamage:');
  str(typeAddr, 'v16@0:8');
  p64(entry + 0, selAddr);
  p64(entry + 8, typeAddr);
  p64(entry + 16, methodImp);
  return { mem, methodImp: BigInt(methodImp) };
}

function makeSwiftMemory() {
  const mem = new Uint8Array(0x10000);
  const put = (a, b) => mem.set(b, Number(a));
  const u32 = (v) => Uint8Array.of(v & 255, (v >>> 8) & 255, (v >>> 16) & 255, (v >>> 24) & 255);
  const i32 = (v) => u32(v >>> 0);
  const rel = (f, t) => i32(Number(BigInt(t) - BigInt(f)));
  const str = (s) => new TextEncoder().encode(s + '\0');
  const SEC = 0x1000n;
  const T = 0x2000n;
  const N = 0x3000n;
  const IMPL = 0x5000n;
  put(SEC, rel(SEC, T));
  put(T, new Uint8Array(64));
  put(T, u32(0x80000010));
  put(T + 8n, rel(T + 8n, N));
  put(N, str('HeroSwift'));
  put(T + 44n, u32(0));
  put(T + 48n, u32(1));
  put(T + 52n, u32(0x10));
  put(T + 56n, rel(T + 56n, IMPL));
  return { mem, secAddr: SEC, implAddr: IMPL };
}

function makeMockApp({ regions, mem, sliceIndex = 0, analysisBaseSymbolsReady = null, valueShapes = null }) {
  const app = Object.create(App.prototype);
  const storeState = new Map([
    ['regions', regions],
    ['sliceIndex', sliceIndex],
    ['fileInfo', { slices: [{ name: 'arm64', info: { textVM: 0n, architecture: 'arm64' } }] }],
    ['architecture', 'arm64'],
    ['currentRegion', regions[0] || null],
  ]);
  app.store = { get: (k) => storeState.get(k) };
  app.backend = {
    gen: 1,
    readAt: async (addr, len) => {
      const at = Number(addr);
      if (!mem || !Number.isSafeInteger(at) || at < 0 || at >= mem.length) return { found: false, bytes: null };
      return { found: true, bytes: mem.subarray(at, Math.min(mem.length, at + len)) };
    },
    resolvePointer: (raw) => raw,
    valueShapes: valueShapes || (async () => ({ cancelled: false })),
  };
  app.symbols = EMPTY_INDEX;
  app.analysisBaseSymbolsReady = analysisBaseSymbolsReady;
  app.analysisResumeReady = null;
  app.objcModel = null;
  app.objcRuntime = null;
  app.objcBusy = null;
  app.objcBusyEpoch = -1;
  app.objcBusyState = null;
  app.swiftModel = null;
  app.swiftRuntime = null;
  app.swiftBusy = null;
  app.swiftBusyEpoch = -1;
  app.swiftBusyState = null;
  app.swiftBusyAbort = null;
  app.shapes = null;
  app.shapesBusy = null;
  app.shapesBusyEpoch = -1;
  app.viewer = { setSymbols() {} };
  app.updateChrome = () => {};
  app.persistAnalysisSession = async () => {};
  return app;
}

/* ── Bug 1 [P1]: js/app.js ensureObjc / ensureSwift EMPTY_INDEX & analysisBaseSymbolsReady ── */

test('Bug 1a: ensureObjc guards EMPTY_INDEX and never mutates the shared singleton', async () => {
  const { mem, methodImp } = makeObjcMemory();
  const regions = [
    { id: 'text', section: '__text', vmAddr: 0x2000n, size: 0x1000n, exec: true },
    { id: 'cls', section: '__objc_classlist', vmAddr: 0x200n, size: 8n, exec: false },
  ];
  const app = makeMockApp({ regions, mem });

  const fields = await app.ensureObjc(0, null);
  assert.ok(fields);
  assert.notEqual(app.symbols, EMPTY_INDEX, 'ensureObjc must replace EMPTY_INDEX before mutating');
  assert.equal(app.symbols.nameAt(methodImp), '-[Hero takeDamage:]');
  assert.equal(EMPTY_INDEX.nameAt(methodImp), null, 'EMPTY_INDEX singleton must remain unpolluted');
  assert.equal(EMPTY_INDEX.functionCount, 0, 'EMPTY_INDEX functionCount must remain 0');
});

test('Bug 1b: ensureObjc awaits analysisBaseSymbolsReady so late analyze() does not wipe ObjC names', async () => {
  const { mem, methodImp } = makeObjcMemory();
  const regions = [
    { id: 'text', section: '__text', vmAddr: 0x2000n, size: 0x1000n, exec: true },
    { id: 'cls', section: '__objc_classlist', vmAddr: 0x200n, size: 8n, exec: false },
  ];
  const baseGate = deferred();
  const app = makeMockApp({ regions, mem, analysisBaseSymbolsReady: baseGate.promise });

  let objcFinished = false;
  const objcPromise = app.ensureObjc(0).then((res) => { objcFinished = true; return res; });

  // Allow buildObjcRuntimeModel to finish reading memory while analyze() is still pending.
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(objcFinished, false, 'ensureObjc must wait for analysisBaseSymbolsReady before mutating symbols');
  assert.equal(EMPTY_INDEX.nameAt(methodImp), null, 'EMPTY_INDEX must stay untouched while waiting');

  // Late analyze() finishes and replaces app.symbols with a fresh SymbolIndex.
  const baseAddr = 0x2040n;
  app.symbols = new SymbolIndex({
    addrs: new BigUint64Array([baseAddr]),
    kinds: new Uint8Array([0]),
    flags: new Uint8Array([1]),
    names: ['_base_fn'],
    funcs: new BigUint64Array([baseAddr]),
    regions,
  });
  baseGate.resolve(true);

  await objcPromise;
  assert.equal(app.symbols.nameAt(baseAddr), '_base_fn', 'base symbol from analyze() must be preserved');
  assert.equal(app.symbols.nameAt(methodImp), '-[Hero takeDamage:]', 'ObjC symbol must survive late analyze()');
});

test('Bug 1c: ensureSwift guards EMPTY_INDEX and awaits analysisBaseSymbolsReady', async () => {
  const { mem, secAddr, implAddr } = makeSwiftMemory();
  const regions = [
    { id: 'text', section: '__text', vmAddr: 0x4000n, size: 0x2000n, exec: true },
    { id: 'swift', section: '__swift5_types', vmAddr: secAddr, size: 4n, exec: false },
  ];

  // Case 1: without analysisBaseSymbolsReady, must not pollute EMPTY_INDEX.
  const appNoBase = makeMockApp({ regions, mem });
  const model1 = await appNoBase.ensureSwift(null);
  assert.ok(model1);
  assert.notEqual(appNoBase.symbols, EMPTY_INDEX, 'ensureSwift must replace EMPTY_INDEX before mutating');
  assert.equal(appNoBase.symbols.nameAt(implAddr), 'HeroSwift::method_0');
  assert.equal(EMPTY_INDEX.nameAt(implAddr), null, 'EMPTY_INDEX singleton must remain unpolluted');

  // Case 2: with pending analysisBaseSymbolsReady, must wait so late analyze() does not erase Swift methods.
  const baseGate = deferred();
  const appDelayed = makeMockApp({ regions, mem, analysisBaseSymbolsReady: baseGate.promise });
  let swiftFinished = false;
  const swiftPromise = appDelayed.ensureSwift().then((res) => { swiftFinished = true; return res; });

  await new Promise((r) => setTimeout(r, 20));
  assert.equal(swiftFinished, false, 'ensureSwift must wait for analysisBaseSymbolsReady');

  const baseAddr = 0x4100n;
  appDelayed.symbols = new SymbolIndex({
    addrs: new BigUint64Array([baseAddr]),
    kinds: new Uint8Array([0]),
    flags: new Uint8Array([1]),
    names: ['_swift_base'],
    funcs: new BigUint64Array([baseAddr]),
    regions,
  });
  baseGate.resolve(true);

  await swiftPromise;
  assert.equal(appDelayed.symbols.nameAt(baseAddr), '_swift_base', 'base symbol must remain intact');
  assert.equal(appDelayed.symbols.nameAt(implAddr), 'HeroSwift::method_0', 'Swift method must survive late analyze()');
});

/* ── Bug 2 [P2]: js/app.js ensureShapes option argument crash ── */

test('Bug 2: ensureShapes tolerates omitted, null, empty-object, and non-object options while honoring callbacks', async () => {
  const execRegion = { id: 'text', section: '__text', vmAddr: 0x1000n, size: 0x100n, exec: true };
  const fakeScan = {
    cancelled: false,
    bases: new Uint8Array([]),
    disps: new Int32Array([]),
    ops: new Uint8Array([]),
    addrs: new BigUint64Array([]),
    sizes: new Uint8Array([]),
    counts: new Uint32Array([]),
  };

  for (const arg of [undefined, null, {}, true, 42, 'not-a-fn', []]) {
    let seenProgressArg = 'unset';
    const app = makeMockApp({
      regions: [execRegion],
      mem: null,
      valueShapes: async (_id, progress) => {
        seenProgressArg = progress;
        if (progress) progress({ done: 1, all: 2 });
        return fakeScan;
      },
    });
    const shapes = await app.ensureShapes(arg);
    assert.ok(shapes != null, `ensureShapes(${JSON.stringify(arg)}) must succeed without TypeError`);
    assert.equal(seenProgressArg, null, `non-callable observer (${JSON.stringify(arg)}) must normalize to null`);
  }

  // Function callback
  const directEvents = [];
  const appFn = makeMockApp({
    regions: [execRegion],
    mem: null,
    valueShapes: async (_id, progress) => {
      assert.equal(typeof progress, 'function');
      progress({ done: 3, all: 10 });
      return fakeScan;
    },
  });
  await appFn.ensureShapes((p) => directEvents.push(p));
  assert.deepEqual(directEvents, [{ phase: 'shapes', done: 3, all: 10 }]);

  // Options object with onProgress
  const optionEvents = [];
  const appObj = makeMockApp({
    regions: [execRegion],
    mem: null,
    valueShapes: async (_id, progress) => {
      assert.equal(typeof progress, 'function');
      progress({ done: 5, all: 10 });
      return fakeScan;
    },
  });
  await appObj.ensureShapes({ onProgress: (p) => optionEvents.push(p) });
  assert.deepEqual(optionEvents, [{ phase: 'shapes', done: 5, all: 10 }]);
});

/* ── Bug 3 [P2]: js/report-legacy.js loc.self / indexAddr missing ── */

function modelFromAsm(lines, { base = 0x100000000n } = {}) {
  const rows = lines.map((line, i) => {
    const s = line.trim();
    const p = s.indexOf(' ');
    return {
      row: i,
      address: base + BigInt(i * 4),
      mn: p < 0 ? s : s.slice(0, p),
      ops: p < 0 ? '' : s.slice(p + 1),
    };
  });
  const rowOfAddress = (addr) => {
    const d = addr - base;
    if (d < 0n || d >= BigInt(lines.length * 4)) return null;
    return Number(d / 4n);
  };
  return buildSemanticModel(rows, { startRow: 0, endRow: rows.length - 1, rowOfAddress });
}

test('Bug 3a: report-legacy forwards indexAddr and derives loc.self for ObjC non-fragile ivar offset variables', () => {
  const ivarAddr = 0x100004020n;
  const fields = new FieldIndex({
    classes: [{
      name: 'Player',
      instanceSize: 0x40,
      ivars: [{ name: '_hp', offset: 0x20, size: 4, offsetVar: ivarAddr }],
      properties: [],
      methods: [],
      classMethods: [],
    }],
  });

  // 1) Direct offset-var indexed memory accesses on x0 (self) -> hotLocations
  const hotModel = modelFromAsm([
    'adrp x8, #0x100004000',
    'ldrsw x8, [x8, #0x20]',
    'ldr w9, [x0, x8]',
    'add w9, w9, #1',
    'str w9, [x0, x8]',
    'ret',
  ]);

  // 2) ObjC property helper with ivar offset variable -> updates
  const target = 0x100000100n;
  const base = 0x100000000n;
  const helperLines = [
    'adrp x8, #0x100004000',
    'ldrsw x2, [x8, #0x20]',
    `b #0x${target.toString(16)}`,
  ];
  const helperRows = helperLines.map((line, i) => {
    const idx = line.indexOf(' ');
    return { row: i, address: base + BigInt(i * 4), mn: line.slice(0, idx), ops: line.slice(idx + 1) };
  });
  const helperModel = buildSemanticModel(helperRows, {
    startRow: 0,
    endRow: helperRows.length - 1,
    symbolFor: (a) => (a === target ? '_objc_getProperty' : null),
    rowOfAddress: (a) => {
      const d = a - base;
      return d < 0n || d >= BigInt(helperRows.length * 4) ? null : Number(d / 4n);
    },
  });

  // Verify with owner and also without owner (offsetVar resolves className on its own)
  for (const owner of [{ className: 'Player' }, null]) {
    const hotReport = buildLegacyReport({ model: hotModel, fields, owner });
    assert.ok(hotReport.locations.length >= 1, 'should detect hot location for ivar');
    const loc = hotReport.locations.find((l) => l.indexAddr === ivarAddr);
    assert.ok(loc, 'hot location must carry indexAddr');
    assert.equal(loc.self, true, 'hot location on x0 must derive loc.self === true');
    assert.equal(loc.field?.name, '_hp', 'hot location field must resolve via indexAddr');
    assert.equal(loc.field?.certain, true);
    assert.equal(loc.field?.viaOffsetVar, true);

    const helperReport = buildLegacyReport({ model: helperModel, fields, owner });
    assert.equal(helperReport.updates.length, 1, 'should detect helper ivar update');
    assert.equal(helperReport.updates[0].location.indexAddr, ivarAddr);
    assert.equal(helperReport.updates[0].field?.name, '_hp', 'update field must resolve via indexAddr');
    assert.equal(helperReport.updates[0].field?.certain, true);
    assert.equal(helperReport.updates[0].field?.viaOffsetVar, true);
  }
});

test('Bug 3b: report-legacy derives loc.self for copied self register and preserves heuristic candidate for unproven register', () => {
  const fields = new FieldIndex({
    classes: [{
      name: 'Player',
      instanceSize: 0x40,
      ivars: [{ name: '_hp', offset: 0x20, size: 4 }],
      properties: [],
      methods: [],
      classMethods: [],
    }],
  });

  // Proven self copied into x21
  const provenModel = modelFromAsm([
    'mov x21, x0',
    'ldr w8, [x21, #0x20]',
    'add w8, w8, #1',
    'str w8, [x21, #0x20]',
    'ret',
  ]);
  const provenReport = buildFacadeReport({ model: provenModel, fields, owner: { className: 'Player' } });
  const provenLoc = provenReport.locations.find((l) => l.base === 'x21' && l.disp === 0x20n);
  assert.ok(provenLoc, 'expected hot location for [x21, #0x20]');
  assert.equal(provenLoc.self, true, 'x21 copied from x0 must have loc.self === true');
  assert.equal(provenLoc.field?.name, '_hp', 'proven self hot location must resolve to _hp');
  assert.equal(provenLoc.field?.certain, true);

  // Unproven x19 (not copied from x0): loc.self must be null (not forced false),
  // so legacy resolves an uncertain candidate and report facade moves it to fieldCandidate.
  const heuristicModel = modelFromAsm([
    'ldr w8, [x19, #0x20]',
    'add w8, w8, #1',
    'str w8, [x19, #0x20]',
    'ret',
  ]);
  const legacyHeuristic = buildLegacyReport({ model: heuristicModel, fields, owner: { className: 'Player' } });
  const hLoc = legacyHeuristic.locations.find((l) => l.base === 'x19' && l.disp === 0x20n);
  assert.ok(hLoc);
  assert.equal(hLoc.self, null);
  assert.equal(hLoc.field?.name, '_hp');
  assert.equal(hLoc.field?.certain, false);

  const facadeHeuristic = buildFacadeReport({ model: heuristicModel, fields, owner: { className: 'Player' } });
  const fLoc = facadeHeuristic.locations.find((l) => l.base === 'x19' && l.disp === 0x20n);
  assert.equal(fLoc.field, null, 'facade must strip uncertain field from FACT surface');
  assert.equal(fLoc.fieldCandidate?.name, '_hp', 'facade must preserve heuristic fieldCandidate');
});

/* ── Bug 4 [P2]: js/gemini.js chunk-spanning CRLF (\r\n) corruption ── */

test('Bug 4: streamGemini handles CRLF (\\r\\n) split across arbitrary SSE stream chunk boundaries', async () => {
  const enc = new TextEncoder();
  const sseChunks = [
    // Split \r\n between event line and data line, and split \r\n\r\n event delimiter across chunks
    'event: step.delta\r',
    '\ndata: {"event_type":"step.delta","delta":{"type":"text","text":"Hello"}}\r',
    '\n\r',
    '\nevent: step.delta\r\ndata: {"event_type":"step.delta","delta":{"type":"text","text":" World"}}\r\n\r',
    '\ndata: [DONE]\r',
    '\n\r',
    '\n',
  ];

  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(new ReadableStream({
    start(controller) {
      for (const part of sseChunks) controller.enqueue(enc.encode(part));
      controller.close();
    },
  }), {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });

  try {
    let text = '';
    let doneFlag = false;
    await streamGemini({ question: 'test' }, {
      onText: (chunk) => { text += chunk; },
      onDone: (completed) => { doneFlag = completed; },
    });
    assert.equal(text, 'Hello World');
    assert.equal(doneFlag, true);
  } finally {
    globalThis.fetch = origFetch;
  }
});

/* ── Bug 5 [P2]: js/schema.js negative offset acceptance ── */

test('Bug 5: offsetToColumn and unrolledTablesFromFixed reject negative and non-finite offsets', () => {
  const indexedSchema = {
    best: {
      kind: 'indexed',
      columns: 4,
      columnStride: 4,
      offsetOf(i) { return i >= 0 && i < 4 ? i * 4 : null; },
    },
  };

  assert.equal(offsetToColumn(indexedSchema, 0), 0);
  assert.equal(offsetToColumn(indexedSchema, 4), 1);
  assert.equal(offsetToColumn(indexedSchema, 12), 3);
  assert.equal(offsetToColumn(indexedSchema, 16), null);
  assert.equal(offsetToColumn(indexedSchema, -4), null, 'negative aligned offset must return null');
  assert.equal(offsetToColumn(indexedSchema, -8), null, 'negative aligned offset must return null');
  assert.equal(offsetToColumn(indexedSchema, -1), null, 'negative unaligned offset must return null');
  assert.equal(offsetToColumn(indexedSchema, NaN), null);
  assert.equal(offsetToColumn(indexedSchema, -Infinity), null);
  assert.equal(offsetToColumn(indexedSchema, Infinity), null);

  const unrolledSchema = {
    best: {
      kind: 'unrolled',
      offsets: [-8, -4, 0, 4],
      offsetOf(i) { return i >= 0 && i < 4 ? this.offsets[i] : null; },
    },
  };
  assert.equal(offsetToColumn(unrolledSchema, -8), null, 'unrolled lookup must reject negative offsets');
  assert.equal(offsetToColumn(unrolledSchema, 0), 2);

  const negativeFixed = [
    { row: 1, addr: 0x1004n, base: 19, disp: -16, size: 4, block: 0, loop: null, baseGeneration: 0, fromCall: true, callRow: 0, callAddr: 0x1000n },
    { row: 3, addr: 0x100cn, base: 19, disp: -12, size: 4, block: 0, loop: null, baseGeneration: 0, fromCall: true, callRow: 2, callAddr: 0x1008n },
    { row: 5, addr: 0x1014n, base: 19, disp: -8, size: 4, block: 0, loop: null, baseGeneration: 0, fromCall: true, callRow: 4, callAddr: 0x1010n },
  ];
  assert.deepEqual(unrolledTablesFromFixed(negativeFixed), [], 'unrolledTablesFromFixed must reject negative disp sequences');

  const validFixed = [
    { row: 1, addr: 0x1004n, base: 19, disp: 0, size: 4, block: 0, loop: null, baseGeneration: 0, fromCall: true, callRow: 0, callAddr: 0x1000n },
    { row: 3, addr: 0x100cn, base: 19, disp: 4, size: 4, block: 0, loop: null, baseGeneration: 0, fromCall: true, callRow: 2, callAddr: 0x1008n },
    { row: 5, addr: 0x1014n, base: 19, disp: 8, size: 4, block: 0, loop: null, baseGeneration: 0, fromCall: true, callRow: 4, callAddr: 0x1010n },
  ];
  const tables = unrolledTablesFromFixed(validFixed);
  assert.equal(tables.length, 1);
  assert.deepEqual(tables[0].offsets, [0, 4, 8]);
});
