import test from 'node:test';
import assert from 'node:assert/strict';
import { runAnalysisBrowserCases } from './analysis-cases.mjs';
test('browser-portable production analysis cases also pass on Node',async()=>{
 const results=await runAnalysisBrowserCases();assert.equal(results.length,4);
 assert.ok(results.every(r=>r.status==='PASS' && Number.isFinite(r.milliseconds)));
});
