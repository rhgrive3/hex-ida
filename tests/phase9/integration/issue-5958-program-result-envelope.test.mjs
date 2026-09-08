import assert from 'node:assert/strict';
import test from 'node:test';

import { createAgentTools } from '../../../js/agent/tools.js';

const address = 0x1000n;

test('structured caller rows preserve upstream status and local pagination', async () => {
  const rows = [{ addr: 0x2000n }, { addr: 0x3000n }];
  const tools = createAgentTools({ program: {
    callersOf() { return { results: rows, complete: true, total: rows.length }; },
  } });

  const first = await tools.get_callers(address, { limit: 1, offset: 0 });
  assert.deepEqual(first.results.map((row) => row.addr), [0x2000n]);
  assert.equal(first.returned, 1);
  assert.equal(first.total, 2);
  assert.equal(first.complete, false, 'a local page cannot claim the known total');
  assert.equal(first.truncated, true);
  assert.equal(first.reason, 'result-limit');

  const second = await tools.get_callers(address, { limit: 1, offset: 1 });
  assert.deepEqual(second.results.map((row) => row.addr), [0x3000n]);
  assert.equal(second.total, 2);
  assert.equal(second.complete, true);
  assert.equal(second.truncated, false);
  assert.equal(second.reason, null);
});

test('callers, callees, and xrefs retain structured rows and incompleteness', async () => {
  const tools = createAgentTools({ program: {
    functionRange() { return { start: address, end: address + 0x100n }; },
    callersOf() {
      return { results: [{ addr: 0x2100n }], complete: false, total: 1, reason: 'caller-budget' };
    },
    calleesOf() {
      return { results: [{ addr: 0x3100n }], completeness: { complete: false, reason: 'callee-budget' } };
    },
    refSitesTo() {
      return { results: [{ from: 0x4100n, to: address }], complete: false, reason: 'xref-budget' };
    },
    functionsReferencing() {
      return [{ addr: 0x5100n }];
    },
  } });

  const callers = await tools.get_callers(address);
  assert.deepEqual(callers.results.map((row) => row.addr), [0x2100n]);
  assert.equal(callers.complete, false);
  assert.equal(callers.truncated, true);
  assert.equal(callers.total, null, 'incomplete upstream totals remain unknown');
  assert.equal(callers.reason, 'caller-budget');

  const callees = await tools.get_callees(address);
  assert.deepEqual(callees.results.map((row) => row.addr), [0x3100n]);
  assert.equal(callees.complete, false);
  assert.equal(callees.total, null);
  assert.equal(callees.reason, 'callee-budget');

  const xrefs = await tools.get_xrefs(address);
  assert.deepEqual(xrefs.sites, [{ from: 0x4100n, to: address }]);
  assert.deepEqual(xrefs.functions, [{ addr: 0x5100n }]);
  assert.equal(xrefs.complete, false);
  assert.equal(xrefs.truncated, true);
  assert.equal(xrefs.totals.sites, null);
  assert.equal(xrefs.totals.functions, 1);
  assert.equal(xrefs.reason, 'xref-budget');
});

for (const metadata of [
  { truncated: true, reason: 'source-truncated' },
  { queryLimited: true, reason: 'query-limited' },
  { capped: true, reason: 'source-capped' },
]) {
  test(`callers preserve ${Object.keys(metadata)[0]} as incomplete`, async () => {
    const tools = createAgentTools({ program: {
      callersOf() { return { results: [{ addr: 0x2200n }], ...metadata }; },
    } });
    const result = await tools.get_callers(address);
    assert.deepEqual(result.results.map((row) => row.addr), [0x2200n]);
    assert.equal(result.complete, false);
    assert.equal(result.truncated, true);
    assert.equal(result.total, null);
    assert.equal(result.reason, metadata.reason);
  });
}

test('plain arrays and valid empty structured results retain their semantics', async () => {
  let mode = 'array';
  const tools = createAgentTools({ program: {
    callersOf() {
      if (mode === 'empty') return { results: [], complete: true, total: 0 };
      return [{ addr: 0x2300n }, { addr: 0x2400n }];
    },
  } });

  const arrayResult = await tools.get_callers(address);
  assert.deepEqual(arrayResult.results.map((row) => row.addr), [0x2300n, 0x2400n]);
  assert.equal(arrayResult.complete, true);
  assert.equal(arrayResult.total, 2);

  const arrayPage = await tools.get_callers(address, { limit: 1, offset: 1 });
  assert.deepEqual(arrayPage.results.map((row) => row.addr), [0x2400n]);
  assert.equal(arrayPage.complete, true);
  assert.equal(arrayPage.total, 2);

  mode = 'empty';
  const emptyResult = await tools.get_callers(address);
  assert.deepEqual(emptyResult.results, []);
  assert.equal(emptyResult.complete, true);
  assert.equal(emptyResult.truncated, false);
  assert.equal(emptyResult.total, 0);
  assert.equal(emptyResult.reason, null);
});

test('an object without a results array fails closed', async () => {
  const tools = createAgentTools({ program: {
    callersOf() { return { complete: true }; },
  } });
  const result = await tools.get_callers(address);
  assert.deepEqual(result.results, []);
  assert.equal(result.complete, false);
  assert.equal(result.truncated, true);
  assert.equal(result.total, null);
  assert.equal(result.reason, 'invalid-program-result-envelope');
});

test('a non-array primitive result fails closed', async () => {
  const tools = createAgentTools({ program: {
    callersOf() { return 'not-a-program-result'; },
  } });
  const result = await tools.get_callers(address);
  assert.deepEqual(result.results, []);
  assert.equal(result.complete, false);
  assert.equal(result.truncated, true);
  assert.equal(result.total, null);
  assert.equal(result.reason, 'invalid-program-result-envelope');
});

test('an unavailable query capability remains unsupported and incomplete', async () => {
  const result = await createAgentTools({ program: {} }).get_callers(address);
  assert.equal(result.supported, false);
  assert.deepEqual(result.results, []);
  assert.equal(result.complete, false);
  assert.equal(result.truncated, true);
  assert.equal(result.total, null);
  assert.equal(result.reason, 'unsupported-program-query');
});
