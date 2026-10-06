import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { SymbolIndex } from '../js/symbols.js';
import { ProgramIndex } from '../js/program.js';
import { AnalysisResumeStore, captureAppAnalysisState, applyAppAnalysisState } from '../js/cache/analysis-resume.js';

function sourceApp() {
  const regions = [{ id:'text', section:'.text', exec:true, vmAddr:0x1000n, size:0x100n }];
  const symbols = new SymbolIndex({
    addrs:new BigUint64Array([0x1000n]), kinds:new Uint8Array([0]), names:['_start'], flags:new Uint8Array([1]),
    funcs:new BigUint64Array([0x1000n, 0x1040n]), funcEnds:new BigUint64Array([0x1030n, 0x1070n]), regions,
    functionStartsComplete:true, allSeedsExact:true,
  });
  symbols.functionDiscovery = { complete:true, attempted:true, reasons:[] };
  symbols.guessed = true;
  symbols.functionTopologyRevision = 3;
  symbols.functionTopologyEnds.set('4096', 0x1020n);
  const programScan = {
    regions, vmAddr:0x1000n,
    callFrom:new BigUint64Array([0x1008n]), callTo:new BigUint64Array([0x1040n]), callCount:1,
    refFrom:new BigUint64Array([0x1010n]), refTo:new BigUint64Array([0x1080n]), refKind:new Uint8Array([1]), refCount:1,
    kinds:new Uint8Array([1, 2]), kindsCovered:2, words:2, callsCapped:false, refsCapped:false,
    completeness:{ complete:true, reasons:[] },
  };
  const shapes = new Map([['target:obj:4', { key:'target:obj:4', offset:4, events:2, amountFrom:new Map(), usedAgainst:new Map(), sites:[] }]]);
  Object.defineProperties(shapes, {
    complete:{ value:true, enumerable:false, configurable:true },
    capped:{ value:false, enumerable:false, configurable:true },
    unsupported:{ value:false, enumerable:false, configurable:true },
    incompleteReason:{ value:null, enumerable:false, configurable:true },
  });
  return {
    symbols, programScan, programKey:'text', program:new ProgramIndex(programScan, symbols, regions[0]), shapes,
    stringIndex:{ items:[{ addr:0x1080n, text:'hello' }], complete:true },
    schemas:[{ id:'schema-1', columns:2 }],
    autoReport:{ report:{ stats:{ functions:2, calls:1 } }, key:'text', gen:symbols.gen, snapshotId:'snap-1' },
    lastGoal:{ id:'save-data' },
    store:{ get:(key) => key === 'regions' ? regions : null },
    notes:{ nameEntries:() => [] }, viewer:{ setSymbols(value){ this.value=value; } }, updateChrome(){ this.updated=true; },
    codeRegion(){ return regions[0]; },
  };
}

function targetApp() {
  const regions = [{ id:'text', section:'.text', exec:true, vmAddr:0x1000n, size:0x100n }];
  return {
    symbols:null, program:null, programScan:null, programKey:null, shapes:null, stringIndex:null, schemas:null, autoReport:null, lastGoal:null,
    store:{ get:(key) => key === 'regions' ? regions : null },
    notes:{ nameEntries:() => [] }, viewer:{ setSymbols(value){ this.value=value; } }, updateChrome(){ this.updated=true; },
    codeRegion(){ return regions[0]; },
  };
}

test('analysis resume snapshot survives structured clone with typed arrays, BigInt and Map evidence', () => {
  const snapshot = captureAppAnalysisState(sourceApp());
  const cloned = structuredClone(snapshot);
  assert.equal(cloned.symbols.funcs[1], 0x1040n);
  assert.equal(cloned.programScan.callTo[0], 0x1040n);
  assert.equal(cloned.shapes.entries[0][1].amountFrom instanceof Map, true);
  assert.equal(cloned.autoReport.report.stats.functions, 2);
});

test('analysis resume rebuilds SymbolIndex, ProgramIndex and shape metadata', () => {
  const snapshot = structuredClone(captureAppAnalysisState(sourceApp()));
  const app = targetApp();
  assert.equal(applyAppAnalysisState(app, snapshot), true);
  assert.equal(app.symbols instanceof SymbolIndex, true);
  assert.equal(app.symbols.functionCount, 2);
  assert.equal(app.symbols.functionTopologyRevision, 3);
  assert.equal(app.program instanceof ProgramIndex, true);
  assert.equal(app.program.calleesOf(0x1000n, 0x1030n)[0].addr, 0x1040n);
  assert.equal(app.shapes instanceof Map, true);
  assert.equal(app.shapes.complete, true);
  assert.equal(app.stringIndex.items[0].text, 'hello');
  assert.equal(app.autoReport.snapshotId, 'snap-1');
});

test('field-scoped checkpoints only replace completed analysis phases', () => {
  const app = sourceApp();
  const checkpoint = captureAppAnalysisState(app, ['shapes', 'lastGoal']);
  assert.equal(Object.hasOwn(checkpoint, 'shapes'), true);
  assert.equal(Object.hasOwn(checkpoint, 'lastGoal'), true);
  assert.equal(Object.hasOwn(checkpoint, 'symbols'), false);
  assert.equal(Object.hasOwn(checkpoint, 'programScan'), false);
});

test('resume store fails soft when IndexedDB is unavailable and app hooks checkpoint each expensive phase', async () => {
  const store = new AnalysisResumeStore({ indexedDB:null });
  assert.equal(await store.load('bin', 0), null);
  assert.equal(await store.save('bin', 0, { shapes:{} }), false);
  const appSource = fs.readFileSync(new URL('../js/app.js', import.meta.url), 'utf8');
  const panelSource = fs.readFileSync(new URL('../js/ui/panels/investigation.js', import.meta.url), 'utf8');
  for (const phase of ["['symbols']", "['symbols', 'programScan', 'programKey']", "['shapes']", "['schemas']", "['strings']"]) {
    assert.equal(appSource.includes(`persistAnalysisSession(${phase})`), true, `missing checkpoint ${phase}`);
  }
  assert.match(appSource, /restoreLastAnalysisFile\(\)/);
  assert.match(appSource, /saveLastFile\(file/);
  assert.match(panelSource, /persistAnalysisSession\?\.\(\['autoReport', 'lastGoal'\]\)/);
});


function createKeyValueIndexedDB() {
  const records = new Map();
  let created = false;
  function request(result, tx = null) {
    const req = { result:undefined, error:null, onsuccess:null, onerror:null };
    queueMicrotask(() => {
      req.result = result;
      req.onsuccess?.();
      if (tx) queueMicrotask(() => tx.oncomplete?.());
    });
    return req;
  }
  const db = {
    objectStoreNames:{ contains:() => created },
    createObjectStore(){ created = true; return {}; },
    close(){},
    transaction(){
      const tx = { error:null, oncomplete:null, onabort:null, onerror:null };
      tx.objectStore = () => ({
        get(key){ return request(records.has(key) ? structuredClone(records.get(key)) : undefined, tx); },
        put(value, key){ records.set(key, structuredClone(value)); return request(key, tx); },
        delete(key){ records.delete(key); return request(undefined, tx); },
        openKeyCursor(){
          const keys = [...records.keys()];
          let index = 0;
          const req = { result:undefined, error:null, onsuccess:null, onerror:null };
          const step = () => queueMicrotask(() => {
            if (index >= keys.length) {
              req.result = null;
              req.onsuccess?.();
              queueMicrotask(() => tx.oncomplete?.());
              return;
            }
            const key = keys[index++];
            req.result = {
              primaryKey:key,
              delete(){ records.delete(key); },
              continue(){ step(); },
            };
            req.onsuccess?.();
          });
          step();
          return req;
        },
      });
      return tx;
    },
  };
  return {
    records,
    open(){
      const req = { result:db, error:null, onupgradeneeded:null, onsuccess:null, onerror:null, onblocked:null };
      queueMicrotask(() => {
        if (!created) req.onupgradeneeded?.();
        req.onsuccess?.();
      });
      return req;
    },
  };
}

test('analysis identity rollover cannot bless stale phase data during the first new save', async () => {
  const indexedDB = createKeyValueIndexedDB();
  const oldStore = new AnalysisResumeStore({ indexedDB, analysisIdentity:'build-old', storage:null });
  await oldStore.save('bin-a', 0, { stringIndex:{ items:[{ text:'stale' }] }, lastGoal:{ id:'old' } });

  const newStore = new AnalysisResumeStore({ indexedDB, analysisIdentity:'build-new', storage:null });
  await newStore.save('bin-a', 0, { lastGoal:{ id:'new' } });
  const restored = await newStore.load('bin-a', 0);
  assert.equal(restored.lastGoal.id, 'new');
  assert.equal(Object.hasOwn(restored, 'stringIndex'), false, 'old-build phase data must not survive a new-build partial checkpoint');
});

test('corrupt compound snapshot is rejected atomically without partially replacing live analysis state', () => {
  const source = sourceApp();
  const snapshot = structuredClone(captureAppAnalysisState(source));
  snapshot.programScan.callFrom = { length:1 };
  const app = targetApp();
  const sentinelSymbols = source.symbols;
  app.symbols = sentinelSymbols;
  app.stringIndex = { items:[{ text:'live' }] };
  assert.equal(applyAppAnalysisState(app, snapshot), false);
  assert.equal(app.symbols, sentinelSymbols);
  assert.equal(app.stringIndex.items[0].text, 'live');
  assert.equal(app.program, null);
});

test('last binary and session survive a fresh store instance and metadata update avoids losing the saved file', async () => {
  const indexedDB = createKeyValueIndexedDB();
  let persistCalls = 0;
  const storage = { persisted:async () => false, persist:async () => { persistCalls++; return true; } };
  const store = new AnalysisResumeStore({ indexedDB, analysisIdentity:'build-a', storage });
  const bytes = new Uint8Array([1, 2, 3, 4]);
  const file = {
    name:'game.bin', type:'application/octet-stream', size:bytes.byteLength, lastModified:123,
    slice(start, end, type){ return new Blob([bytes.slice(start, end)], { type }); },
  };
  assert.equal(await store.saveLastFile(file, { sliceIndex:0 }), true);
  assert.equal(await store.updateLastFileMeta({ binaryId:'hash-a', sliceIndex:0 }), true);
  await store.save('hash-a', 0, { lastGoal:{ id:'resume-me' } });

  const reloaded = new AnalysisResumeStore({ indexedDB, analysisIdentity:'build-a', storage });
  const savedFile = await reloaded.loadLastFile();
  const savedSession = await reloaded.load('hash-a', 0);
  assert.equal(savedFile.name, 'game.bin');
  assert.equal(savedFile.binaryId, 'hash-a');
  assert.equal(savedFile.size, 4);
  assert.equal(savedSession.lastGoal.id, 'resume-me');
  assert.equal(persistCalls, 1);
});

test('app waits for resume completion before starting Swift metadata warmup', () => {
  const appSource = fs.readFileSync(new URL('../js/app.js', import.meta.url), 'utf8');
  assert.match(appSource, /async ensureSwift\(options = \{\}\) \{\s*if \(this\.analysisResumeReady\)/);
  assert.match(appSource, /updateLastFileMeta\(\{ binaryId, sliceIndex \}\)/);
});
