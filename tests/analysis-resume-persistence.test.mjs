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
