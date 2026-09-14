import assert from 'node:assert/strict';
import fs from 'node:fs';

const script = fs.readFileSync(new URL('../js/script.js', import.meta.url), 'utf8');
const tools = fs.readFileSync(new URL('../js/tools-base.js', import.meta.url), 'utf8');
const sandbox = fs.readFileSync(new URL('../js/sandbox.js', import.meta.url), 'utf8');

for (const token of [
  'async queryFunctions(',
  'async queryXrefsTo(',
  'async queryXrefsFrom(',
  'async queryMostCalled(',
  'app.analysisQueries.snapshot({signal})',
  'app.analysisQueries.xrefs(',
  'app.analysisQueries.callees(',
  'investigationServiceFor(app).buildProgram({signal})',
  'truncationReason',
  'scannedRegionIds',
  'unscannedRegionIds',
  'awaitRequest(',
]) assert(script.includes(token), token);

assert(tools.includes("controller.abort('script-sheet-closed')"));
assert(tools.includes('runScript(ta.value, app, write, { signal:controller.signal })'));
assert(sandbox.includes('fn(...(m.args || []), { signal: runController.signal })'));

console.log('open-issues-script-wiring-20260830: PASS');
