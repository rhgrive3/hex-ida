import assert from 'node:assert/strict';
import fs from 'node:fs';
import { queryStrings } from '../js/ui/explorer-index.js';
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
const callGraph = between(tools, 'async function buildQueryCallGraph', 'export async function showDebugger');
assert.match(callGraph, /const visited = new Set\(\)/);
assert.match(callGraph, /const next = new Map\(\)/);
assert.match(callGraph, /api\.callers\([^\n]+\{ signal \}\)/);
assert.match(callGraph, /api\.callees\([^\n]+\{ signal \}\)/);
assert.match(callGraph, /drawController\?\.abort\('call-graph-depth-changed'\)/);
assert.match(callGraph, /onClose:\(\) =>/);

// #2514: capability/query path must not probe by analyzing the function first.
const types = between(tools, 'export async function showTypes', 'export async function showStructRecover');
const struct = between(tools, 'export async function showStructRecover', 'async function buildQueryCallGraph');
assert.doesNotMatch(types, /analyzeFunctionAt/);
assert.match(types, /api\.types/);
assert.doesNotMatch(struct, /analyzeFunctionAt/);
assert.match(struct, /analysisQueries/);

// #2526: first 200 matches do not force a full 60k normalization pass.
let conversions = 0;
const rows = Array.from({ length: 60_000 }, (_, i) => ({
  addr: BigInt(i),
  text: { toString() { conversions++; return i < 200 ? `needle-${i}` : `other-${i}`; } },
}));
const matched = await queryStrings(rows, 'needle', { limit:200 });
assert.equal(matched.length, 200);
assert.ok(conversions <= 256, `expected incremental normalization, converted ${conversions} rows`);
const afterFirst = conversions;
await queryStrings(rows, 'needle-1', { limit:20 });
assert.ok(conversions - afterFirst < 256, 'compatible query must reuse normalized prefix');

// #2533: Function Summary owns one base function query and derives projections locally.
const summaryBundle = between(functionPanel, 'async function analysisBundle', 'async function functionPage');
assert.equal((summaryBundle.match(/api\.function\(/g) || []).length, 1);
assert.doesNotMatch(summaryBundle, /api\.decompile\(/);
assert.doesNotMatch(summaryBundle, /api\.cfg\(/);
between(functionPanel, 'export function showFunctionSummary', '\n}');
assert.match(functionPanel, /function-summary-closed/);
assert.match(functionPanel, /controller\.signal\.aborted/);

// #2539: main toolbar string surface is explicitly overridden and budgeted.
assert.match(panels, /showStrings, showXrefs/);
const stringPanel = between(navigation, 'export function showStrings', '/** Canonical xref sheet');
assert.match(stringPanel, /ensureStrings/);
assert.match(stringPanel, /queryStrings/);
assert.doesNotMatch(stringPanel, /backend\.strings/);
assert.match(stringPanel, /strings-sheet-closed/);

// #2542: xrefs sheet routes through AnalysisQueryAPI and reports completeness.
const xrefPanel = navigation.slice(navigation.indexOf('export function showXrefs'));
assert.match(xrefPanel, /api\.xrefs/);
assert.doesNotMatch(xrefPanel, /backend\.xrefs/);
assert.match(xrefPanel, /completeness/);
assert.match(xrefPanel, /goToAddress\(site/);

// #2544: known-function model lookup no longer gates on whole-slice discovery.
const modelOf = between(toolBase, 'async function modelOf', 'function rowMapper');
assert.doesNotMatch(modelOf, /ensureFunctions/);
assert.match(modelOf, /executableRegionFor/);
assert.match(modelOf, /analyzeFunctionAt/);

// #2548: base imports/dylibs paint before optional ProgramIndex enrichment.
const linkage = between(toolBase, 'export async function showLinkage', 'グローバル変数');
const firstPaint = linkage.indexOf('views.imports();');
const programEnrichment = linkage.indexOf('app.ensureProgram');
assert.ok(firstPaint >= 0 && programEnrichment > firstPaint, 'base linkage facts must render before ProgramIndex');
assert.match(linkage, /usageComplete = false/);
assert.match(linkage, /linkage-sheet-closed/);

// #2551: Emulator.run observes AbortSignal and the Tools sheet owns run lifecycle.
assert.match(emuSource, /async run\(maxSteps = 20000, onProgress, options = \{\}\)/);
assert.match(emuSource, /awaitAbortable\(this\.io\.fetch/);
assert.match(emuSource, /throwIfAborted\(signal\)/);
const debuggerUi = toolBase.slice(toolBase.indexOf('export function showDebugger'));
assert.match(debuggerUi, /debugger-sheet-closed/);
assert.match(debuggerUi, /emu\.run\(50000[\s\S]*signal:controller\.signal/);

// Runtime cancellation proof: stop at first progress quantum, not 50k steps.
const controller = new AbortController();
const emu = new Emulator({ fetch: async () => ({ mn:'nop', ops:'' }) });
emu.setup(0x1000n, []);
let aborted = false;
try {
  await emu.run(50_000, (n) => { if (n >= 500) controller.abort('test-cancel'); }, { signal:controller.signal });
} catch (error) {
  aborted = error?.name === 'AbortError';
}
assert.equal(aborted, true);
assert.equal(emu.steps, 500);
assert.equal(emu.stopped, null, 'consumer cancellation must not become a semantic stopped reason');

// #2555: unresolved chained/authenticated slots remain visible but non-navigable.
const vtable = between(toolBase, 'async function showVtable', '外とのつながり');
assert.match(vtable, /pointerResolutionContextFor/);
assert.match(vtable, /if \(s\.addr == null\)/);
assert.match(vtable, /解決できないポインタ/);
assert.match(vtable, /disabled:true/);

console.log('issues #2511/#2514/#2526/#2533/#2539/#2542/#2544/#2548/#2551/#2555 regressions passed');
