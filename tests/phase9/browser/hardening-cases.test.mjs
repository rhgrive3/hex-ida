import test from 'node:test';
import assert from 'node:assert/strict';
import { runAnalysisBrowserCases } from './hardening-cases.mjs';
test('v3 browser-portable publication and proof cases also run on Node', async () => {
  const cases = await runAnalysisBrowserCases();
  assert.equal(cases.length, 7);
  assert.ok(cases.every(c => c.status === 'PASS' && Number.isFinite(c.milliseconds)));
});
