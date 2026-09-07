import assert from 'node:assert/strict';
import fs from 'node:fs';
import { Blob } from 'node:buffer';
import { categoryOf, isReturn } from '../js/arm64.js';
import { noteKeyFromBinaryId, findLegacyV3NoteKey } from '../js/names.js';

const src = (path) => fs.readFileSync(new URL('../' + path, import.meta.url), 'utf8');

const app = src('js/app.js');
const applyStart = app.indexOf('  applySlice(sliceIndex, infoArg)');
const applyEnd = app.indexOf('  async ensureObjc(', applyStart);
assert(applyStart >= 0 && applyEnd > applyStart);
assert(!app.slice(applyStart, applyEnd).includes('ensureRecognition('));
assert(!/from ['"]\.\/panels\.js['"]/.test(app));
assert(app.includes("import('./panels.js')"));

const product = src('js/ui/product.js');
assert(!/from ['"]\.\.\/panels\.js['"]/.test(product));
assert(product.includes("import('../panels.js')"));
assert(product.includes('createChildTaskScope(routeSignal)'));
assert(product.includes('app.workspace.loadBaseline(file,{signal})'));
assert(product.includes('app.workspace.diff({signal})'));
assert(product.includes('app.analysisQueries.evidence(snapshot'));

const demand = src('js/analysis/demand-driven-runtime.js');
for (const token of ['scannedRegionIds','unscannedRegionIds',"kind === 'callees' ? []",'truncationReason:relationReason']) assert(demand.includes(token), token);

const panels = src('js/panels-base.js');
const reportStart = panels.indexOf('export function showFunctionReport(app, addr, goal)');
const reportEnd = panels.indexOf('/** Gemini', reportStart);
const reportBody = panels.slice(reportStart, reportEnd);
assert(reportStart >= 0 && reportEnd > reportStart);
assert(!/Promise\.all\(\[\s*analyzeFunctionCached[\s\S]*?app\.ensureProgram\(\)/.test(reportBody));
assert(reportBody.includes('render(null);'));
assert(reportBody.includes('relationship enrichment is optional'));

const backend = src('js/backend.js');
const openStart = backend.indexOf('  async open(file)');
const openEnd = backend.indexOf('  probe()', openStart);
const openBody = backend.slice(openStart, openEnd);
assert(openStart >= 0 && openEnd > openStart);
assert(!openBody.includes("_callTo('platform', 'detect'"));
assert.equal((openBody.match(/_callTo\('platform', 'open'/g) || []).length, 1);

const file = new Blob([new Uint8Array(32)]);
Object.defineProperty(file, 'name', { value:'fixture.bin' });
const info = { slices:[{ offset:0n, size:32n, info:{ uuid:'u', cpu:'arm64', cpuSub:'0', architecture:'arm64' }, capability:{ architecture:'arm64' } }] };
const a = noteKeyFromBinaryId(file, info, 0, 'binary:sha256:aaa');
const b = noteKeyFromBinaryId(file, info, 0, 'binary:sha256:bbb');
assert.notEqual(a, b);
const legacy = 'v3|32|u|arm64|0|0|32|sha256tree:v1:legacy-digest';
const keys = [`hex.notes.${legacy}`, `hex.notes.${legacy}.delta.0001`];
assert.equal(findLegacyV3NoteKey(file, info, 0, { length:keys.length, key:(i)=>keys[i] ?? null }), legacy);

assert.equal(categoryOf('eretaa'), 'system');
assert.equal(categoryOf('eretab'), 'system');
assert.equal(isReturn('eretaa'), false);
assert.equal(isReturn('eretab'), false);
assert.equal(isReturn('retaa'), true);
assert.equal(isReturn('retab'), true);

console.log('open-issues-analysis-wiring-20260830: PASS');
