import assert from 'node:assert/strict';
import { createAppAnalysisQueryAdapter } from '../../js/analysis/query/app-adapter.js';

function makeApp(count, { complete = true, matching = null } = {}) {
  const calls = { nameAt:0, functionAt:0, evidence:0 };
  const funcs = Array.from({ length:count }, (_, i) => 0x1000n + BigInt(i * 4));
  const symbols = {
    funcs,
    functionStartsComplete:complete,
    nameAt(address) {
      calls.nameAt++;
      const index = Number((BigInt(address) - 0x1000n) / 4n);
      return matching?.(index) ? `match_${index}` : `fn_${index}`;
    },
    functionAt(address) {
      calls.functionAt++;
      return { start:BigInt(address), end:BigInt(address) + 4n };
    },
    functionEvidence() { calls.evidence++; return null; },
  };
  return { app:{ symbols }, calls };
}

{
  const { app, calls } = makeApp(100_000);
  const api = createAppAnalysisQueryAdapter(app);
  const result = await api.functions({}, {}, { offset:0, limit:20 });
  assert.equal(result.value.length, 20);
  assert.equal(result.page.total, 100_000);
  assert.equal(result.page.next, 20);
  assert.equal(result.status.completeness, 'complete');
  assert.equal(calls.nameAt, 20, 'unfiltered first page must project only requested rows');
  assert.equal(calls.functionAt, 20);
  assert.equal(calls.evidence, 20);
}

{
  const { app, calls } = makeApp(100_000);
  const api = createAppAnalysisQueryAdapter(app);
  const result = await api.functions({}, {}, { offset:1234, limit:7 });
  assert.equal(result.value.length, 7);
  assert.equal(result.value[0].address, 0x1000n + 1234n * 4n);
  assert.equal(calls.nameAt, 7, 'offset must not force projection of preceding rows');
  assert.equal(calls.functionAt, 7);
}

{
  const { app, calls } = makeApp(100_000, { matching:(i) => i % 10 === 0 });
  const api = createAppAnalysisQueryAdapter(app);
  const result = await api.functions({}, { text:'match_' }, { offset:0, limit:5 });
  assert.equal(result.value.length, 5);
  assert.equal(result.page.total, null, 'early-stopped filtered query must not invent an exact total');
  assert.equal(result.page.next, 5);
  assert.equal(result.status.completeness, 'partial');
  assert.ok(calls.nameAt < 100, `filtered query should stop after page look-ahead, saw ${calls.nameAt}`);
  assert.equal(calls.functionAt, 5, 'non-returned matches must not be materialized');
}

{
  const { app } = makeApp(40, { complete:false });
  const api = createAppAnalysisQueryAdapter(app);
  const result = await api.functions({}, {}, { offset:0, limit:20 });
  assert.equal(result.page.total, null, 'incomplete discovery must not claim an exact total');
  assert.equal(result.status.completeness, 'partial');
  assert.equal(result.status.reason, 'function-discovery-incomplete');
}

console.log('analysis query function pagination: PASS');
