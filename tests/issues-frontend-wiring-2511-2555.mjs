import assert from 'node:assert/strict';
import fs from 'node:fs';
import { queryStrings, stringQueryIndexStats } from '../js/ui/explorer-index.js';
import { buildQueryCallGraph, functionAnalysisUiRoute } from '../js/tools.js';
import { analysisBundle } from '../js/ui/panels/function-analysis.js';
import { modelOf } from '../js/tools-base.js';
import { Emulator } from '../js/emu.js';

const read = (path) => fs.readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const between = (text, start, end) => {
  const a = text.indexOf(start);
  assert.notEqual(a, -1, `missing start marker: ${start}`);
  const b = text.indexOf(end, a + start.length);
  assert.notEqual(b, -1, `missing end marker: ${end}`);
  return text.slice(a, b);
};

const tools = read('js/tools.js');
const toolBase = read('js/tools-base.js');
const navigation = read('js/ui/panels/navigation.js');
const functionPanel = read('js/ui/panels/function-analysis.js');
const panels = read('js/panels.js');
const emuSource = read('js/emu.js');

// #2511: one query per address/direction and active draw cancellation.
const callGraph = between(tools, 'export async function buildQueryCallGraph', 'export async function showDebugger');
assert.match(callGraph, /const visited = new Set\(\)/);
assert.match(callGraph, /const next = new Map\(\)/);
assert.match(callGraph, /api\.callers\([^\n]+\{ signal \}\)/);
assert.match(callGraph, /api\.callees\([^\n]+\{ signal \}\)/);
assert.match(callGraph, /drawController\?\.abort\('call-graph-depth-changed'\)/);
assert.match(callGraph, /onClose:\(\) =>/);

function fakeGraphApp(calleeMap, callerMap = new Map()) {
  const counts = { callers:new Map(), callees:new Map() };
  const resultFor = (kind, current, map) => {
    const key = current.toString();
    counts[kind].set(key, (counts[kind].get(key) || 0) + 1);
    return { value:(map.get(key) || []).map((addr) => ({ addr })), completeness:'complete' };
  };
  return {
    counts,
    symbols:{ nameAt:(addr) => `f_${addr}` },
    analysisQueries:{
      snapshot:async () => ({ snapshotId:'s1' }),
      callers:async (_s, current) => resultFor('callers', current, callerMap),
      callees:async (_s, current) => resultFor('callees', current, calleeMap),
    },
  };
}
const diamond = fakeGraphApp(new Map([
  ['1', [2n, 3n]], ['2', [4n]], ['3', [4n]], ['4', [5n]],
]));
await buildQueryCallGraph(diamond, 1n, 3);
assert.equal(diamond.counts.callees.get('4'), 1, 'diamond join must be queried once');
assert.ok([...diamond.counts.callees.values()].every((n) => n === 1), 'same direction/address must be queried at most once');
const cycle = fakeGraphApp(new Map([['1', [2n]], ['2', [1n]]]));
await buildQueryCallGraph(cycle, 1n, 3);
assert.equal(cycle.counts.callees.get('1'), 1);
assert.equal(cycle.counts.callees.get('2'), 1);

// #2514: capability routing must not probe by analyzing the function first, and ARM64 legacy stays intact.
const types = between(tools, 'export async function showTypes', 'export async function showStructRecover');
const struct = between(tools, 'export async function showStructRecover', 'export async function buildQueryCallGraph');
assert.doesNotMatch(types, /analyzeFunctionAt/);
assert.match(types, /api\.types/);
assert.doesNotMatch(struct, /analyzeFunctionAt/);
assert.match(struct, /functionAnalysisUiRoute/);
const routeApp = (architecture, semantic = true) => ({
  store:{ get:(key) => key === 'architecture' ? architecture : null },
  backend:semantic ? { analyzeSemanticFunction() {} } : {},
  analysisQueries:{},
});
assert.equal(functionAnalysisUiRoute(routeApp('arm64')).route, 'legacy');
assert.equal(functionAnalysisUiRoute(routeApp('aarch64')).route, 'legacy');
assert.equal(functionAnalysisUiRoute(routeApp('x86_64')).route, 'canonical');
assert.equal(functionAnalysisUiRoute(routeApp('riscv64')).route, 'canonical');
assert.equal(functionAnalysisUiRoute(routeApp('x86_64', false)).route, 'unsupported');
assert.equal(functionAnalysisUiRoute(routeApp('mips64')).route, 'unsupported');

// #2526: first 200 matches do not force all 60k normalization; memory is measured; aborted work resumes.
let conversions = 0;
const rows = Array.from({ length:60_000 }, (_, i) => ({
  addr:BigInt(i),
  text:{ toString() { conversions++; return i < 200 ? `needle-${i}` : `other-${i}`; } },
}));
const matched = await queryStrings(rows, 'needle', { limit:200 });
assert.equal(matched.length, 200);
assert.ok(conversions <= 256, `expected incremental normalization, converted ${conversions} rows`);
assert.equal(matched.queryIndexStats.normalizedRows, 200);
assert.ok(matched.queryIndexStats.estimatedHeapBytes > 0);
const afterFirst = conversions;
await queryStrings(rows, 'needle-1', { limit:20 });
assert.ok(conversions - afterFirst < 256, 'compatible query must reuse normalized prefix');

let abortConversions = 0;
const abortController = new AbortController();
const abortRows = Array.from({ length:60_000 }, (_, i) => ({
  addr:BigInt(i),
  text:{ toString() {
    abortConversions++;
    if (abortConversions === 64) abortController.abort('typing-replaced');
    return i < 200 ? `needle-${i}` : `other-${i}`;
  } },
}));
await assert.rejects(queryStrings(abortRows, 'needle', { signal:abortController.signal, limit:200 }), (error) => error?.name === 'AbortError');
const partialStats = stringQueryIndexStats(abortRows);
assert.ok(partialStats.normalizedRows >= 64 && partialStats.normalizedRows < 100);
const resumed = await queryStrings(abortRows, 'needle', { limit:200 });
assert.equal(resumed.length, 200);
assert.ok(abortConversions <= 210, `resume must continue compatible index instead of restarting; conversions=${abortConversions}`);

// #2533: Function Summary requests one base artifact and derives projections from it.
const summaryBundle = between(functionPanel, 'export async function analysisBundle', 'async function functionPage');
assert.equal((summaryBundle.match(/api\.function\(/g) || []).length, 1);
assert.doesNotMatch(summaryBundle, /api\.decompile\(/);
assert.doesNotMatch(summaryBundle, /api\.cfg\(/);
let functionQueries = 0;
const summaryApp = {
  symbols:{ nameAt:() => 'f' },
  analysisQueries:{
    snapshot:async () => ({ snapshotId:'summary' }),
    function:async () => {
      functionQueries++;
      return { value:{ startAddress:0x1000n, decompiler:{ text:'return;' }, pipeline:{ cfg:{ blocks:[] } } }, completeness:'complete', status:{ completeness:'complete' } };
    },
    decompile:async () => { throw new Error('must not be called'); },
    cfg:async () => { throw new Error('must not be called'); },
  },
};
const summary = await analysisBundle(summaryApp, 0x1000n);
assert.equal(functionQueries, 1);
assert.equal(summary.decompile.value.text, 'return;');
assert.deepEqual(summary.cfg.value, { blocks:[] });
assert.match(functionPanel, /function-summary-closed/);
assert.match(functionPanel, /controller\.signal\.aborted/);

// #2539: main Toolbar Strings uses shared budgeted StringCollection/index and detaches stale consumers.
assert.match(panels, /showStrings, showXrefs/);
const stringPanel = between(navigation, 'export function showStrings', '/** Canonical xref sheet');
assert.match(stringPanel, /ensureStrings/);
assert.match(stringPanel, /queryStrings/);
assert.doesNotMatch(stringPanel, /backend\.strings/);
assert.match(stringPanel, /strings-sheet-closed/);
assert.match(stringPanel, /renderSerial/);

// #2542: xrefs sheet routes through AnalysisQueryAPI and reports completeness/address identity.
const xrefPanel = navigation.slice(navigation.indexOf('export function showXrefs'));
assert.match(xrefPanel, /api\.xrefs/);
assert.doesNotMatch(xrefPanel, /backend\.xrefs/);
assert.match(xrefPanel, /completeness/);
assert.match(xrefPanel, /goToAddress\(site/);
assert.match(xrefPanel, /xrefs-sheet-closed/);

// #2544: known function is local-only; unknown target may discover only its owning region.
const modelSource = between(toolBase, 'export async function modelOf', 'function rowMapper');
assert.doesNotMatch(modelSource, /ensureFunctions/);
assert.match(modelSource, /executableRegionFor/);
assert.match(modelSource, /guessFunctions\(owner\.id/);
const regionA = { id:'A', exec:true, vmAddr:0x1000n, size:0x1000n };
const regionB = { id:'B', exec:true, vmAddr:0x5000n, size:0x1000n };
let selectedRegion = null;
let guessedRegions = [];
let analyzed = [];
const knownApp = {
  store:{ get:() => regionA },
  executableRegionFor:() => regionB,
  selectRegion:(region) => { selectedRegion = region; },
  symbols:{ functionAt:() => ({ start:0x5100n }), isFunctionStart:() => true, functionCount:1 },
  backend:{ guessFunctions:async (id) => { guessedRegions.push(id); return { starts:[] }; } },
  analyzeFunctionAt:async (addr) => { analyzed.push(addr); return { addr }; },
};
await modelOf(knownApp, 0x5100n);
assert.deepEqual(guessedRegions, []);
assert.equal(selectedRegion, regionB);
assert.deepEqual(analyzed, [0x5100n]);
let discoveredStart = null;
const unknownApp = {
  ...knownApp,
  symbols:{
    functionCount:0,
    functionAt:() => discoveredStart == null ? null : ({ start:discoveredStart }),
    isFunctionStart:() => false,
    addFunctions:(starts) => { discoveredStart = BigInt(starts[0]); },
  },
  backend:{ guessFunctions:async (id) => { guessedRegions.push(id); return { starts:[0x5200n] }; } },
  analyzeFunctionAt:async (addr) => ({ addr }),
};
guessedRegions = [];
await modelOf(unknownApp, 0x5200n);
assert.deepEqual(guessedRegions, ['B']);

// #2548: base imports/dylibs paint before optional ProgramIndex enrichment.
const linkage = between(toolBase, 'export async function showLinkage', 'グローバル変数');
const firstPaint = linkage.indexOf('views.imports();');
const programEnrichment = linkage.indexOf('app.ensureProgram');
assert.ok(firstPaint >= 0 && programEnrichment > firstPaint);
assert.match(linkage, /usageComplete = false/);
assert.match(linkage, /linkage-sheet-closed/);
assert.match(linkage, /usageComplete && i\.calls/);

// #2551: Emulator.run observes AbortSignal and the Tools sheet owns run lifecycle.
assert.match(emuSource, /async run\(maxSteps = 20000, onProgress, options = \{\}\)/);
assert.match(emuSource, /awaitAbortable\(this\.io\.fetch/);
assert.match(emuSource, /throwIfAborted\(signal\)/);
const debuggerUi = toolBase.slice(toolBase.indexOf('export function showDebugger'));
assert.match(debuggerUi, /debugger-sheet-closed/);
assert.match(debuggerUi, /emu\.run\(50000[\s\S]*signal:controller\.signal/);
const controller = new AbortController();
const emu = new Emulator({ fetch:async () => ({ mn:'nop', ops:'' }) });
emu.setup(0x1000n, []);
let aborted = false;
try {
  await emu.run(50_000, (n) => { if (n >= 500) controller.abort('test-cancel'); }, { signal:controller.signal });
} catch (error) { aborted = error?.name === 'AbortError'; }
assert.equal(aborted, true);
assert.equal(emu.steps, 500);
assert.equal(emu.stopped, null);

// #2555: unresolved chained/authenticated slots remain visible but non-navigable.
const vtable = between(toolBase, 'async function showVtable', '外とのつながり');
assert.match(vtable, /pointerResolutionContextFor/);
assert.match(vtable, /if \(s\.addr == null\)/);
assert.match(vtable, /解決できないポインタ/);
assert.match(vtable, /disabled:true/);

console.log('issues #2511/#2514/#2526/#2533/#2539/#2542/#2544/#2548/#2551/#2555 regressions passed');
