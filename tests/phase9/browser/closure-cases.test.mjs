import test from 'node:test';
import assert from 'node:assert/strict';
import { runClosureBrowserCases } from './closure-cases.mjs';
test('browser-portable scalar, machine taint and finite-memory proof use the public production APIs',async()=>{
  const results=await runClosureBrowserCases();assert.equal(results.length,4);
  assert.ok(results.every(row=>row.status==='PASS'&&Number.isFinite(row.milliseconds)));
});
