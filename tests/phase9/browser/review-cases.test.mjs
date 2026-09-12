import test from 'node:test';
import assert from 'node:assert/strict';
import { runAnalysisBrowserCases } from './review-cases.mjs';
test('current independent-review browser cases also run through the Node runner',async()=>{
  const cases=await runAnalysisBrowserCases();
  assert.equal(cases.length,12);assert.ok(cases.every(c=>c.status==='PASS'&&Number.isFinite(c.milliseconds)));
});
